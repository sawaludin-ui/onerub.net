import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Interface, keccak256 } from 'ethers';
import { observation } from '../lib/marketplace-observation.mjs';
import legacy from '../lib/marketplace-deployment.json' with { type: 'json' };
import { ACTIVE_MARKETPLACE_DEPLOYMENT, MARKETPLACE_ABI, marketplaceAbiFor, marketplaceTaskIdentity, resolveMarketplaceDeployment, validateDeploymentManifest } from '../lib/marketplace-deployment-resolver.mjs';
import { deployment, abi, storePrefix, MarketplaceError, RedisStore, artifactKey, encryptArtifact, hash, authorizationTypedData } from '../lib/marketplace-core.mjs';
import { assertDeploymentIdentity, prepare, publicConfig, probeReadiness, handle } from '../lib/marketplace-http.mjs';
import { activeDeployment, validatePrepared, requestPreparation, runTask } from '../scripts/agent-task.mjs';
const addr = n => '0x' + n.repeat(40), digest = n => '0x' + n.repeat(64);
function v2() {
  const manifest = { ...structuredClone(legacy), address: addr('1'), version: 2, protocolRevision: 3,
    contract: 'OneRubMarketplaceEscrowV2', evaluator: addr('2') };
  manifest.readBack = { ...manifest.readBack, evaluator: manifest.evaluator, minReviewSeconds: '3600', protocolRevision: '3', minimumValidSubmissions: '1', evaluatorRevoked: false };
  manifest.verification = { status: 'verified', source: 'sourcify', chainId: 56, protocolRevision: 3,
    address: manifest.address, transactionHash: manifest.transactionHash, blockNumber: manifest.blockNumber,
    runtimeCodeHash: digest('3'), creationMatch: 'exact_match', runtimeMatch: 'exact_match' };
  return manifest;
}
const request = body => new Request('https://onerub.net/api/marketplace/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('only a bound verified revision3 V2 manifest takes precedence over real V1', () => {
  assert.equal(validateDeploymentManifest(v2(), 2), true);
  assert.equal(resolveMarketplaceDeployment({ v2Manifest: v2() }).version, 2);
  for (const mutate of [m => delete m.verification, m => m.verified = true,
    m => m.verification.status = 'pending', m => m.verification.source = 'unknown',
    m => m.verification.runtimeMatch = 'partial_match', m => m.verification.address = addr('4'),
    m => m.verification.chainId = 1, m => m.verification.transactionHash = digest('5'),
    m => m.verification.blockNumber++, m => m.verification.runtimeCodeHash = '0x',
    m => m.protocolRevision = 2, m => m.readBack.protocolRevision = '2',
    m => m.readBack.minimumValidSubmissions = '2', m => m.readBack.evaluatorRevoked = true,
    m => m.readBack.evaluator = addr('6'), m => m.readBack.usdcAllowed = false,
    m => m.readBack.feeBps = '900', m => m.readBack.minReviewSeconds = '1',
    m => m.chainId = 1, m => m.address = addr('0'), m => m.token = 'bad']) {
    const candidate = v2();
    if (String(mutate).includes('m.verified')) delete candidate.verification;
    mutate(candidate);
    assert.equal(resolveMarketplaceDeployment({ v2Manifest: candidate }).version, 1);
  }
  assert.equal(resolveMarketplaceDeployment({ v2Manifest: null }).version, 1);
  assert.throws(() => resolveMarketplaceDeployment({ v1Manifest: {}, v2Manifest: {} }), /No validated/);
});
test('browser server CLI ABI and identity agree; no secret or Node import in resolver', () => {
  assert.deepEqual(activeDeployment(), ACTIVE_MARKETPLACE_DEPLOYMENT);
  assert.deepEqual(deployment, ACTIVE_MARKETPLACE_DEPLOYMENT);
  assert.deepEqual(abi, MARKETPLACE_ABI);
  assert.equal(storePrefix, 'onerub:marketplace:' + deployment.namespace + ':');
  assert.equal(authorizationTypedData({}).domain.verifyingContract, deployment.address);
  const source = fs.readFileSync(new URL('../lib/marketplace-deployment-resolver.mjs', import.meta.url), 'utf8');
  assert.equal(/node:|process\.env|marketplace-core/.test(source), false);
  const candidate = v2(); candidate.privateKey = 'secret'; candidate.provider = 'credential-url'; candidate.deployer = { secret: 'nested-secret' };
  const safe = resolveMarketplaceDeployment({ v2Manifest: candidate });
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(safe)), safe);
  assert.notEqual(marketplaceTaskIdentity('1').key, marketplaceTaskIdentity('1', safe).key);
  assert.notEqual(marketplaceTaskIdentity('1').path, marketplaceTaskIdentity('1', safe).path);
  assert.throws(() => marketplaceTaskIdentity('../1'));
});
test('API deployment selectors fail closed rather than alias a same-numbered foreign task', async () => {
  assertDeploymentIdentity({ chainId: 56, escrowAddress: deployment.address.toLowerCase() });
  for (const selector of [{ chainId: 1 }, { escrowAddress: addr('7') }, { contract: {} }, { escrowAddress: deployment.address, contract: addr('7') }]) {
    assert.throws(() => assertDeploymentIdentity(selector), e => e.code === 'DEPLOYMENT_MISMATCH');
    const response = await handle(() => prepare(request({ action: 'approve', amount: '1', ...selector })));
    assert.equal(response.status, 409);
  }
  const config = await publicConfig(); assert.deepEqual(config.activeDeployment, activeDeployment());
  assert.equal(config.newTasksEnabled, deployment.version === 2);
  if (deployment.version === 1) {
    assert.equal(config.defaultPolicy, null);
    for (const action of ['approve', 'createAndFund']) {
      const response = await handle(() => prepare(request({ action, amount: '1' })));
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'ESCROW_UPGRADE_REQUIRED');
    }
  } else {
    const approval = await prepare(request({ action: 'approve', amount: '1' }), {
      config: { authentication: true, privateStorage: true, evaluator: true },
      readHealth: async () => ({ status: 'healthy', checks: Object.fromEntries(['rpc','storage','encryption','attestation','evaluator','uploads','delivery'].map(key => [key, { status: 'available' }])) }),
    });
    assert.equal(approval.escrowVersion, deployment.version);
    assert.equal(validatePrepared(approval, { action: 'approve', amount: '1' }, deployment).to, deployment.token);
  }
});
test('legacy V1 selection and commitment decode only with V1 ABI; rejectAll is actionable', async () => {
  const legacyConfig = resolveMarketplaceDeployment({ v2Manifest: null }), iface = new Interface(marketplaceAbiFor(1));
  for (const [action, args] of [['selectWinner', ['1', addr('8')]], ['submitCommitment', ['1', digest('a'), digest('b')]], ['cancel', ['1']], ['refund', ['1']]]) {
    const value = { chainId: 56, to: legacyConfig.address, value: '0', data: iface.encodeFunctionData(action, args), escrowVersion: 1 };
    assert.equal(validatePrepared(value, { action, taskId: '1' }, legacyConfig).to, legacyConfig.address);
    assert.throws(() => validatePrepared(value, { action, taskId: '1' }, { ...legacyConfig, version: 2 }), /version mismatch/);
  }
  await assert.rejects(runTask(['reject', '1'], { config: legacyConfig, baw: () => { throw Error('must not touch wallet'); } }), /verified V2/);
});
test('CLI preparation sends exact deployment binding and rejects mismatched API metadata', async () => {
  let received;
  await requestPreparation({ action: 'refund', taskId: '1' }, { config: deployment, fetcher: async (url, options) => { received = JSON.parse(options.body); return { ok: true, json: async () => ({}) }; } });
  assert.equal(received.chainId, deployment.chainId); assert.equal(received.escrowAddress, deployment.address);
  const value = { chainId: deployment.chainId, to: deployment.address, value: '0', data: new Interface(marketplaceAbiFor(deployment.version)).encodeFunctionData('refund', ['1']) };
  assert.throws(() => validatePrepared({ ...value, activeDeployment: { ...deployment, address: addr('9') } }, { action: 'refund', taskId: '1' }, deployment), /identity mismatch/);
});
test('new hosted funding is blocked on V1 and unverified V2 before API and wallet calls', async () => {
  const legacy = resolveMarketplaceDeployment({ v2Manifest: null });
  const verified = resolveMarketplaceDeployment({ v2Manifest: v2() });
  assert.equal(legacy.newTasksEnabled, false); assert.equal(verified.newTasksEnabled, true);
  for (const config of [legacy, { ...verified, verified: false }, { ...verified, newTasksEnabled: false }]) {
    await assert.rejects(runTask(['approve', '1'], { config, baw: () => { throw Error('must not call wallet'); } }), e => e.code === 'ESCROW_UPGRADE_REQUIRED');
    await assert.rejects(runTask(['create', 'unused.json'], { config }), e => e.code === 'ESCROW_UPGRADE_REQUIRED');
    for (const action of ['approve', 'createAndFund']) {
      await assert.rejects(requestPreparation({ action, amount: '1' }, { config, fetcher: () => { throw Error('must not call API'); } }), e => e.code === 'ESCROW_UPGRADE_REQUIRED');
      assert.throws(() => validatePrepared({}, { action }, config), e => e.code === 'ESCROW_UPGRADE_REQUIRED');
    }
  }
  let called = false;
  await requestPreparation({ action: 'approve', amount: '1' }, { config: verified, fetcher: async () => { called = true; return { ok: true, json: async () => ({}) }; } });
  assert.equal(called, true);
});
test('rate-limit serializer exports bounded cooldown only and never private provider fields', async () => {
  for (const seconds of [0, 1, 120, 86400]) {
    const error = Object.assign(new MarketplaceError('Protected evaluator is rate limited.', 503, 'EVALUATOR_RATE_LIMIT'),
      { retryAfterSeconds: seconds, providerStatus: 429, body: 'SECRET_PROVIDER_BODY', token: 'SECRET_PROVIDER_TOKEN' });
    const response = await handle(() => { throw error; });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), String(seconds));
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(await response.json(), { error: error.message, code: error.code, error_code: error.code, retryable: true, retryAfterSeconds: seconds });
  }
  for (const seconds of [-1, 86401, 1.5, '120', NaN, Infinity, null, undefined, { secret: 'SECRET' }]) {
    const error = Object.assign(new MarketplaceError('Protected evaluator is rate limited.', 503, 'EVALUATOR_RATE_LIMIT'),
      { retryAfterSeconds: seconds, providerStatus: 429, body: 'SECRET_PROVIDER_BODY' });
    const response = await handle(() => { throw error; });
    assert.equal(response.headers.get('Retry-After'), null);
    assert.deepEqual(await response.json(), { error: error.message, code: error.code, error_code: error.code, retryable: true });
  }
  for (const error of [Object.assign(new MarketplaceError('Other service failure.', 502, 'EVALUATOR_UNAVAILABLE'), { retryAfterSeconds: 15, providerStatus: 500, body: 'SECRET' }),
    Object.assign(new Error('SECRET_PROVIDER_BODY'), { code: 'EVALUATOR_RATE_LIMIT', retryAfterSeconds: 15, providerStatus: 429 })]) {
    const response = await handle(() => { throw error; });
    assert.equal(response.headers.get('Retry-After'), null);
    const body = await response.json();
    assert.equal('retryAfterSeconds' in body, false); assert.equal('providerStatus' in body, false);
    assert.equal(JSON.stringify(body).includes('SECRET'), false);
  }
});
test('pending provider cooldown is successful progress with a bounded Retry-After, never a settlement decision', async () => {
  const progress = { status: 'cooldown', outcome: 'pending', taskId: '1', processed: 1, total: 3, retryAfterSeconds: 7, nextAction: 'evaluate' };
  const response = await handle(async () => progress);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Retry-After'), '7');
  const body = await response.json(); assert.deepEqual(body, progress); assert.equal('signature' in body, false); assert.equal('winner' in body, false);
  for (const retryAfterSeconds of [0, -1, 86401, '7', 1.5, NaN, Infinity]) {
    const r = await handle(async () => ({ ...progress, retryAfterSeconds })); assert.equal(r.headers.get('Retry-After'), null);
  }
  for (const changed of [{ status: 'evaluating' }, { outcome: 'winner' }]) {
    const r = await handle(async () => ({ ...progress, ...changed })); assert.equal(r.headers.get('Retry-After'), null);
  }
  const error = Object.assign(new MarketplaceError('Shared provider is waiting.', 503, 'EVALUATOR_COOLDOWN'), { retryAfterSeconds: 60, providerStatus: 429, body: 'SECRET_PROVIDER_BODY' });
  const failed = await handle(async () => { throw error; }); assert.equal(failed.headers.get('Retry-After'), '60');
  assert.deepEqual(await failed.json(), { error: error.message, code: error.code, error_code: error.code, retryable: true, retryAfterSeconds: 60 });
});

