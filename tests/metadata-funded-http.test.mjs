// Node.js — real signed HTTP over loopback plus real funded contracts on isolated Anvil; no mainnet writes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { Wallet, NonceManager, ContractFactory, JsonRpcProvider, parseEther } from 'ethers';
import { compileMarketplaceV2 } from '../scripts/compile-marketplace-v2.mjs';
import { hash, taskView, deployment, MarketplaceError } from '../lib/marketplace-core.mjs';
import { DEFAULT_POLICY, policyHash } from '../lib/marketplace-policy.mjs';
import * as http from '../lib/marketplace-http.mjs';

let chain, provider, server, endpoint, owner, registry, token, escrow, requester, fundedRequester;
const units = 10n ** 18n;
const confirmed = async tx => (await tx).wait();
const artifact = name => JSON.parse(fs.readFileSync(new URL('../artifacts/marketplace-v2/' + name + '.json', import.meta.url)));
class MemoryTransactionStore {
  values = new Map(); beforeFailure = false; afterFailure = false;
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async put(key, value, { nx = false } = {}) { if (nx && this.values.has(key)) return false; this.values.set(key, structuredClone(value)); return true; }
  async limit() { return true; }
  async commitMetadata(id, record, auth) {
    if (this.beforeFailure) { this.beforeFailure = false; throw new MarketplaceError('Storage temporarily unavailable.', 503, 'STORAGE_UNAVAILABLE'); }
    const nonce = 'nonce:' + auth.nonce, key = 'metadata:' + id;
    if (this.values.has(nonce)) throw new MarketplaceError('Authorization was already used.', 409, 'REPLAY');
    const prior = this.values.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(record)) throw new MarketplaceError('Task metadata is immutable.', 409, 'METADATA_IMMUTABLE');
    this.values.set(key, structuredClone(record)); this.values.set(nonce, true);
    if (this.afterFailure) { this.afterFailure = false; throw new MarketplaceError('Storage response was interrupted.', 503, 'STORAGE_UNAVAILABLE'); }
    return true;
  }
}
const storage = new MemoryTransactionStore();
const config = { authentication: true, privateStorage: true, evaluator: false, newTasksEnabled: true };
const identity = () => ({ chainId: deployment.chainId, escrowAddress: deployment.address });
const readTask = async id => { const block = await provider.getBlockNumber(); return taskView(id, await escrow.getTask(id, { blockTag: block }), await escrow.phaseOf(id, { blockTag: block })); };
const eligible = async address => (await registry.balanceOf(address)) > 0n;
const call = async (path, body) => {
  const response = await fetch(endpoint + path, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.json() };
};
async function authorization(id, payload, signer = requester) {
  const result = await call('/api/marketplace/auth/challenge', { ...identity(), address: signer.address, action: 'metadata', taskId: id, payloadHash: hash(payload) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const auth = result.body, { typedData } = auth;
  return { ...auth, signature: await signer.signTypedData(typedData.domain, { Authorization: typedData.types.Authorization }, typedData.message) };
}
const publish = (id, payload, auth, extras = {}) => call('/api/marketplace/tasks/' + id + '/metadata', { ...identity(), payload, auth, ...extras });
async function fundedTask(title) {
  const metadata = { title, description: 'Return a full independently verifiable explanation using the public inputs.', rubric: 'Correctness 70 points; reproducible reasoning 30 points.', category: 'research' };
  const policy = structuredClone(DEFAULT_POLICY), pHash = policyHash(policy), stamp = BigInt((await provider.getBlock('latest')).timestamp), id = String(await escrow.nextTaskId());
  await storage.put('policy:' + pHash, { policy });
  const receipt = await confirmed(escrow.connect(fundedRequester).createAndFund(await token.getAddress(), units, hash(metadata), stamp + 3600n, stamp + 7200n, pHash));
  assert.equal(receipt.status, 1); assert.equal((await readTask(id)).bounty, String(units));
  return { id, metadata, receipt };
}

before(async () => {
  process.env.MARKETPLACE_AUTH_SECRET = randomBytes(32).toString('hex');
  process.env.MARKETPLACE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.UPSTASH_REDIS_REST_URL = 'https://synthetic-storage.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'local-test-placeholder-never-used';
  compileMarketplaceV2({ writeAbi: false });
  const resolve = createRequire(new URL('../scripts/test-chain/package.json', import.meta.url)).resolve;
  const binary = process.platform === 'win32' ? 'anvil.exe' : 'anvil', arch = process.arch === 'x64' ? 'amd64' : process.arch;
  chain = spawn(resolve('@foundry-rs/anvil-' + process.platform + '-' + arch + '/bin/' + binary), ['--host', '127.0.0.1', '--port', '0', '--chain-id', '56', '--hardfork', 'cancun'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = createInterface({ input: chain.stdout });
  const rpc = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Anvil startup timeout')), 15000); chain.once('error', error => { clearTimeout(timer); reject(error); }); lines.on('line', line => { const match = line.match(/Listening on (127[.]0[.]0[.]1:[0-9]+)/); if (match) { clearTimeout(timer); resolve('http://' + match[1]); } }); });
  provider = new JsonRpcProvider(rpc, 56, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 20 }); owner = await provider.getSigner(0);
  requester = Wallet.createRandom(); fundedRequester = new NonceManager(requester.connect(provider));
  await confirmed(owner.sendTransaction({ to: requester.address, value: parseEther('5') }));
  const reg = artifact('MockAgentID'); registry = await new ContractFactory(reg.abi, reg.bytecode, owner).deploy(); await registry.waitForDeployment();
  const tok = artifact('MockERC20'); token = await new ContractFactory(tok.abi, tok.bytecode, owner).deploy('Synthetic USDC', 'USDC', 18); await token.waitForDeployment();
  const esc = artifact('OneRubMarketplaceEscrowV2'); escrow = await new ContractFactory(esc.abi, esc.bytecode, owner).deploy(await registry.getAddress(), await (await provider.getSigner(4)).getAddress(), await token.getAddress(), Wallet.createRandom().address); await escrow.waitForDeployment();
  await confirmed(registry.set(requester.address, 1)); await confirmed(token.mint(requester.address, 20n * units)); await confirmed(token.connect(fundedRequester).approve(await escrow.getAddress(), 20n * units));
  server = createServer(async (req, res) => { try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = new Request('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    const match = req.url.match(/^\/api\/marketplace\/tasks\/([0-9]+)(\/metadata)?$/);
    const response = await http.handle(async () => {
      if (req.url === '/api/marketplace/auth/challenge') return http.challenge(request, { storage, config });
      if (match && req.method === 'POST' && match[2]) return http.privateAction(request, match[1], 'metadata', { storage, readTask, eligible, config });
      if (match && req.method === 'GET' && !match[2]) return http.publicTask(match[1], request, { storage, readTask, observe: async () => ({}) });
      throw new MarketplaceError('Not found.', 404, 'NOT_FOUND');
    });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end('{}'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); endpoint = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } provider?.destroy(); if (chain?.pid && chain.exitCode === null && chain.signalCode === null) { const stopped = once(chain, 'exit'); chain.kill(); await stopped; } });

test('real funded local escrow -> HTTP challenge -> real EIP712 signature -> metadata POST -> verified public readback', async () => {
  const { id, metadata } = await fundedTask('Funded HTTP metadata publication'); const payload = { metadata }, auth = await authorization(id, payload);
  const result = await publish(id, payload, auth); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.registered, true);
  const detail = await call('/api/marketplace/tasks/' + id); assert.equal(detail.status, 200); assert.deepEqual(detail.body.task.metadata, metadata); assert.equal(detail.body.task.metadataVerified, true); assert.equal(detail.body.task.metadataHash, hash(metadata)); assert.equal(detail.body.task.policyVerified, true);
  assert.equal((await publish(id, payload, auth)).body.code, 'REPLAY');
  assert.equal((await publish(id, payload, await authorization(id, payload))).status, 200);
  assert.equal(await token.balanceOf(await escrow.getAddress()), units);
});
test('audit-compatible signed flat metadata succeeds without trusting an unsigned top-level metadata field', async () => {
  const { id, metadata } = await fundedTask('Legacy flat signed payload compatibility'); const auth = await authorization(id, metadata);
  const result = await publish(id, metadata, auth, { metadata: { ...metadata, title: 'UNSIGNED ATTACK' } }); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual((await call('/api/marketplace/tasks/' + id)).body.task.metadata, metadata);
});
test('validation400 leaves nonce unused; payload tampering under the old signature fails; fresh matching authorization recovers funded task', async () => {
  const { id, metadata } = await fundedTask('Recovery after rejected metadata validation'); const bad = { metadata: { title: 'x' } }, auth = await authorization(id, bad);
  const rejected = await publish(id, bad, auth); assert.equal(rejected.status, 400, JSON.stringify(rejected.body)); assert.equal(await storage.get('nonce:' + auth.nonce), null);
  assert.equal((await publish(id, { metadata }, auth)).status, 401); assert.equal(await storage.get('nonce:' + auth.nonce), null);
  assert.equal((await publish(id, { metadata }, await authorization(id, { metadata }))).status, 200);
});
test('precommit storage503 permits identical signed retry; ambiguous postcommit503 reads back safely and replay409 cannot duplicate the write', async () => {
  const first = await fundedTask('Retry exact signed request after storage error'); const payload = { metadata: first.metadata }, auth = await authorization(first.id, payload);
  storage.beforeFailure = true; assert.equal((await publish(first.id, payload, auth)).status, 503); assert.equal(await storage.get('nonce:' + auth.nonce), null); assert.equal((await publish(first.id, payload, auth)).status, 200);
  const second = await fundedTask('Read back ambiguous already committed metadata'); const p2 = { metadata: second.metadata }, a2 = await authorization(second.id, p2);
  storage.afterFailure = true; assert.equal((await publish(second.id, p2, a2)).status, 503); assert.equal((await call('/api/marketplace/tasks/' + second.id)).body.task.metadataVerified, true); assert.equal((await publish(second.id, p2, a2)).body.code, 'REPLAY');
});
test('simultaneous identical signed HTTP requests commit once; eligible nonrequester is rejected without burning its nonce', async () => {
  const { id, metadata } = await fundedTask('Concurrent metadata mutation authorization'); const payload = { metadata }, auth = await authorization(id, payload);
  const results = await Promise.all([publish(id, payload, auth), publish(id, payload, auth)]); assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const stranger = Wallet.createRandom(); await confirmed(registry.set(stranger.address, 1)); const wrong = await authorization(id, payload, stranger);
  assert.equal((await publish(id, payload, wrong)).status, 403); assert.equal(await storage.get('nonce:' + wrong.nonce), null);
});
