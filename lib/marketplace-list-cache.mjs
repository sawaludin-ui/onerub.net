// Node.js: bounded public task-list snapshots; no artifact or authorization records.
import { createHash, randomUUID } from 'node:crypto';

export class ListIndexError extends Error {
  constructor(code, block) {
    super(code === 'INDEX_BUILDING' ? 'Task search index is building. Retry at the same snapshot block.' : 'Task search snapshot exceeds server cache capacity.');
    this.code = code; this.status = 503; this.readBlock = block;
  }
}

export function createTaskListCache({ storage, now = Date.now, ttlSeconds = 300, maxEntries = 8,
  maxBytes = 32 * 1024 * 1024, maxEntryBytes = 8 * 1024 * 1024, maxRows = 10000,
  budgetMs = 12000 } = {}) {
  const memory = new Map(), flights = new Map(), recent = new Map();
  let memoryBytes = 0;
  const digest = key => createHash('sha256').update(key).digest('hex');
  const prune = () => {
    for (const [key, entry] of memory) if (entry.state.expiresAt <= now()) { memory.delete(key); memoryBytes -= entry.bytes; }
  };
  const remember = (key, state) => {
    prune();
    const bytes = Buffer.byteLength(JSON.stringify(state));
    if (bytes > Math.min(maxEntryBytes, maxBytes) || state.rows.length > maxRows) throw new ListIndexError('INDEX_CAPACITY', state.block);
    if (memory.has(key)) { memoryBytes -= memory.get(key).bytes; memory.delete(key); }
    while (memory.size && (memory.size >= maxEntries || memoryBytes + bytes > maxBytes)) {
      const oldest = memory.keys().next().value; memoryBytes -= memory.get(oldest).bytes; memory.delete(oldest);
    }
    memory.set(key, { state: { ...state, rows: state.rows.slice() }, bytes }); memoryBytes += bytes;
  };
  async function materialize(key, { block, total, readBatch }) {
    if (!Number.isSafeInteger(total) || total < 0 || total > maxRows) throw new ListIndexError('INDEX_CAPACITY', block);
    if (flights.has(key)) return flights.get(key);
    // Even distinct abusive queries cannot create an unbounded set of concurrent builds.
    if (flights.size >= maxEntries) throw new ListIndexError('INDEX_BUILDING', block);
    const work = (async () => {
      prune();
      // Fixed hash slots bound Redis keys/bytes too; a collision evicts, never mixes, snapshots.
      const hash = digest(key), slot = parseInt(hash.slice(0, 8), 16) % maxEntries;
      const sharedKey = 'list-index:v2:' + slot, leaseKey = sharedKey + ':lease', owner = randomUUID();
      let shared = Boolean(storage?.putIfLease), leased = false, state;
      try {
        state = memory.get(key)?.state;
        if (state?.complete) { remember(key, state); return state; }
        if (shared) {
          try {
            const candidate = await storage.get(sharedKey);
            if (candidate?.key === hash && candidate.block === block && candidate.total === total && candidate.expiresAt > now()
              && Array.isArray(candidate.rows) && candidate.rows.length <= maxRows
              && Number.isSafeInteger(candidate.cursor) && candidate.cursor >= 0 && candidate.cursor <= total
              && (!candidate.complete || candidate.cursor === total)) state = candidate;
          } catch { shared = false; }
        }
        state ||= memory.get(key)?.state;
        if (state?.complete) { remember(key, state); return state; }
        if (shared) {
          try { leased = await storage.put(leaseKey, owner, { nx: true, ttl: 60 }); }
          catch { shared = false; }
          if (shared && !leased) throw new ListIndexError('INDEX_BUILDING', block);
        }
        state ||= { key: hash, block, total, cursor: 0, rows: [], complete: false, expiresAt: now() + ttlSeconds * 1000 };
        // Work on a copy so a failed batch never corrupts the last saved checkpoint.
        state = { ...state, rows: state.rows.slice() };
        const deadline = now() + budgetMs;
        let rowBytes = Buffer.byteLength(JSON.stringify(state.rows));
        const save = async () => {
          // In-progress builds survive across requests; idle checkpoints and completed indexes expire in five minutes.
          state.expiresAt = now() + ttlSeconds * 1000;
          remember(key, state);
          if (shared) {
            let published;
            try { published = await storage.putIfLease(sharedKey, state, { leaseKey, owner,
              ttl: Math.max(1, Math.ceil((state.expiresAt - now()) / 1000)) }); }
            catch { shared = false; }
            if (shared && !published) throw new ListIndexError('INDEX_BUILDING', block);
          }
        };
        while (state.cursor < total) {
          const count = Math.min(6, total - state.cursor);
          const rows = await readBatch(state.cursor, count);
          state.rows.push(...rows); state.cursor += count;
          rowBytes += Buffer.byteLength(JSON.stringify(rows));
          if (state.rows.length > maxRows || rowBytes > Math.min(maxEntryBytes, maxBytes)) throw new ListIndexError('INDEX_CAPACITY', block);
          if (state.cursor % 60 === 0 || now() >= deadline) await save();
          if (now() >= deadline && state.cursor < total) throw new ListIndexError('INDEX_BUILDING', block);
        }
        state.complete = true; await save(); return state;
      } finally {
        if (leased) { try { await storage.release(leaseKey, owner); } catch { /* Lease expires independently. */ } }
      }
    })();
    flights.set(key, work);
    try { return await work; } finally { flights.delete(key); }
  }
  async function recentBlock(namespace, head, minBlock = 0) {
    const valid = value => value?.namespace === namespace && value.expiresAt > now()
      && Number.isSafeInteger(value.block) && value.block >= minBlock && value.block <= head;
    const prior = recent.get(namespace);
    if (valid(prior)) return prior.block;
    const slot = parseInt(digest(namespace).slice(0, 8), 16) % maxEntries;
    const pointerKey = 'list-latest:v1:' + slot;
    let pointer;
    if (storage) {
      try {
        const shared = await storage.get(pointerKey);
        if (valid(shared)) pointer = shared;
        else {
          const proposed = { namespace, block: head, expiresAt: now() + 15000 };
          if (await storage.put(pointerKey, proposed, { nx: true, ttl: 15 })) pointer = proposed;
          else { const winner = await storage.get(pointerKey); if (valid(winner)) pointer = winner; }
        }
      } catch { /* No Redis: the same bounded process-local pointer applies. */ }
    }
    pointer ||= { namespace, block: head, expiresAt: now() + 15000 };
    recent.delete(namespace);
    while (recent.size >= maxEntries) recent.delete(recent.keys().next().value);
    recent.set(namespace, pointer);
    return pointer.block;
  }
  return { materialize, recentBlock, stats: () => ({ entries: memory.size, bytes: memoryBytes, flights: flights.size }) };
}