test('health checks never claim provider delivery or uploads work based only on flags', async () => {
  const options = { storage: { command: async () => 'PONG' }, config: { evaluator: true }, checkEncryption: () => true,
    readChain: async () => ({ readBlock: 123, owner: addr('1'), treasury: addr('2'), registry: addr('3') }) };
  const healthyDependencies = await probeReadiness(options);
  assert.equal(healthyDependencies.status, 'degraded');
  assert.equal(healthyDependencies.checks.rpc.status, 'available');
  for (const key of ['evaluator', 'delivery', 'uploads']) assert.equal(healthyDependencies.checks[key].status, 'unknown');
  const failure = async () => { throw Error('SECRET_TOKEN provider raw response'); };
  const down = await probeReadiness({ ...options, storage: { command: failure }, readChain: failure, checkEncryption: failure });
  assert.equal(down.checks.rpc.status, 'unavailable'); assert.equal(down.checks.storage.status, 'unavailable');
  assert.equal(JSON.stringify(down).includes('SECRET_TOKEN'), false);
  const waiting = await probeReadiness({ ...options, checkDispatch: async () => ({ cooldown: true, retryAfterSeconds: 60, retryAt: 2000000000, owner: 'SECRET_OWNER' }) });
  assert.deepEqual(waiting.checks.evaluator, { status: 'cooldown', basis: 'shared-dispatch-state-not-provider-health', retryAfterSeconds: 60, retryAt: 2000000000 });
  assert.equal(JSON.stringify(waiting).includes('SECRET_OWNER'), false);
  const open = await probeReadiness({ ...options, checkDispatch: async () => ({ cooldown: false, retryAfterSeconds: 0, retryAt: 2000000000 }) });
  assert.equal(open.checks.evaluator.status, 'unknown');
});
test('V2 health signer must match a live non-revoked default, not stale manifest config', async () => {
  const active = resolveMarketplaceDeployment({ v2Manifest: v2() }); let checked;
  const options = { active, config: { evaluator: true }, storage: { command: async () => 'PONG' }, checkEncryption: () => true,
    readChain: async () => ({ readBlock: 123, evaluator: addr('9'), evaluatorRevoked: false }), checkSigner: value => { checked = value.evaluator; } };
  assert.equal((await probeReadiness(options)).checks.attestation.status, 'available'); assert.equal(checked, addr('9'));
  assert.equal((await probeReadiness({ ...options, readChain: async () => ({ readBlock: 123, evaluator: addr('9'), evaluatorRevoked: true }) })).checks.attestation.status, 'unavailable');
});
test('public observation proves commitment and plaintext integrity before saying delivery is available', async () => {
  const previous = process.env.MARKETPLACE_ENCRYPTION_KEY;
  process.env.MARKETPLACE_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString('base64');
  try {
    const task = { id: '1', winner: addr('1'), phase: 'Settled', readBlock: 500 };
    const bytes = Buffer.from('Synthetic private report never public');
    const encrypted = encryptArtifact(bytes, artifactKey(task.id, task.winner));
    const record = { worker: task.winner, encrypted, size: bytes.length, contentHash: hash(encrypted), plaintextHash: keccak256(bytes), artifactPtrHash: digest('a') };
    let committed = { exists: true, contentHash: record.contentHash, artifactPtrHash: record.artifactPtrHash };
    const options = { storageEnabled: true, events: [{ event: 'Settled', blockNumber: 490, transactionHash: digest('b') }],
      storage: { get: async key => key.startsWith('artifact:') ? record : { outcome: 'SECRET_PRIVATE_REPORT' } },
      readSubmission: async (id, worker, options) => { assert.equal(options.block, task.readBlock); return committed; } };
    const valid = await observation(task, options);
    assert.equal(valid.observation.deliveryStatus, 'available-to-requester-and-winner');
    assert.equal(valid.observation.decisionStatus, 'unverified');
    assert.equal(JSON.stringify(valid).includes('SECRET_PRIVATE_REPORT'), false);
    assert.equal(JSON.stringify(valid).includes(bytes.toString()), false);
    committed = { ...committed, contentHash: digest('c') };
    assert.equal((await observation(task, options)).observation.deliveryStatus, 'recovery-required');
    committed = { ...committed, contentHash: record.contentHash }; record.plaintextHash = digest('d');
    assert.equal((await observation(task, options)).observation.deliveryStatus, 'recovery-required');
    task.readBlock = 491;
    assert.equal((await observation(task, options)).observation.deliveryStatus, 'pending-confirmations');
  } finally { if (previous === undefined) delete process.env.MARKETPLACE_ENCRYPTION_KEY; else process.env.MARKETPLACE_ENCRYPTION_KEY = previous; }
});
test('Redis artifact admission is one namespaced atomic command and cannot shorten retention', async () => {
  const storage = new RedisStore(), calls = []; let result = 1;
  storage.command = async (...args) => { calls.push(args); return result; };
  const key = artifactKey('1', addr('1')), record = { size: 10, encrypted: { ciphertext: 'synthetic' } };
  assert.equal(await storage.putArtifact(key, record, { id: '1', worker: addr('1'), maxParticipants: 64, maxTotalBytes: 1000, ttl: 600 }), true);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'EVAL'); assert.equal(calls[0][2], '3');
  for (const k of calls[0].slice(3, 6)) assert.ok(k.startsWith(storePrefix));
  assert.match(calls[0][1], /t<tonumber\(ARGV\[5\]\)/);
  result = 0; assert.equal(await storage.putArtifact(key, record, { id: '1', worker: addr('1'), maxParticipants: 64, maxTotalBytes: 1000 }), false);
  result = -2; await assert.rejects(storage.putArtifact(key, record, { id: '1', worker: addr('1'), maxParticipants: 64, maxTotalBytes: 1000 }), e => e.code === 'ADMISSION_LIMIT');
  result = 1; assert.equal(await storage.retain(key, 900), true);
  assert.match(calls.at(-1)[1], /t>=0 and t<tonumber/);
  result = 0; assert.equal(await storage.retain(key, 900), false);
});
