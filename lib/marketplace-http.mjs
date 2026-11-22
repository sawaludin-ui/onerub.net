import { Interface, parseUnits, keccak256 } from "ethers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fundingReadinessContract } from "./marketplace-action-contract.mjs";
import {
  MarketplaceError,
  withChain,
  address,
  capabilities,
  deployment,
  fail,
  getTask,
  hash,
  issueChallenge,
  encryptArtifact,
  decryptArtifact,
  limitations,
  listTasks,
  marketplaceInterface,
  sanitizeMetadata,
  store,
  taskId,
  verifyAuthorization,
} from "./marketplace-core.mjs";
import {
  deliverArtifact,
  enrichTask,
  evaluateTask,
  getArtifactReceipt,
  prepareWinner,
  registerMetadata,
  uploadArtifact,
  verifyDecision,
  validatedArtifact,
  retainArtifact,
} from "./marketplace-service.mjs";
import { DEFAULT_POLICY, MIN_REVIEW_SECONDS, MIN_SETTLEMENT_SECONDS, normalizePolicy, policyHash } from './marketplace-policy.mjs';
import { evaluatorSigner, signUploadReceipt, signReviewDecision } from './marketplace-attestation.mjs';
import { agentProfile, observation } from './marketplace-observation.mjs';
import { createProviderQueue } from './marketplace-provider-queue.mjs';
const token = { address: deployment.token, symbol: "USDC", decimals: 18 };
const json = (body, status = 200, extraHeaders = {}) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
export async function readBody(req) {
  if (
    !req.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    fail("Use application/json.", 415);
  const max = 760000;
  if (Number(req.headers.get("content-length")) > max)
    fail("Request exceeds 760000 bytes.", 413);
  const reader = req.body?.getReader();
  if (!reader) fail("JSON body required.");
  let size = 0,
    chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        fail("Request body too large.", 413);
      }
      chunks.push(value);
    }
    const body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!body || typeof body !== "object" || Array.isArray(body))
      fail("JSON object required.");
    return body;
  } catch (e) {
    if (e instanceof MarketplaceError) throw e;
    fail("Invalid JSON body.");
  } finally {
    reader.releaseLock();
  }
}
export async function handle(fn) {
  try {
    const result = await fn();
    const retry = result?.status === "cooldown" && result.outcome === "pending" &&
      Number.isInteger(result.retryAfterSeconds) && result.retryAfterSeconds >= 1 && result.retryAfterSeconds <= 86400
      ? result.retryAfterSeconds : undefined;
    return json(result, 200, retry === undefined ? {} : { "Retry-After": String(retry) });
  } catch (e) {
    if (e instanceof MarketplaceError) {
      const retryAfterSeconds = ['EVALUATOR_RATE_LIMIT', 'EVALUATOR_COOLDOWN'].includes(e.code) && Number.isInteger(e.retryAfterSeconds) &&
        e.retryAfterSeconds >= 0 && e.retryAfterSeconds <= 86400 ? e.retryAfterSeconds : undefined;
      const details = Object.fromEntries(['field', 'expected', 'received'].filter(k => typeof e[k] === 'string' && e[k].length <= 200).map(k => [k, e[k]]));
      const funding = ['HEALTH_ACK_REQUIRED', 'FUNDING_UNAVAILABLE'].includes(e.code) ? { readiness: e.readiness, ...(e.healthAcknowledgement ? { healthAcknowledgement: e.healthAcknowledgement, acknowledgementField: 'healthAcknowledgement' } : {}) } : {};
      return json({ error: e.message, code: e.code, error_code: e.code, retryable: e.status === 503 || e.status === 429, ...details, ...funding, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
        e.status, retryAfterSeconds === undefined ? {} : { 'Retry-After': String(retryAfterSeconds) });
    }
    return json(
      {
        error: "Marketplace request failed. Please retry.",
        code: "SERVICE_UNAVAILABLE",
        error_code: "SERVICE_UNAVAILABLE",
        retryable: true,
      },
      503,
    );
  }
}
export function assertDeploymentIdentity(input = {}) {
  const chainId = input.chainId;
  if ((chainId !== undefined && String(chainId) !== String(deployment.chainId)) ||
      [input.escrowAddress, input.contract].some(escrow => escrow !== undefined && (typeof escrow !== 'string' || escrow.toLowerCase() !== deployment.address.toLowerCase())))
    fail('This marketplace deployment is not active. Use the exact chain and escrow identity.', 409, 'DEPLOYMENT_MISMATCH');
}
function requestIdentity(req) {
  if (!req) return;
  const params = new URL(req.url).searchParams;
  if (['chainId', 'escrowAddress', 'contract'].some(key => params.getAll(key).length > 1)) fail('Duplicate deployment selector.');
  assertDeploymentIdentity(Object.fromEntries(params));
}
export async function publicList(req) {
  requestIdentity(req);
  const u = new URL(req.url);
  const rawOffset = u.searchParams.get("offset") || "0",
    rawLimit = u.searchParams.get("limit") || "24";
  if (!/^\d{1,7}$/.test(rawOffset) || !/^\d{1,2}$/.test(rawLimit))
    fail("Invalid pagination.");
  const offset = Number(rawOffset),
    limit = Number(rawLimit);
  if (limit < 1 || limit > 48) fail("limit must be 1–48.");
  const q = u.searchParams.get('q') || '', phase = u.searchParams.get('phase') || 'All';
  if (q.length > 200 || !['All','Open','Review','Settled','Refunded','Cancelled','Expired'].includes(phase)) fail('Invalid search or phase.');
  const rawBlock = u.searchParams.get('block');
  if (rawBlock !== null && !/^\d{1,12}$/.test(rawBlock)) fail('Invalid snapshot block.');
  const result = await listTasks({ offset, limit, q, phase, block: rawBlock === null ? undefined : Number(rawBlock) });
  result.tasks = await Promise.all(
    result.tasks.map((t) =>
      enrichTask(t).catch(() => ({
        ...t,
        metadata: null,
        metadataVerified: false,
        metadataCanonical: null,
        metadataHash: null,
        amountUnavailable: t.status !== 1,
      })),
    ),
  );
  return {
    chainId: deployment.chainId,
    contract: deployment.address,
    activeDeployment: deployment,
    newTasksEnabled: deployment.newTasksEnabled,
    token,
    feeBps: 1000,
    ...result,
    capabilities: capabilities(),
    limitations,
    defaultPolicy: deployment.newTasksEnabled ? DEFAULT_POLICY : null,
    escrowVersion: deployment.version || 1,
  };
}
export async function publicTask(id, req, { storage = store, readTask = getTask, observe = observation } = {}) {
  requestIdentity(req);
  const task = await enrichTask(await readTask(id), storage);
  return {
    chainId: deployment.chainId,
    contract: deployment.address,
    activeDeployment: deployment,
    newTasksEnabled: deployment.newTasksEnabled,
    token,
    task: { ...task, ...await observe(task) },
    capabilities: capabilities(),
    limitations,
  };
}
export async function challenge(req, { storage = store, config = capabilities() } = {}) {
  if (!config.authentication)
    fail(
      "Agent authentication storage is not configured.",
      503,
      "AUTH_UNAVAILABLE",
    );
  const body = await readBody(req);
  assertDeploymentIdentity(body);
  await storage.limit(
    "challenge:" +
      hash(req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown"),
    60,
    60,
  );
  return issueChallenge(body);
}
// Candidate plaintext digests, the decision MAC and its digest stay server-side.
// A caller receives only what is needed to show progress, the outcome and the
// on-chain-relevant commitments; the signed record is verified before use.
function publicEvaluation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { attestation, decisionHash, authVersion, authKeyId, commitments, ...rest } = value;
  if (!Array.isArray(commitments)) return rest;
  return {
    ...rest,
    commitments: commitments.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const { plaintextHash, ...visible } = entry;
      return visible;
    }),
  };
}
export async function privateAction(req, id, action, { storage = store, readTask = getTask, eligible, config = capabilities() } = {}) {
  id = taskId(id);
  if (!config.privateStorage)
    fail("Private storage is not configured.", 503, "STORAGE_UNAVAILABLE");
  const body = await readBody(req);
  assertDeploymentIdentity(body);
  const { auth, payload } = body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw Object.assign(new MarketplaceError('Signed payload object is required.', 400, action === 'metadata' ? 'METADATA_PAYLOAD_REQUIRED' : 'INVALID_REQUEST'), { field: 'payload', expected: 'object', received: payload === null ? 'null' : typeof payload });
  const who = await verifyAuthorization(auth, action, id, payload, { storage, ...(eligible ? { eligible } : {}), consume: action !== "metadata" });
  await storage.limit("action:" + who.toLowerCase(), 60, 60);
  if (action === "receipt") return getArtifactReceipt(id, who);
  if (action === "metadata") return registerMetadata(id, who, payload, { storage, readTask, commit: record => storage.commitMetadata(id, record, auth) });
  if (action === "upload") return uploadArtifact(id, who, payload);
  if (action === "evaluate") return publicEvaluation(await evaluateTask(id, who));
  if (action === "delivery") return deliverArtifact(id, who);
  fail("Unsupported action.");
}
export async function fundingPreflight(p, { readHealth = readiness, config = capabilities(), now = Math.floor(Date.now() / 1000) } = {}) {
  const health = await readHealth();
  const checks = fundingReadinessContract(health.checks);
  const summary = { status: health.status === 'healthy' && Object.values(checks).every(c => ['available', 'not-required'].includes(c.status)) ? 'healthy' : 'degraded', checks };
  if (!config.authentication || !config.privateStorage || !config.evaluator ||
      ['rpc', 'storage', 'encryption', 'attestation'].some(k => !['available', 'not-required'].includes(checks[k]?.status)))
    throw Object.assign(new MarketplaceError('Funding unavailable: required authentication, storage, encryption, RPC or signer/evaluator configuration is unavailable.', 503, 'FUNDING_UNAVAILABLE'), { readiness: summary });
  const { healthAcknowledgement: ack, ...request } = p;
  const sign = expiresAt => createHmac('sha256', process.env.MARKETPLACE_AUTH_SECRET).update(hash({ purpose: 'funding-readiness-v1', chainId: deployment.chainId, escrow: deployment.address, request, checks, expiresAt })).digest('hex');
  const valid = ack?.accepted === true && Number.isSafeInteger(ack.expiresAt) && ack.expiresAt >= now && ack.expiresAt <= now + 120 &&
    typeof ack.token === 'string' && /^[a-f0-9]{64}$/.test(ack.token) && timingSafeEqual(Buffer.from(ack.token, 'hex'), Buffer.from(sign(ack.expiresAt), 'hex'));
  if (summary.status !== 'healthy' && !valid) {
    const expiresAt = now + 120;
    const unknown = Object.entries(checks).filter(([, c]) => !['available', 'not-required'].includes(c.status)).map(([k, c]) => k + ':' + c.status).join(', ');
    throw Object.assign(new MarketplaceError('Explicit acknowledgement required for current funding readiness: ' + unknown + '. No paid provider, upload or delivery success has been verified.', 409, 'HEALTH_ACK_REQUIRED'), { readiness: summary, healthAcknowledgement: { token: sign(expiresAt), expiresAt } });
  }
  return { ...summary, acknowledged: valid, directContractCallsNotBlocked: true };
}
export async function prepare(req, { storage = store, readHealth = readiness, config = capabilities() } = {}) {
  const p = await readBody(req);
  assertDeploymentIdentity(p);
  const action = p.action;
  if (["approve", "createAndFund"].includes(action) && !deployment.newTasksEnabled)
    fail("New hosted approvals and funding are disabled until a verified receipt-gated V2 deployment is active. Existing V1 tasks remain discoverable and may settle or refund.", 409, "ESCROW_UPGRADE_REQUIRED");
  const fundingReadiness = ["approve", "createAndFund"].includes(action) ? await fundingPreflight(p, { readHealth, config }) : undefined;
  let to = deployment.address,
    args,
    method;
  if (action === "createAndFund") {
    const metadata = sanitizeMetadata(p.metadata, { field: "metadata" });
    let bounty;
    try {
      bounty = parseUnits(String(p.amount), 18);
    } catch {
      fail("Invalid USDC amount.");
    }
    if (bounty < 10n || bounty >= 2n ** 256n) fail("Bounty is too small or outside uint256.");
    const now = Math.floor(Date.now() / 1000);
    if (
      !Number.isSafeInteger(p.submissionDeadline) ||
      p.submissionDeadline <= now + 120 ||
      !Number.isSafeInteger(p.reviewDeadline) ||
      p.reviewDeadline < p.submissionDeadline + MIN_REVIEW_SECONDS
    )
      fail("Submission must remain open for more than two minutes; review requires at least one hour.");
    const policy = normalizePolicy(p.policy);
    const committedPolicy = policyHash(policy);
    if (p.policyHash && p.policyHash.toLowerCase() !== committedPolicy.toLowerCase()) fail('policyHash does not match the readable policy.');
    await storage.put('policy:' + committedPolicy.toLowerCase(), { policy }, { nx: true });
    method = "createAndFund";
    args = [
      deployment.token,
      bounty,
      hash(metadata),
      p.submissionDeadline,
      p.reviewDeadline,
      committedPolicy,
    ];
  } else if (action === "approve") {
    let amount;
    try {
      amount = parseUnits(String(p.amount), 18);
    } catch {
      fail("Invalid amount.");
    }
    if (amount <= 0n || amount >= 2n ** 256n) fail("Amount must be positive and fit uint256.");
    return {
      chainId: deployment.chainId,
      activeDeployment: deployment,
      escrowVersion: deployment.version,
      fundingReadiness,
      to: deployment.token,
      value: "0",
      data: new Interface([
        "function approve(address,uint256)",
      ]).encodeFunctionData("approve", [deployment.address, amount]),
      warning:
        "Unsigned exact-amount approval. Confirm token, spender, amount, and gas in the wallet.",
    };
  } else {
    const id = taskId(p.taskId);
    const t = await getTask(id);
    if (action === "submitCommitment") {
      address(p.worker);
      const record = await store.get(
        `artifact:${id}:${p.worker.toLowerCase()}`,
      );
      if (!record) fail("Upload the private artifact first.", 409);
      if (t.phase !== "Open") fail("Submissions are closed.", 409);
      method = action;
      if (deployment.version < 2) {
        const retained = await retainArtifact(t, p.worker);
        validatedArtifact(retained, id, p.worker, { exists: true, contentHash: record.contentHash, artifactPtrHash: record.artifactPtrHash });
      }
      const receipt = deployment.version >= 2 ? await signUploadReceipt(t, p.worker) : null;
      args = receipt ? [id, receipt.contentHash, receipt.artifactPtrHash, receipt.size, receipt.expiresAt, receipt.signature] : [id, record.contentHash, record.artifactPtrHash];
    } else if (action === "selectWinner") {
      if (t.phase !== "Review") fail("Task is not in review.", 409);
      const decision = await prepareWinner(id);
      method = action;
      const receipt = deployment.version >= 2 ? await signReviewDecision(t, decision) : null;
      args = receipt ? [id, decision.winner, receipt.expiresAt, receipt.signature] : [id, decision.winner];
    } else if (action === 'rejectAll' && deployment.version >= 2) {
      if (t.phase !== 'Review' || t.reviewDeadline - Math.floor(Date.now() / 1000) < MIN_SETTLEMENT_SECONDS) fail('Review window is unavailable or too close to expiry.', 409, 'REVIEW_WINDOW_TOO_SHORT');
      const decision = await store.get('decision:' + id);
      if (!decision) fail('Complete evaluation first.', 409, 'EVALUATION_REQUIRED');
      verifyDecision(decision, t);
      if (decision.outcome !== 'no_acceptable_submission') fail('The evaluator has not rejected all submissions.', 409);
      const receipt = await signReviewDecision(t, decision);
      method = 'rejectAll'; args = [id, receipt.expiresAt, receipt.signature];
    } else if (["cancel", "refund"].includes(action)) {
      method = action;
      args = [id];
    } else fail("Unsupported transaction action.");
  }
  return {
    chainId: deployment.chainId,
    activeDeployment: deployment,
    escrowVersion: deployment.version,
    to,
    value: "0",
    data: marketplaceInterface.encodeFunctionData(method, args),
    action: method,
    ...(fundingReadiness ? { fundingReadiness } : {}),
    ...(method === 'createAndFund' ? { policy: normalizePolicy(p.policy), policyHash: policyHash(p.policy), criteriaHash: hash(sanitizeMetadata(p.metadata, { field: "metadata" })) } : {}),
    warning:
      "Unsigned wallet transaction only. The wallet must preview and authorize it; this API never signs wallet transactions or broadcasts. V2 includes a host-signed evaluator receipt, not a wallet signature.",
  };
}

