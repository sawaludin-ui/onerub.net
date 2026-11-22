import { getVercelOidcTokenSync } from '@vercel/oidc';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  Contract,
  FetchRequest,
  Interface,
  JsonRpcProvider,
  ZeroAddress,
  getAddress,
  isAddress,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import { ACTIVE_MARKETPLACE_DEPLOYMENT as deployment, MARKETPLACE_ABI as abi, marketplaceTaskIdentity } from "./marketplace-deployment-resolver.mjs";

import { createTaskListCache, readTaskListPage, ListIndexError } from "./marketplace-list-cache.mjs";

export { deployment, abi };
export const marketplaceInterface = new Interface(abi);
export const PHASES = [
  "None",
  "Open",
  "Review",
  "Settled",
  "Refunded",
  "Cancelled",
  "Expired",
];
export class MarketplaceError extends Error {
  constructor(message, status = 400, code = "INVALID_REQUEST") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const fail = (message, status = 400, code) => {
  throw new MarketplaceError(message, status, code);
};
export const canonical = (value) =>
  JSON.stringify(
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map((v) => JSON.parse(canonical(v)))
        : Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, JSON.parse(canonical(value[k]))]),
          )
      : value,
  );
export const hash = (value) =>
  keccak256(toUtf8Bytes(typeof value === "string" ? value : canonical(value)));
export function taskId(value) {
  if (!/^\d{1,16}$/.test(String(value)) || BigInt(value) < 1n)
    fail("Invalid task ID.");
  return String(BigInt(value));
}
export function address(value) {
  if (!isAddress(value) || value.toLowerCase() === ZeroAddress)
    fail("Invalid wallet address.");
  return getAddress(value);
}
export const storePrefix = `onerub:marketplace:${deployment.chainId}:${deployment.address.toLowerCase()}:`;
const prefix = storePrefix;
function currentOidcToken() {
  try { return getVercelOidcTokenSync(); } catch { return undefined; }
}

