import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Interface } from 'ethers';
import { createPublicEventIndex, redisIndexStorage, PublicIndexError } from '../lib/marketplace-event-index.mjs';
const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20), C = '0x' + '33'.repeat(20);
const HASH = '0x' + 'ab'.repeat(32);
const iface = new Interface([
 'event TaskCreated(uint256 indexed taskId,address indexed requester,address token,uint256 bounty,uint64 submissionDeadline,uint64 reviewDeadline,bytes32 criteriaHash,bytes32 policyHash)',
 'event SubmissionCommitted(uint256 indexed taskId,address indexed worker,bytes32 contentHash,bytes32 artifactPtrHash,uint32 size,bytes32 candidatesHash)',
 'event WinnerSelected(uint256 indexed taskId,address indexed winner,uint256 payout,uint256 fee)',
 'event Settled(uint256 indexed taskId,address indexed winner,address token,uint256 payout,uint256 fee)',
 'event Refunded(uint256 indexed taskId,address indexed requester,uint256 amount)',
 'event Cancelled(uint256 indexed taskId,address indexed requester,uint256 amount)',
]);
function log(event, taskId, blockNumber, who = A, index = 0) {
 const args = event === 'TaskCreated' ? [taskId, who, C, 100n, 1000, 2000, HASH, HASH] : event === 'SubmissionCommitted' ? [taskId, who, HASH, HASH, 99, HASH] : event === 'Settled' ? [taskId, who, C, 90n, 10n] : event === 'WinnerSelected' ? [taskId, who, 90n, 10n] : [taskId, who, 100n];
 return { ...iface.encodeEventLog(iface.getEvent(event), args), address: C, blockNumber, transactionHash: HASH, transactionIndex: 2, index };
}
function memory() {
 const map = new Map(); let commits = 0, bulkReads = 0;
 return { map, get commits() { return commits; }, get bulkReads() { return bulkReads; },
  async get(k) { return structuredClone(map.get(k) ?? null); },
  async getMany(keys) { bulkReads++; return keys.map(k => structuredClone(map.get(k) ?? null)); },
  async commit(expected, next, changes) {
   if (JSON.stringify(map.get('public-events:v1:manifest') ?? null) !== JSON.stringify(expected)) return false;
   commits++; for (const [k, v] of Object.entries(changes)) map.set(k, structuredClone(v));
   map.set('public-events:v1:manifest', structuredClone(next)); return true;
  },
 };
}
function fixture(logs = [], opts = {}) {
 const storage = opts.storage || memory(); let calls = [], fork = 'a', failAt = -1, pruned = false;
 const provider = { async getBlock(n) { if (pruned) return null; return { hash: fork + n }; }, async getLogs(filter) {
  calls.push(filter); if (calls.length === failAt) throw new Error('RPC unavailable/pruned');
  return logs.filter(l => l.blockNumber >= filter.fromBlock && l.blockNumber <= filter.toBlock);
 } };
 const make = () => createPublicEventIndex({ storage, provider, parseLog: l => iface.parseLog(l), deployment: { address: C, blockNumber: 100 }, ...opts });
 return { storage, provider, make, calls, setFork(v) { fork = v; }, failAt(n) { failAt = n; }, pruned() { pruned = true; } };
}
for (const n of [1, 100, 10000]) test('bounded cold/warm public index with ' + n + ' synthetic tasks', async () => {
 const logs = Array.from({ length: n }, (_, i) => log('TaskCreated', i + 1, 100 + i, i === n - 1 ? B : A));
 const f = fixture(logs), head = Math.max(200, 100 + n + 12); let state;
 do { const before = f.calls.length; state = await f.make().advance(head); assert.ok(f.calls.length - before <= 2); } while (state.status !== 'ready');
 const before = f.calls.length, index = f.make(), s = await index.snapshot(head);
 const events = await index.taskEvents(n, s), profile = await index.profile(B, { offset: 0, limit: 24 }, s);
 assert.equal(events.length, 1); assert.equal(events[0].bounty, '100');
 assert.equal(profile.totalHistory, 1); assert.deepEqual(profile.rows.map(r => r.id), [String(n)]);
 assert.ok(f.calls.length - before <= 1); // fresh instance: durable cache, not hidden memoization
 assert.equal(f.calls.at(-1).toBlock - f.calls.at(-1).fromBlock, 11);
 assert.ok(f.storage.bulkReads <= Math.ceil((head - 12 - 99) / 2000));
 assert.ok(!JSON.stringify([...f.storage.map.values()]).includes('artifactPtrHash'));
 console.log(JSON.stringify({ tasks: n, coldLogCalls: before, warmLogCalls: f.calls.length - before, relevantProfileIds: profile.rows.length }));
});
test('500k historical blocks never triggers 245 calls in one cold detail', async () => {
 const f = fixture([log('TaskCreated', 1, 400000)]);
 await assert.rejects(f.make().snapshot(500100), e => e instanceof PublicIndexError && e.code === 'INDEX_BUILDING' && e.index.cursor === 4099 && e.index.remainingBlocks > 490000);
 assert.equal(f.calls.length, 2);
 const next = await f.make().advance(500100); assert.equal(next.cursor, 8099); assert.equal(f.calls.length, 4);
});
test('pagination and historical pin use only relevant address event IDs', async () => {
 const logs = Array.from({length:100}, (_,i) => log('TaskCreated',i+1,100+i));
 logs.push(log('SubmissionCommitted',1,200,B), log('Settled',1,210,B));
 const f = fixture(logs), idx = f.make(), s = await idx.snapshot(230);
 const page = await idx.profile(A,{offset:24,limit:24},s);
 assert.equal(page.totalHistory,100); assert.equal(page.nextOffset,48); assert.equal(page.rows[0].id,'76');
 const worker = await idx.profile(B,{},s); assert.deepEqual(worker.summary,{requested:0,submitted:1,won:1,paidTasks:1});
 const historic = await idx.snapshot(205), past = await idx.profile(B,{},historic);
 assert.equal(past.summary.paidTasks,0); assert.equal((await idx.taskEvents(1,historic)).some(e=>e.event==='Settled'),false);
});
test('partial RPC failure retains last atomic checkpoint and resumes without duplicates', async () => {
 const f=fixture([log('TaskCreated',1,101),log('TaskCreated',2,2101)]); f.failAt(2);
 await assert.rejects(f.make().advance(5000),/RPC unavailable/);
 assert.equal(f.storage.map.get('public-events:v1:manifest').cursor,2099);
 const idx=f.make(); await idx.advance(5000); const s=await idx.snapshot(5000);
 const profile=await idx.profile(A,{},s); assert.equal(profile.totalHistory,2); assert.equal(profile.summary.requested,2);
});
test('deep reorg invalidates all old records before bounded rebuild', async () => {
 const logs=[log('TaskCreated',1,101),log('Settled',1,150)]; const f=fixture(logs),idx=f.make();
 await idx.advance(300); const generation=f.storage.map.get('public-events:v1:manifest').generation;
 logs.splice(1,1); f.setFork('b'); const state=await idx.advance(50000);
 assert.equal(state.reorgReset,true); assert.equal(state.status,'building'); assert.notEqual(state.manifest.generation,generation);
 await assert.rejects(idx.snapshot(50000),e=>e.code==='INDEX_BUILDING');
 while((await idx.advance(50000)).status!=='ready') {}
 const s=await idx.snapshot(50000); assert.equal((await idx.taskEvents(1,s)).some(e=>e.event==='Settled'),false);
});
test('pruned/unavailable checkpoint fails closed without advancing or returning paid data',async()=>{
 const f=fixture([log('TaskCreated',1,101)]),idx=f.make(); await idx.advance(300);
 const before=structuredClone(f.storage.map.get('public-events:v1:manifest')); f.pruned();
 await assert.rejects(idx.snapshot(300),/checkpoint unavailable/); assert.deepEqual(f.storage.map.get('public-events:v1:manifest'),before);
});
test('changed fork during a range read does not commit cursor or events',async()=>{
 const f=fixture([log('TaskCreated',1,101)]); let n=0;
 f.provider.getBlock=async b=>({hash:(++n===1?'a':'b')+b});
 await assert.rejects(f.make().advance(300),/fork changed/);
 assert.equal(f.storage.map.get('public-events:v1:manifest').cursor,99);
});
test('reorg of prior checkpoint during a new range never publishes mixed forks',async()=>{
 const f=fixture([log('TaskCreated',1,101)]),idx=f.make(); await idx.advance(300);
 const before=structuredClone(f.storage.map.get('public-events:v1:manifest'));
 let reads=0; const prior=f.provider.getLogs;
 f.provider.getLogs=async filter=>{ const result=await prior(filter); if (++reads===1) f.setFork('b'); return result; };
 await assert.rejects(idx.advance(600),/fork changed/);
 assert.deepEqual(f.storage.map.get('public-events:v1:manifest'),before);
});
test('oversize logs fail explicitly and never skip a dense range',async()=>{
 const f=fixture([log('TaskCreated',1,101),log('TaskCreated',2,102)],{maxLogs:1});
 await assert.rejects(f.make().advance(300),e=>e.code==='INDEX_CAPACITY');
 assert.equal(f.storage.map.get('public-events:v1:manifest').cursor,99);
});
test('concurrent bootstrap CAS loser cannot overwrite winner records',async()=>{
 const f=fixture([log('TaskCreated',1,101)]); const results=await Promise.allSettled([f.make().advance(300),f.make().advance(300)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const idx=f.make(),s=await idx.snapshot(300); assert.equal((await idx.profile(A,{},s)).summary.requested,1);
});
test('submission order is actual chain block/transaction/log and requires finalization',async()=>{
 const f=fixture([log('TaskCreated',1,101),log('SubmissionCommitted',1,140,B,7)]),idx=f.make();
 let s=await idx.snapshot(145); await assert.rejects(idx.submissionOrder(1,B,s),e=>e.code==='INDEX_BUILDING');
 s=await idx.snapshot(160); assert.deepEqual(await idx.submissionOrder(1,B,s),{blockNumber:140,transactionIndex:2,logIndex:7});
 assert.deepEqual(Object.keys((await idx.taskEvents(1,s))[0]).sort(),['blockNumber','bounty','event','transactionHash']);
});
test('Redis adapter atomically packs keys/values/manifest and avoids per-event GETs',async()=>{
 const calls=[]; const adapter=redisIndexStorage({get:async()=>null,command:async(...a)=>{calls.push(a);return a[0]==='MGET'?[JSON.stringify({events:[]}),null]:1;}},'namespace:');
 assert.deepEqual(await adapter.getMany(['one','two']),[{events:[]},null]);
 const next={cursor:123}; assert.equal(await adapter.commit(null,next,{one:{events:[1]},two:{events:[2]}}),true);
 const args=calls[1]; assert.equal(args[2],'3'); assert.deepEqual(args.slice(3,6),['namespace:public-events:v1:manifest','namespace:one','namespace:two']);
 assert.deepEqual(args.slice(6),['',JSON.stringify({events:[1]}),JSON.stringify({events:[2]}),JSON.stringify(next)]);
 assert.ok(args[1].includes('ARGV[1+#KEYS]'));
});
test('legacy V1 public submission event is indexed without artifact hashes',async()=>{
 const legacy=new Interface(['event SubmissionCommitted(uint256 indexed taskId,address indexed worker,bytes32 contentHash,bytes32 artifactPtrHash)']);
 const e={...legacy.encodeEventLog(legacy.getEvent('SubmissionCommitted'),[1,B,HASH,HASH]),address:C,blockNumber:110,transactionHash:HASH,transactionIndex:0,index:1};
 const f=fixture([e],{parseLog:l=>legacy.parseLog(l)}),idx=f.make(),s=await idx.snapshot(150);
 assert.equal((await idx.profile(B,{},s)).summary.submitted,1); assert.ok(!JSON.stringify([...f.storage.map.values()]).includes('artifactPtrHash'));
});
test('missing chain position and duplicate log positions fail closed',async()=>{
 const missing=log('SubmissionCommitted',1,110,B); delete missing.transactionIndex;
 await assert.rejects(fixture([missing]).make().advance(150),/chain event position/);
 const e=log('TaskCreated',1,110); await assert.rejects(fixture([e,e]).make().advance(150),/Duplicate public log/);
});
test('profile implementation does not scan global task IDs or submissions',()=>{
 const source=fs.readFileSync(new URL('../lib/marketplace-observation.mjs',import.meta.url),'utf8');
 const profile=source.slice(source.indexOf('export async function agentProfile'));
 assert.doesNotMatch(profile,/nextTaskId|getSubmission|let top/); assert.match(profile,/page.rows.map/); assert.match(profile,/contract.phaseOf/);
});
