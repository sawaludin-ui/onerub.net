// Server-only public event index. No metadata, artifacts, decisions or credentials are indexed.
import { randomUUID } from 'node:crypto';
import { id, toQuantity } from 'ethers';

const SIGNATURES = [
  'TaskCreated(uint256,address,address,uint256,uint64,uint64,bytes32,bytes32)',
  'SubmissionCommitted(uint256,address,bytes32,bytes32,uint32,bytes32)',
  'SubmissionCommitted(uint256,address,bytes32,bytes32)',
  'WinnerSelected(uint256,address,uint256,uint256)',
  'Settled(uint256,address,address,uint256,uint256)',
  'Refunded(uint256,address,uint256)',
  'Cancelled(uint256,address,uint256)',
];
const TOPICS = SIGNATURES.map(id);
const DISPLAY = new Set(['TaskCreated', 'Settled', 'Refunded', 'Cancelled']);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
export class PublicIndexError extends Error {
  constructor(code, progress) { super(code === 'INDEX_CAPACITY' ? 'Public event index capacity reached.' : 'Public event index is catching up. Retry later.'); this.code = code; this.status = 503; this.index = progress; }
}
const key = 'public-events:v1:';
const CAS = "local prior=redis.call('GET',KEYS[1]); if (prior or '')~=ARGV[1] then return 0 end; for i=2,#KEYS do redis.call('SET',KEYS[i],ARGV[i]) end; redis.call('SET',KEYS[1],ARGV[1+#KEYS]); return 1";

// Each commit publishes records and cursor atomically. A crashed/stale worker cannot skip logs.
export function redisIndexStorage(store, prefix) {
  return {
    get: (name) => store.get(name),
    async getMany(names) {
      if (!names.length) return [];
      return (await store.command('MGET', ...names.map(n => prefix + n))).map(v => v ? JSON.parse(v) : null);
    },
    async commit(expected, manifest, records) {
      const names = [key + 'manifest', ...Object.keys(records)];
      const values = Object.values(records).map(v => JSON.stringify(v));
      return Number(await store.command('EVAL', CAS, String(names.length), ...names.map(n => prefix + n), expected ? JSON.stringify(expected) : '', ...values, JSON.stringify(manifest))) === 1;
    },
  };
}

function safeEvent(log, parseLog) {
  if (log.removed) throw new Error('Removed log');
  const parsed = parseLog(log), a = parsed.args, event = parsed.name;
  if (!SIGNATURES.some(s => s.startsWith(event + '('))) throw new Error('Unknown public event');
  const taskId = String(a.taskId);
  if (!/^[1-9][0-9]*$/.test(taskId) || !integer(Number(log.blockNumber))) throw new Error('Invalid public event');
  const transactionIndex = Number(log.transactionIndex), logIndex = Number(log.index ?? log.logIndex);
  if (!integer(transactionIndex) || !integer(logIndex) || !/^0x[0-9a-f]{64}$/i.test(log.transactionHash)) throw new Error('Invalid chain event position');
  const address = a.requester || a.worker || a.winner;
  if (!/^0x[0-9a-f]{40}$/i.test(address)) throw new Error('Invalid participant');
  return { event, taskId, participant: address.toLowerCase(), blockNumber: Number(log.blockNumber),
    transactionHash: log.transactionHash, transactionIndex, logIndex,
    ...(event === 'TaskCreated' ? { bounty: String(a.bounty) } : {}),
    ...(event === 'Settled' ? { payout: String(a.payout), fee: String(a.fee) } : {}) };
}
function publicEvent({ event, transactionHash, blockNumber, bounty, payout, fee }) {
  return { event, transactionHash, blockNumber, ...(bounty !== undefined ? { bounty } : {}), ...(payout !== undefined ? { payout, fee } : {}) };
}
export function profileFromEvents(events, { offset = 0, limit = 24 } = {}) {
  const roles = new Map();
  for (const e of events) {
    const r = roles.get(e.taskId) || { id: e.taskId, requested: false, submitted: false, won: false, paid: false };
    if (e.event === 'TaskCreated') r.requested = true;
    if (e.event === 'SubmissionCommitted') r.submitted = true;
    if (e.event === 'WinnerSelected' || e.event === 'Settled') r.won = true;
    if (e.event === 'Settled') r.paid = true;
    roles.set(e.taskId, r);
  }
  const rows = [...roles.values()].filter(r => r.requested || r.submitted).sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
  const summary = { requested: 0, submitted: 0, won: 0, paidTasks: 0 };
  for (const r of roles.values()) { summary.requested += Number(r.requested); summary.submitted += Number(r.submitted); summary.won += Number(r.won); summary.paidTasks += Number(r.paid); }
  return { summary, rows: rows.slice(offset, offset + limit), totalHistory: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null };
}