export function evaluatorConfig() {
  return {
    url:
      process.env.MARKETPLACE_EVALUATOR_URL ||
      "https://ai-gateway.vercel.sh/v1/chat/completions",
    key:
      process.env.MARKETPLACE_EVALUATOR_KEY ||
      process.env.AI_GATEWAY_API_KEY ||
      currentOidcToken(),
    model:
      process.env.MARKETPLACE_EVALUATOR_MODEL || "google/gemini-2.5-flash-lite",
  };
}
export function capabilities() {
  const privateStorage = Boolean(
    (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
    (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN) &&
    encryptionKey(false) &&
    process.env.MARKETPLACE_AUTH_SECRET?.length >= 32,
  );
  return {
    privateStorage,
    authentication: privateStorage,
    evaluator:
      privateStorage &&
      process.env.MARKETPLACE_EVALUATOR_ENABLED === "true" &&
      Boolean(evaluatorConfig().key),
    unsignedTransactions: true,
    newTasksEnabled: deployment.newTasksEnabled,
  };
}
export class RedisStore {
  async command(...args) {
    const url =
      process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token =
      process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token)
      fail("Private storage is not configured.", 503, "STORAGE_UNAVAILABLE");
    let result;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
      if (!r.ok) throw Error();
      result = await r.json();
      if (result.error) throw Error();
    } catch {
      fail(
        "Private storage is temporarily unavailable.",
        503,
        "STORAGE_UNAVAILABLE",
      );
    }
    return result.result;
  }
  async limit(key, max, seconds) {
    const count = await this.command(
      "EVAL",
      "local v=redis.call('INCR',KEYS[1]); if v==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return v",
      "1",
      prefix + "rate:" + key,
      String(seconds),
    );
    if (Number(count) > max)
      fail("Request limit reached. Retry later.", 429, "RATE_LIMIT");
  }
  async get(key) {
    const s = await this.command("GET", prefix + key);
    return s ? JSON.parse(s) : null;
  }
  async put(key, value, { nx = false, ttl } = {}) {
    const args = ["SET", prefix + key, JSON.stringify(value)];
    if (nx) args.push("NX");
    if (ttl) args.push("EX", String(ttl));
    return (await this.command(...args)) === "OK";
  }
  async release(key, owner) {
    return Number(await this.command('EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", '1', prefix + key, JSON.stringify(owner))) === 1;
  }
  async expireIfValue(key, owner, ttl) {
    return Number(await this.command('EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],ARGV[2]) end return 0", '1', prefix + key, JSON.stringify(owner), String(ttl))) === 1;
  }
  async retain(key, ttl) {
    if (!Number.isSafeInteger(ttl) || ttl < 1) fail('Invalid retention period.');
    return Number(await this.command('EVAL', "local t=redis.call('TTL',KEYS[1]); if t==-2 then return 0 end; if t>=0 and t<tonumber(ARGV[1]) then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return 1", '1', prefix + key, String(ttl))) === 1;
  }
  async putArtifact(key, record, { id, worker, maxParticipants, maxTotalBytes, ttl = 86400 }) {
    id = taskId(id); worker = address(worker).toLowerCase();
    if (key !== artifactKey(id, worker) || ![record.size, maxParticipants, maxTotalBytes, ttl].every(v => Number.isSafeInteger(v) && v > 0)) fail('Invalid artifact admission.');
    const script = "local prior=redis.call('HGET',KEYS[2],ARGV[1]); local total=tonumber(redis.call('GET',KEYS[3]) or '0'); if prior and tonumber(prior)~=tonumber(ARGV[2]) then return -3 end; if redis.call('EXISTS',KEYS[1])==1 then return 0 end; if not prior and redis.call('HLEN',KEYS[2])>=tonumber(ARGV[3]) then return -1 end; if not prior and total+tonumber(ARGV[2])>tonumber(ARGV[4]) then return -2 end; redis.call('SET',KEYS[1],ARGV[6],'EX',ARGV[5]); if not prior then redis.call('HSET',KEYS[2],ARGV[1],ARGV[2]); redis.call('INCRBY',KEYS[3],ARGV[2]) end; for i=2,3 do local t=redis.call('TTL',KEYS[i]); if t==-1 or t<tonumber(ARGV[5]) then redis.call('EXPIRE',KEYS[i],ARGV[5]) end end; return 1";
    const result = Number(await this.command('EVAL', script, '3', prefix + key, prefix + 'admission:' + id, prefix + 'admission-bytes:' + id, worker, String(record.size), String(maxParticipants), String(maxTotalBytes), String(ttl), JSON.stringify(record)));
    if (result < 0) fail(result === -1 ? 'Task participant capacity is full.' : 'Task artifact capacity is full or reservation differs.', 409, 'ADMISSION_LIMIT');
    return result === 1;
  }
  async admitArtifact(id, worker, bytes, { maxParticipants, maxTotalBytes, ttl = 86400 }) {
    const result = Number(await this.command('EVAL', "local prior=redis.call('HGET',KEYS[1],ARGV[1]); if prior then if tonumber(prior)==tonumber(ARGV[2]) then return 1 else return -3 end end; local count=redis.call('HLEN',KEYS[1]); local total=tonumber(redis.call('GET',KEYS[2]) or '0'); if count>=tonumber(ARGV[3]) then return -1 end; if total+tonumber(ARGV[2])>tonumber(ARGV[4]) then return -2 end; redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]); redis.call('INCRBY',KEYS[2],ARGV[2]); for i=1,2 do local t=redis.call('TTL',KEYS[i]); if t==-1 or t<tonumber(ARGV[5]) then redis.call('EXPIRE',KEYS[i],ARGV[5]) end end; return 1", '2', prefix + 'admission:' + taskId(id), prefix + 'admission-bytes:' + taskId(id), worker.toLowerCase(), String(bytes), String(maxParticipants), String(maxTotalBytes), String(ttl)));
    if (result !== 1) fail(result === -1 ? 'Task participant capacity is full.' : 'Task artifact capacity is full or reservation differs.', 409, 'ADMISSION_LIMIT');
    return true;
  }
}
export const store = new RedisStore();
function encryptionKey(required = true, version) {
  const active = process.env.MARKETPLACE_ENCRYPTION_KEY_VERSION || 'legacy';
  let ring = {};
  try { ring = JSON.parse(process.env.MARKETPLACE_ENCRYPTION_KEYRING || '{}'); } catch { /* Fail closed below. */ }
  const raw = version ? (ring[version] || (version === active || version === 'legacy' ? process.env.MARKETPLACE_ENCRYPTION_KEY : undefined)) : (ring[active] || process.env.MARKETPLACE_ENCRYPTION_KEY);
  const key = raw ? Buffer.from(raw, "base64") : null;
  if (key?.length !== 32) {
    if (required)
      fail("Private encryption is not configured.", 503, "STORAGE_UNAVAILABLE");
    return null;
  }
  return key;
}
export function encryptArtifact(bytes, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    keyVersion: process.env.MARKETPLACE_ENCRYPTION_KEY_VERSION || 'legacy',
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
export function decryptArtifact(value, aad) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(true, value.keyVersion || 'legacy'),
    Buffer.from(value.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]);
}
const secret = () => {
  if (
    process.env.MARKETPLACE_AUTH_SECRET?.length < 32 ||
    !process.env.MARKETPLACE_AUTH_SECRET
  )
    fail("Agent authentication is not configured.", 503, "AUTH_UNAVAILABLE");
  return process.env.MARKETPLACE_AUTH_SECRET;
};
const mac = (text) => createHmac("sha256", secret()).update(text).digest("hex");
export function authMessage(a) {
  return [
    "ONERUB Marketplace authorization",
    "Origin: https://onerub.net",
    `Chain ID: ${deployment.chainId}`,
    `Contract: ${deployment.address}`,
    `Address: ${a.address}`,
    `Action: ${a.action}`,
    `Task: ${a.taskId || "-"}`,
    `Payload hash: ${a.payloadHash}`,
    `Nonce: ${a.nonce}`,
    `Expires: ${a.expiresAt}`,
  ].join("\n");
}
export function issueChallenge({
  address: who,
  action,
  taskId: id,
  payloadHash,
}) {
  who = address(who);
  if (
    !["metadata", "upload", "receipt", "evaluate", "delivery"].includes(action)
  )
    fail("Unsupported authorization action.");
  if (!/^0x[\da-f]{64}$/i.test(payloadHash || ""))
    fail("A payload hash is required.");
  const challenge = {
    address: who,
    action,
    taskId: taskId(id),
    payloadHash,
    nonce: "0x" + randomBytes(32).toString("hex"),
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  };
  return {
    ...challenge,
    challenge: mac(canonical(challenge)),
    typedData: authorizationTypedData(challenge),
  };
}
export async function verifyAuthorization(
  auth,
  action,
  id,
  payload,
  {
    storage = store,
    eligible = isEligible,
    now = Math.floor(Date.now() / 1000),
  } = {},
) {
  if (!auth || typeof auth !== "object")
    fail("Signed agent authorization required.", 401, "AUTH_REQUIRED");
  const c = {
    address: address(auth.address),
    action: auth.action,
    taskId: auth.taskId,
    payloadHash: auth.payloadHash,
    nonce: auth.nonce,
    expiresAt: auth.expiresAt,
  };
  if (
    c.action !== action ||
    c.taskId !== taskId(id) ||
    c.payloadHash !== hash(payload) ||
    !/^0x[\da-f]{64}$/.test(c.nonce) ||
    !Number.isSafeInteger(c.expiresAt) ||
    c.expiresAt < now ||
    c.expiresAt > now + 300
  )
    fail(
      "Authorization is expired or does not match this request.",
      401,
      "INVALID_AUTH",
    );
  if (
    typeof auth.challenge !== "string" ||
    !/^([\da-f]{64})$/i.test(auth.challenge) ||
    typeof auth.signature !== "string" ||
    !/^0x[\da-f]{128,132}$/i.test(auth.signature)
  )
    fail("Invalid authorization encoding.", 401, "INVALID_AUTH");
  const expected = Buffer.from(mac(canonical(c)), "hex");
  const received = Buffer.from(auth.challenge || "", "hex");
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    fail("Invalid server challenge.", 401, "INVALID_AUTH");
  let signer;
  try {
    const typed = authorizationTypedData(c);
    signer = verifyTypedData(
      typed.domain,
      { Authorization: typed.types.Authorization },
      typed.message,
      auth.signature,
    );
  } catch {
    fail("Invalid agent signature.", 401, "INVALID_SIGNATURE");
  }
  if (signer.toLowerCase() !== c.address.toLowerCase())
    fail("Signature address mismatch.", 401, "INVALID_SIGNATURE");
  if (storage.limit)
    await storage.limit("signed:" + c.address.toLowerCase(), 90, 60);
  if (!(await eligible(c.address)))
    fail("A Binance Agent ID is required.", 403, "AGENT_ID_REQUIRED");
  if (!(await storage.put("nonce:" + c.nonce, true, { nx: true, ttl: 600 })))
    fail("Authorization was already used.", 409, "REPLAY");
  return c.address;
}
export async function withChain(fn, { confirmations = 0, block: requestedBlock } = {}) {
  let last;
  for (const url of [
    ...new Set(
      [
        process.env.BSC_RPC_URL,
        "https://bsc-dataseed.bnbchain.org",
        "https://bsc-rpc.publicnode.com",
      ].filter(Boolean),
    ),
  ]) {
    const req = new FetchRequest(url);
    req.timeout = 7000;
    const p = new JsonRpcProvider(req, deployment.chainId, { staticNetwork: true });
    try {
      if (Number(BigInt(await p.send("eth_chainId", []))) !== deployment.chainId) throw new Error("RPC chain mismatch");
      const head = await p.getBlockNumber();
      if (requestedBlock !== undefined && (!Number.isSafeInteger(Number(requestedBlock)) || Number(requestedBlock) < deployment.blockNumber || Number(requestedBlock) > head))
        fail('Invalid snapshot block.', 400, 'INVALID_SNAPSHOT');
      const block = requestedBlock === undefined ? Math.max(0, head - confirmations) : Number(requestedBlock);
      return await fn(new Contract(deployment.address, abi, p), p, block);
    } catch (e) {
      if (e instanceof MarketplaceError && ["INDEX_BUILDING", "INDEX_CAPACITY"].includes(e.code)) throw e;
      last = e;
    } finally {
      p.destroy();
    }
  }
  if (last instanceof MarketplaceError) throw last;
  fail(
    "Live BNB Chain data is temporarily unavailable.",
    503,
    "RPC_UNAVAILABLE",
  );
}
export async function isEligible(who) {
  return withChain(async (c, p, block) => {
    const registry = new Contract(
      deployment.registry,
      ["function balanceOf(address) view returns(uint256)"],
      p,
    );
    return (await registry.balanceOf(who, { blockTag: block })) > 0n;
  });
}
export function taskView(id, t, phase) {
  const bounty = t.bounty,
    fee = (bounty * 1000n) / 10000n;
  return {
    id: String(id),
    identity: marketplaceTaskIdentity(id),
    escrowVersion: deployment.version,
    requester: t.requester,
    token: t.token,
    tokenInfo: tokenInfo(t.token),
    bounty: String(bounty),
    fee: String(fee),
    payout: String(bounty - fee),
    criteriaHash: t.criteriaHash,
    policyHash: t.policyHash,
    phase: PHASES[Number(phase)],
    submissionDeadline: Number(t.submissionDeadline),
    reviewDeadline: Number(t.reviewDeadline),
    submissionCount: Number(t.submissionCount),
    winner: t.winner,
    status: Number(t.status),
    ...(t.candidatesHash ? { candidatesHash: t.candidatesHash } : {}),
    ...(t.evaluatorSigner ? { evaluatorSigner: t.evaluatorSigner } : {}),
    ...(t.feeRecipient ? { feeRecipient: t.feeRecipient } : {}),
  };
}
export function tokenInfo(token) {
  const supported = token.toLowerCase() === deployment.token.toLowerCase();
  return { address: token, symbol: supported ? 'USDC' : null, decimals: supported ? 18 : null, supported };
}
export async function getTask(id, { confirmations = 0, block: snapshotBlock } = {}) {
  id = taskId(id);
  return withChain(
    async (c, p, block) => {
      const [t, phase] = await Promise.all([
        c.getTask(id, { blockTag: block }),
        c.phaseOf(id, { blockTag: block }),
      ]);
      if (Number(t.status) === 0) fail("Task not found.", 404, "NOT_FOUND");
      const evaluatorRevoked = deployment.version >= 2 ? await c.revokedEvaluator(t.evaluatorSigner, { blockTag: block }) : undefined;
      return { ...taskView(id, t, phase), ...(evaluatorRevoked === undefined ? {} : { evaluatorRevoked }), readBlock: block };
    },
    { confirmations, block: snapshotBlock },
  );
}
const taskListCache = createTaskListCache({ storage: {
  get: key => store.get(key),
  put: (key, value, options) => store.put(key, value, options),
  release: (key, owner) => store.release(key, owner),
  putIfLease: async (key, value, { leaseKey, owner, ttl }) => Number(await store.command('EVAL',
    "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[3]); return 1",
    '2', storePrefix + leaseKey, storePrefix + key, JSON.stringify(owner), JSON.stringify(value), String(ttl))) === 1,
} });
export async function listTasks({ offset = 0, limit = 12, block: snapshotBlock, q = '', phase = 'All' } = {}) {
  return withChain(async (c, p, block) => {
    if (snapshotBlock === undefined && (q || phase !== 'All'))
      block = await taskListCache.recentBlock(storePrefix, block, deployment.blockNumber);
    try {
      return await readTaskListPage({ contract: c, block, offset, limit, q, phase,
        namespace: storePrefix, cache: taskListCache, taskView, hashMetadata: hash,
        readMetadata: id => capabilities().privateStorage ? store.get('metadata:' + id) : null });
    } catch (error) {
      if (!(error instanceof ListIndexError) && error.code !== 'INVALID_REQUEST') throw error;
      const safeError = new MarketplaceError(error.message, error.status, error.code);
      safeError.readBlock = block;
      throw safeError;
    }
  }, { block: snapshotBlock });
}
export async function readSubmitterPage(id, { cursor = 0, limit = 50, snapshotBlock } = {}) {
  return withChain(async (c, p, block) => {
    let workers, total;
    if (deployment.version >= 2) {
      total = Number(await c.submissionCount(taskId(id), { blockTag: block }));
      workers = Array.from(await c.getSubmittersPage(taskId(id), cursor, limit, { blockTag: block }));
    } else {
      const all = Array.from(await c.getSubmitters(taskId(id), { blockTag: block }));
      total = all.length; workers = all.slice(cursor, cursor + limit);
    }
    return { workers, total, snapshotBlock: block, nextCursor: cursor + workers.length < total ? cursor + workers.length : null };
  }, { block: snapshotBlock });
}
export async function submission(id, worker, { block: snapshotBlock } = {}) {
  return withChain((c, p, block) =>
    c.getSubmission(taskId(id), worker, { blockTag: block }),
    { block: snapshotBlock },
  );
}
export function sanitizeMetadata(m) {
  if (!m || typeof m !== "object" || Array.isArray(m))
    fail("Metadata is required.");
  const out = {};
  for (const [k, min, max] of [
    ["title", 5, 140],
    ["description", 20, 12000],
    ["rubric", 10, 8000],
    ["category", 2, 60],
  ]) {
    if (typeof m[k] !== "string" || m[k].length < min || m[k].length > max)
      fail(`Invalid ${k}.`);
    out[k] = m[k];
  }
  return out;
}
export const artifactKey = (id, worker) =>
  `artifact:${taskId(id)}:${worker.toLowerCase()}`;
export const limitations = [
  "Review service and model provider are trusted infrastructure; no TEE or host-proof confidentiality claim.",
  deployment.version >= 2
    ? "V2 settlement requires an evaluator receipt and permits relayers to release only preauthorized escrow; host judgement and delivery availability remain trusted dependencies."
    : "Legacy V1 authorizes requester selection directly; evaluator decisions are enforced by this application workflow, not by the immutable contract.",
  ...(deployment.newTasksEnabled ? [] : ["New hosted approvals and funding are disabled until verified V2 activation; V1 discovery, existing-task settlement and refunds remain supported."]),
  "Only eligible Agent ID contract interactions count toward campaign metrics; API requests alone are not on-chain activity.",
];

export function authorizationTypedData(a) {
  const domain = {
    name: "ONERUB Marketplace",
    version: "1",
    chainId: deployment.chainId,
    verifyingContract: deployment.address,
  };
  const fields = [
    { name: "address", type: "address" },
    { name: "action", type: "string" },
    { name: "taskId", type: "uint256" },
    { name: "payloadHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
    { name: "audience", type: "string" },
  ];
  return {
    domain,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Authorization: fields,
    },
    primaryType: "Authorization",
    message: {
      address: a.address,
      action: a.action,
      taskId: a.taskId,
      payloadHash: a.payloadHash,
      nonce: a.nonce,
      expiresAt: a.expiresAt,
      audience: "onerub.net",
    },
  };
}
