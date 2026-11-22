// Node.js synthetic RPC/cache tests: no live chain, Redis, or provider spending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskListCache, readTaskListPage } from '../lib/marketplace-list-cache.mjs';
import { hash } from '../lib/marketplace-core.mjs';

function sharedStore(now = () => 0) {
  const values = new Map();
  return { values,
    async get(key) { const v = values.get(key); return v && v.expires > now() ? structuredClone(v.value) : null; },
    async put(key, value, { nx, ttl } = {}) { if (nx && await this.get(key)) return false; values.set(key, { value: structuredClone(value), expires: now() + ttl * 1000 }); return true; },
    async release(key, owner) { if (await this.get(key) === owner) values.delete(key); },
    async putIfLease(key, value, { leaseKey, owner, ttl }) {
      if (await this.get(leaseKey) !== owner) return false;
      return this.put(key, value, { ttl });
    },
  };
}
function fixture({ total = 1000, storage, cacheOptions = {}, advance = () => {} } = {}) {
  const calls = { getTask: 0, phaseOf: 0, nextTaskId: 0, metadata: 0 }, blocks = [];
  const metadata = { title: 'verified alpha', description: 'public description', category: 'writing' };
  const contract = {
    async nextTaskId(opts) { calls.nextTaskId++; blocks.push(opts.blockTag); return BigInt(total + 1); },
    async getTask(id, opts) { calls.getTask++; blocks.push(opts.blockTag); advance(); return { id }; },
    async phaseOf(id, opts) { calls.phaseOf++; blocks.push(opts.blockTag); return id % 2 ? 'Open' : 'Review'; },
  };
  const cache = createTaskListCache({ storage, ...cacheOptions });
  const args = { contract, block: 123, namespace: '56:escrow', cache,
    taskView: (id, task, phase) => ({ id: String(id), phase, requester: 'alice', winner: 'bob', criteriaHash: hash(metadata) }),
    readMetadata: async id => { calls.metadata++; return { metadata: Number(id) % 3 ? metadata : { ...metadata, title: 'unverified secret phrase' }, artifact: 'PRIVATE_BYTES_MUST_NOT_ESCAPE' }; },
    hashMetadata: hash };
  return { calls, blocks, cache, args, page: extra => readTaskListPage({ ...args, ...extra }) };
}

test('1000 rows: default unfiltered page uses exactly12 task and phase RPCs, no full scan/cache/metadata', async () => {
  const f = fixture(); const a = await f.page({});
  assert.equal(a.tasks.length, 12); assert.equal(a.nextOffset, 12); assert.equal(a.matchedTasks, 1000);
  assert.deepEqual(f.calls, { nextTaskId: 1, getTask: 12, phaseOf: 12, metadata: 0 });
  assert.equal(f.cache.stats().entries, 0);
  const b = await f.page({ offset: 996 }); assert.deepEqual(b.tasks.map(t => t.id), ['4','3','2','1']); assert.equal(b.nextOffset, null);
  assert.ok(f.blocks.every(block => block === 123));
});

test('1000 rows: global matching exact, later filtered pages never rescan task RPCs', async () => {
  const f = fixture(); const a = await f.page({ q: 'alpha' });
  assert.equal(a.totalTasks, 1000); assert.equal(a.matchedTasks, 667); assert.equal(a.tasks.length, 12); assert.equal(a.nextOffset, 12);
  assert.equal(f.calls.getTask, 1000); assert.equal(f.calls.phaseOf, 1000); assert.equal(f.calls.metadata, 1000);
  let offset = 12, count = 12;
  while (offset !== null) { const b = await f.page({ q: 'alpha', offset }); assert.ok(b.tasks.length <= 12); count += b.tasks.length; offset = b.nextOffset; }
  assert.equal(count, 667); assert.equal(f.calls.getTask, 1000); assert.equal(f.calls.metadata, 1000);
  assert.ok(!JSON.stringify(a).includes('PRIVATE_BYTES')); assert.ok(!JSON.stringify(a).includes('verified alpha'));
  const bad = await f.page({ q: 'unverified secret phrase' }); assert.equal(bad.matchedTasks, 0);
  const phase = await f.page({ q: 'alpha', phase: 'Review' }); assert.equal(phase.matchedTasks, 334);
  assert.equal(f.calls.getTask, 1000); assert.equal(f.calls.metadata, 1000);
});

test('shared Redis snapshot reused by a fresh instance with zero row RPCs', async () => {
  const storage = sharedStore(); const a = fixture({ storage }); await a.page({ phase: 'Review' });
  const b = fixture({ storage }); const page = await b.page({ phase: 'Review', offset: 12 });
  assert.equal(page.matchedTasks, 500); assert.equal(page.tasks[0].id, '976');
  assert.equal(b.calls.getTask, 0); assert.equal(b.calls.phaseOf, 0); assert.equal(b.calls.metadata, 0);
  const changed = await b.page({ q: 'alpha', phase: 'Open' });
  assert.equal(changed.matchedTasks, 333); assert.equal(b.calls.getTask, 0); assert.equal(b.calls.metadata, 0);
  assert.ok(storage.values.size <= 8);
});