export function createPublicEventIndex({ storage, provider, parseLog, deployment, confirmations = 12, range = 2000, maxRanges = 2, maxLogs = 5000, maxRecordEvents = 50000 }) {
  if (![confirmations, range, maxRanges, maxLogs, maxRecordEvents].every(integer) || range < 1 || range > 10000 || maxRanges < 1 || maxRanges > 2) throw new Error('Invalid index bounds');
  const start = Number(deployment.blockNumber);
  // Raw send bypasses ethers' short _perform cache for the before/after fork check.
  // toQuantity removes leading-zero hex digits; toBeHex pads to even length and strict nodes reject 0x080c2193.
  const readBlock = (number) => provider.send ? provider.send('eth_getBlockByNumber', [toQuantity(number), false]) : provider.getBlock(number);
  const recordKey = (m, type, value) => key + m.generation + ':' + type + ':' + value;
  const progress = (m, block, calls, reset = false) => ({ status: m.cursor >= Math.max(start - 1, block - confirmations) ? 'ready' : 'building', cursor: m.cursor,
    targetBlock: block, finalizedBlock: Math.max(start - 1, block - confirmations), remainingBlocks: Math.max(0, block - confirmations - m.cursor), rpcLogCalls: calls, reorgReset: reset });
  // Public BSC RPCs reject wide ranges with -32005 "limit exceeded"; split instead of aborting the cursor.
  const rangeLimited = error => /limit exceeded|-32005/i.test(String(error?.message || error?.info?.error?.message || ''));
  async function logs(fromBlock, toBlock) {
    const found = [];
    async function collect(from, to) {
      if (to < from) return;
      let raw;
      try {
        raw = await provider.getLogs({ address: deployment.address, topics: [TOPICS], fromBlock: from, toBlock: to });
      } catch (error) {
        if (!rangeLimited(error) || to <= from) throw error;
        const middle = from + Math.floor((to - from) / 2);
        await collect(from, middle); await collect(middle + 1, to); return;
      }
      if (raw.length > maxLogs) throw new PublicIndexError('INDEX_CAPACITY');
      for (const l of raw) {
        if (Number(l.blockNumber) < from || Number(l.blockNumber) > to || l.address?.toLowerCase() !== deployment.address.toLowerCase()) throw new Error('Unexpected public log range');
        found.push(safeEvent(l, parseLog));
      }
    }
    await collect(fromBlock, toBlock);
    const seen = new Set();
    return found.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex).filter(e => {
      const position = e.blockNumber + ':' + e.logIndex;
      if (seen.has(position)) throw new Error('Duplicate public log position');
      seen.add(position); return true;
    });
  }
  async function commitRecords(m, next, events) {
    const names = [...new Set(events.flatMap(e => [recordKey(m, 'task', e.taskId), recordKey(m, 'address', e.participant)]))];
    const prior = await storage.getMany(names);
    const changes = Object.fromEntries(names.map((name, i) => [name, prior[i] || { events: [] }]));
    for (const e of events) {
      for (const [type, value] of [['task', e.taskId], ['address', e.participant]]) {
        const k = recordKey(m, type, value);
        changes[k].events.push(e);
        if (type === 'task' && e.event === 'TaskCreated') changes[k].createBlock = e.blockNumber;
        if (changes[k].events.length > maxRecordEvents) throw new PublicIndexError('INDEX_CAPACITY');
      }
    }
    // Bound each stored record and each REST transaction, not only the RPC count.
    if (Object.values(changes).some(v => Buffer.byteLength(JSON.stringify(v)) > 4 * 1024 * 1024) || Buffer.byteLength(JSON.stringify(changes)) > 16 * 1024 * 1024) throw new PublicIndexError('INDEX_CAPACITY');
    return storage.commit(m, next, changes);
  }
  async function advance(block) {
    if (!integer(block) || block < start) throw new Error('Invalid index snapshot');
    let m = await storage.get(key + 'manifest'), reset = false, calls = 0;
    if (m && (m.version !== 1 || !integer(m.cursor) || !m.generation)) throw new Error('Invalid index manifest');
    if (m && m.cursor >= start) {
      const anchor = await readBlock(m.cursor);
      if (!anchor?.hash) throw new Error('Index checkpoint unavailable');
      if (anchor.hash !== m.hash) {
        const next = { version: 1, generation: randomUUID(), cursor: start - 1, hash: null };
        if (!await storage.commit(m, next, {})) throw new PublicIndexError('INDEX_BUILDING', progress(m, block, calls));
        m = next; reset = true;
      }
    }
    if (!m) {
      m = { version: 1, generation: randomUUID(), cursor: start - 1, hash: null };
      if (!await storage.commit(null, m, {})) throw new PublicIndexError('INDEX_BUILDING');
    }
    const target = Math.max(start - 1, block - confirmations);
    for (let i = 0; i < maxRanges && m.cursor < target; i++) {
      const to = Math.min(target, m.cursor + range);
      // Validate the range anchor before AND after getLogs; never commit mixed-fork responses.
      const before = await readBlock(to);
      if (!before?.hash) throw new Error('Finalized block unavailable');
      const batch = await logs(m.cursor + 1, to); calls++;
      const after = await readBlock(to);
      if (before.hash !== after?.hash || (m.cursor >= start && (await readBlock(m.cursor))?.hash !== m.hash)) throw new Error('Index fork changed during read');
      const next = { ...m, cursor: to, hash: after.hash };
      if (!await commitRecords(m, next, batch)) throw new PublicIndexError('INDEX_BUILDING', progress(m, block, calls, reset));
      m = next;
    }
    return { ...progress(m, block, calls, reset), manifest: m };
  }
  async function snapshot(block) {
    const result = await advance(block);
    if (result.status !== 'ready') throw new PublicIndexError('INDEX_BUILDING', withoutManifest(result));
    // Historical pins older than the durable cursor need no tail. Otherwise at most 12 blocks.
    const anchor = await readBlock(block);
    if (!anchor?.hash) throw new Error('Snapshot block unavailable');
    const tail = block > result.manifest.cursor ? await logs(result.manifest.cursor + 1, block) : [];
    if ((await readBlock(block))?.hash !== anchor.hash || (result.manifest.cursor >= start && (await readBlock(result.manifest.cursor))?.hash !== result.manifest.hash)) throw new Error('Snapshot fork changed');
    return { ...result, rpcLogCalls: result.rpcLogCalls + Number(block > result.manifest.cursor), tail, block };
  }
  async function eventsFor(type, value, s) {
    const record = await storage.get(recordKey(s.manifest, type, value));
    return [...(record?.events || []), ...s.tail.filter(e => type === 'task' ? e.taskId === value : e.participant === value)].filter(e => e.blockNumber <= s.block);
  }
  return { advance, snapshot,
    async taskEvents(taskId, s) { return (await eventsFor('task', String(taskId), s)).filter(e => DISPLAY.has(e.event)).map(publicEvent); },
    async profile(address, options, s) { return profileFromEvents(await eventsFor('address', address.toLowerCase(), s), options); },
    async submissionOrder(taskId, worker, s) {
      const matches = (await eventsFor('task', String(taskId), s)).filter(e => e.event === 'SubmissionCommitted' && e.participant === worker.toLowerCase());
      if (matches.length !== 1 || matches[0].blockNumber > s.finalizedBlock) throw new PublicIndexError('INDEX_BUILDING', withoutManifest(s));
      const { blockNumber, transactionIndex, logIndex } = matches[0];
      return { blockNumber, transactionIndex, logIndex };
    },
  };
}
export function withoutManifest({ manifest, tail, ...progress }) { return progress; }