export async function readTaskListPage({ contract, block, offset = 0, limit = 12, q = '', phase = 'All',
  namespace, cache, taskView, readMetadata = async () => null, hashMetadata }) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw Object.assign(new Error('Invalid task pagination.'), { status: 400, code: 'INVALID_REQUEST' });
  const total = Number(await contract.nextTaskId({ blockTag: block })) - 1;
  if (!Number.isSafeInteger(total) || total < 0) throw new ListIndexError('INDEX_CAPACITY', block);
  const terms = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = Boolean(q || phase !== 'All');
  const readBatch = async (cursor, count) => Promise.all(Array.from({ length: count }, async (_, i) => {
    const id = total - cursor - i;
    const [task, taskPhase] = await Promise.all([contract.getTask(id, { blockTag: block }), contract.phaseOf(id, { blockTag: block })]);
    const row = { ...taskView(id, task, taskPhase), readBlock: block };
    if (!filtered) return row;
    // Only hash-verified PUBLIC metadata contributes to the private server-side search index.
    const record = await readMetadata(row.id);
    const metadata = record && hashMetadata(record.metadata).toLowerCase() === row.criteriaHash.toLowerCase() ? record.metadata : null;
    const search = [row.id, row.requester, row.winner, row.phase, metadata?.title, metadata?.description, metadata?.category].join(' ').toLowerCase();
    return { task: row, search };
  }));
  let tasks, matchedTasks;
  if (filtered) {
    // One raw public index per deployment/block: changing search or phase never rescans RPC.
    const key = JSON.stringify([namespace, block]);
    const state = await cache.materialize(key, { block, total, readBatch });
    const matched = state.rows.filter(entry => (phase === 'All' || entry.task.phase === phase)
      && terms.every(term => entry.search.includes(term)));
    matchedTasks = matched.length; tasks = matched.slice(offset, offset + limit).map(entry => entry.task);
  } else {
    tasks = [];
    for (let cursor = offset; cursor < Math.min(total, offset + limit); cursor += 6)
      tasks.push(...await readBatch(cursor, Math.min(6, total - cursor, offset + limit - cursor)));
    matchedTasks = total;
  }
  return { totalTasks: total, matchedTasks, tasks, readBlock: block,
    nextOffset: offset + tasks.length < matchedTasks ? offset + tasks.length : null };
}