test('singleflight shares one cold scan for concurrent pages, including Redis outage fallback', async () => {
  const storage = { async get() { throw Error('offline'); } };
  const f = fixture({ storage });
  const pages = await Promise.all(Array.from({ length: 10 }, (_, i) => f.page({ phase: i % 2 ? 'Open' : 'Review', q: i % 3 ? '' : 'alpha', offset: i * 12 })));
  assert.equal(f.calls.getTask, 1000); assert.equal(pages[5].tasks.length, 12); assert.equal(f.cache.stats().flights, 0);
});

test('checkpoint retries stay at original block and resume without refetching prior rows across instances', async () => {
  let time = 0; const storage = sharedStore(() => time);
  const options = { total: 1000, storage, cacheOptions: { now: () => time, budgetMs: 60 }, advance: () => { time += 1; } };
  let completed, retries = 0, rowCalls = 0;
  while (!completed) {
    const f = fixture(options);
    try { completed = await f.page({ phase: 'Open' }); }
    catch (e) { assert.equal(e.code, 'INDEX_BUILDING'); assert.equal(e.readBlock, 123); assert.equal(e.status, 503); retries++; }
    rowCalls += f.calls.getTask;
    assert.ok(f.calls.getTask <= 60);
  }
  assert.ok(retries > 1); assert.equal(rowCalls, 1000); assert.equal(completed.matchedTasks, 500);
});

test('TTL expires after five minutes, while LRU count/byte bounds and row capacity hold', async () => {
  let time = 0; const f = fixture({ total: 30, cacheOptions: { now: () => time, maxEntries: 2, maxBytes: 20000 } });
  await f.page({ phase: 'Open' }); time = 299999; await f.page({ phase: 'Open' }); assert.equal(f.calls.getTask, 30);
  time = 300001; await f.page({ phase: 'Open' }); assert.equal(f.calls.getTask, 60);
  await f.page({ phase: 'Review' }); await f.page({ q: 'alice' });
  await f.page({ q: 'alice', block: 124 }); await f.page({ q: 'alice', block: 125 });
  assert.equal(f.cache.stats().entries, 2); assert.ok(f.cache.stats().bytes <= 20000);
  const small = fixture({ cacheOptions: { maxRows: 10 } }); await assert.rejects(small.page({ phase: 'Open' }), { code: 'INDEX_CAPACITY' });
});

test('deployment and block isolate indexes while search and phase share them; invalid page rejected', async () => {
  const f = fixture({ total: 30 }); await f.page({ phase: 'Open' });
  await f.page({ phase: 'Open', block: 124 }); await f.page({ phase: 'Open', namespace: '56:different' });
  assert.equal(f.calls.getTask, 90);
  await assert.rejects(f.page({ offset: -1 }), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.page({ limit: 1000 }), { code: 'INVALID_REQUEST' });
});

test('expired lease cannot overwrite a newer colliding snapshot', async () => {
  let time = 0;
  const storage = sharedStore(() => time);
  const older = createTaskListCache({ storage, now: () => time, maxEntries: 1 });
  const newer = createTaskListCache({ storage, now: () => time, maxEntries: 1 });
  await assert.rejects(older.materialize('old', { block: 123, total: 1,
    readBatch: async () => {
      time = 61000;
      await newer.materialize('new', { block: 124, total: 1, readBatch: async () => [{ task: { id: 'new' }, search: 'new' }] });
      return [{ task: { id: 'old' }, search: 'old' }];
    } }), { code: 'INDEX_BUILDING', readBlock: 123 });
  const saved = await storage.get('list-index:v2:0');
  assert.equal(saved.block, 124); assert.equal(saved.rows[0].task.id, 'new');
});

test('oversized total is rejected before any full-index row RPCs', async () => {
  const f = fixture({ total: 10001 });
  await assert.rejects(f.page({ q: 'alpha' }), { code: 'INDEX_CAPACITY' });
  assert.equal(f.calls.getTask, 0); assert.equal(f.cache.stats().entries, 0);
  const page = await f.page({}); assert.equal(page.tasks.length, 12);
});

test('fresh filtered queries share a15second deployment pointer despite advancing heads', async () => {
  let time = 0; const storage = sharedStore(() => time);
  const a = fixture({ storage, cacheOptions: { now: () => time } });
  const blockA = await a.cache.recentBlock('56:escrow', 123, 100);
  await a.page({ block: blockA, q: 'alpha' });
  const b = fixture({ storage, cacheOptions: { now: () => time } });
  const blockB = await b.cache.recentBlock('56:escrow', 125, 100);
  assert.equal(blockB, 123);
  const pageB = await b.page({ block: blockB, phase: 'Review' });
  assert.equal(pageB.readBlock, 123); assert.equal(b.calls.getTask, 0);
  time = 15001;
  assert.equal(await b.cache.recentBlock('56:escrow', 130, 100), 130);
  assert.equal(await b.cache.recentBlock('56:other', 140, 100), 140);
});

test('recent pointer fallback is bounded and never selects future or predeployment blocks', async () => {
  let time = 0;
  const cache = createTaskListCache({ now: () => time, maxEntries: 2 });
  assert.equal(await cache.recentBlock('escrow', 150, 100), 150);
  assert.equal(await cache.recentBlock('escrow', 149, 100), 149);
  assert.equal(await cache.recentBlock('escrow', 160, 155), 160);
  time = 16000;
  assert.equal(await cache.recentBlock('escrow', 170, 155), 170);
});