export async function publicPolicy(digest) {
  if (!/^0x[\da-f]{64}$/i.test(digest)) fail('Invalid policy hash.');
  const record = await store.get('policy:' + digest.toLowerCase());
  if (!record || policyHash(record.policy).toLowerCase() !== digest.toLowerCase()) fail('Policy not found or integrity check failed.', 404, 'POLICY_UNAVAILABLE');
  return { policy: record.policy, policyHash: digest.toLowerCase(), verified: true };
}

export async function publicProfile(req, who) {
  who = address(who);
  const u = new URL(req.url), rawBlock = u.searchParams.get('block'), rawOffset = u.searchParams.get('offset') || '0';
  if ((rawBlock !== null && !/^\d{1,12}$/.test(rawBlock)) || !/^\d{1,7}$/.test(rawOffset)) fail('Invalid profile pagination.');
  const result = await agentProfile(who, { block: rawBlock === null ? undefined : Number(rawBlock), offset: Number(rawOffset) });
  result.history = await Promise.all(result.history.map(async t => ({ ...await enrichTask(t), ...await observation(t) })));
  return result;
}

export async function publicConfig() {
  return { activeDeployment: deployment, chainId: deployment.chainId, contract: deployment.address,
    escrowVersion: deployment.version, token, newTasksEnabled: deployment.newTasksEnabled,
    defaultPolicy: deployment.newTasksEnabled ? DEFAULT_POLICY : null,
    capabilities: { ...capabilities(), basis: 'configuration-only-not-live-health' }, limitations };
}
export async function liveDeploymentState() {
  return withChain(async (contract, provider, block) => {
    const [code, registry, treasury, owner, tokenAllowed, feeBps] = await Promise.all([
      provider.getCode(deployment.address, block), contract.agentId({ blockTag: block }),
      contract.treasury({ blockTag: block }), contract.owner({ blockTag: block }),
      contract.allowedToken(deployment.token, { blockTag: block }), contract.FEE_BPS({ blockTag: block })]);
    if (code === '0x' || registry.toLowerCase() !== deployment.registry.toLowerCase() || !tokenAllowed || String(feeBps) !== '1000' ||
        (deployment.version >= 2 && keccak256(code) !== deployment.runtimeCodeHash)) throw Error('Deployment state mismatch');
    let evaluator, evaluatorRevoked;
    if (deployment.version >= 2) {
      const [revision, minimum] = await Promise.all([contract.PROTOCOL_REVISION({ blockTag: block }), contract.MIN_VALID_SUBMISSIONS({ blockTag: block })]);
      if (String(revision) !== '3' || String(minimum) !== '1') throw Error('Protocol revision mismatch');
      evaluator = await contract.evaluator({ blockTag: block });
      evaluatorRevoked = await contract.revokedEvaluator(evaluator, { blockTag: block });
    }
    return { readBlock: block, owner, treasury, registry, ...(evaluator ? { evaluator, evaluatorRevoked } : {}) };
  });
}
export async function probeReadiness({ storage = store, readChain = liveDeploymentState, config = capabilities(),
    checkEncryption = () => { const bytes = Buffer.from('onerub-readiness'); return decryptArtifact(encryptArtifact(bytes, 'readiness'), 'readiness').equals(bytes); },
    checkSigner = evaluatorSigner, active = deployment, checkDispatch = () => createProviderQueue({ storage }).inspect() } = {}) {
  const checks = { rpc: { status: 'unavailable' }, storage: { status: 'unavailable' }, encryption: { status: 'unavailable' },
    attestation: { status: active.version >= 2 ? 'unavailable' : 'not-required' },
    evaluator: { status: config.evaluator ? 'unknown' : 'unavailable', basis: 'provider-not-probed' },
    uploads: { status: 'unknown', basis: 'no-artifact-write-probe' }, delivery: { status: 'unknown', basis: 'requires-task-specific-preflight' } };
  let live;
  await Promise.all([
    (async () => { try { live = await readChain(); checks.rpc = { status: 'available', readBlock: live.readBlock }; } catch { /* Never export provider errors. */ } })(),
    (async () => { try { if (await storage.command('PING') === 'PONG') checks.storage = { status: 'available', basis: 'ping-only' }; } catch { /* Bounded status only. */ } })(),
    (async () => { try { if (await checkEncryption()) checks.encryption = { status: 'available', basis: 'local-roundtrip' }; } catch { /* No key/version metadata. */ } })(),
  ]);
  if (config.evaluator) {
    try {
      const dispatch = await checkDispatch();
      if (dispatch?.cooldown === true && Number.isSafeInteger(dispatch.retryAfterSeconds) && dispatch.retryAfterSeconds > 0 && dispatch.retryAfterSeconds <= 86400 && Number.isSafeInteger(dispatch.retryAt)) {
        checks.evaluator = { status: "cooldown", basis: "shared-dispatch-state-not-provider-health", retryAfterSeconds: dispatch.retryAfterSeconds, retryAt: dispatch.retryAt };
      }
    } catch { /* An open/unknown dispatch gate is never proof of model availability. */ }
  }
  if (active.version >= 2 && live?.evaluator && live.evaluatorRevoked === false) {
    try { checkSigner({ ...active, evaluator: live.evaluator }, { evaluatorSigner: live.evaluator, evaluatorRevoked: live.evaluatorRevoked }); checks.attestation = { status: 'available', basis: 'matches-live-default-new-tasks-only' }; } catch { /* Fail closed. */ }
  }
  return { status: 'degraded', checkedAt: new Date().toISOString(), activeDeployment: active,
    escrowVersion: active.version, readBlock: live?.readBlock || null, checks,
    ...(live ? { privileges: Object.fromEntries(['owner', 'treasury', 'registry', 'evaluator'].filter(k => live[k]).map(k => [k, live[k]])) } : {}),
    scope: 'Read-only dependency probes. Provider evaluation, uploads, task signer liveness and paid delivery require task-specific verification; configuration is not live success.' };
}
let healthCache, healthPending;
export async function readiness() {
  if (healthCache && Date.now() - healthCache.at < 15000) return healthCache.value;
  if (!healthPending) healthPending = probeReadiness().then(value => { healthCache = { at: Date.now(), value }; return value; }).finally(() => { healthPending = null; });
  return healthPending;
}
