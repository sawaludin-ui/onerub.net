// Server-only Office indexes. Cold build is O(total), NOT O(page size): the deployed
// contract has no accepted-work/name/status index. Each request advances at most one
// bounded chunk; clients retry INDEX_BUILDING. Redis checkpoints survive serverless
// cold starts. Without configured Redis this is process-local and cold starts rebuild.
// Retained snapshots last up to 5 minutes (4 fixed slots per kind; collisions evict
// earlier with SNAPSHOT_EXPIRED); new snapshots refresh after
// 15 seconds. Rows <=20,000 and serialized index <=8 MiB; capacity fails explicitly.
// Assignment ABI returns complete structs during indexing; evidence is discarded,
// never retained in the index or sent outside the selected page.
import { randomUUID } from "node:crypto";
import { integerParam, walletAddress } from "./request-validation.mjs";

const TTL = 300_000, FRESH = 15_000, MAX_ROWS = 20_000, MAX_BYTES = 8 * 1024 * 1024;
export class OfficePaginationError extends Error {
  constructor(message, status = 400, code = "INVALID_PAGINATION", extra = {}) {
    super(message); Object.assign(this, { status, code, ...extra });
  }
}
export function officePageParams(params, kind) {
  const people = kind === "people";
  const offset = integerParam(params, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integerParam(params, "limit", people ? 12 : 10, 1, people ? 12 : 50);
  const block = integerParam(params, "block", null, 1, Number.MAX_SAFE_INTEGER);
  const q = (params.get("q") || "").trim().toLowerCase();
  const rank = params.get("rank") ?? "All";
  const view = params.get("view") ?? "all";
  const address = params.get("address");
  if (offset === null || limit === null || (params.has("block") && block === null) ||
      q.length > 128 || (people && !/^(All|[0-4])$/.test(rank)) ||
      (!people && !["all", "pending", "mine"].includes(view)) ||
      (address !== null && !walletAddress(address)) || (!people && view === "mine" && !address))
    throw new OfficePaginationError("Invalid pagination, filter, wallet address, or snapshot block.");
  return { offset, limit, block, q, rank, view, address: address?.toLowerCase() ?? null };
}
export function officePageError(error) {
  const known = error instanceof OfficePaginationError;
  return Response.json({
    error: known ? error.message : "Live chain data is temporarily unavailable. Please retry.",
    code: known ? error.code : "CHAIN_UNAVAILABLE",
    ...(known && error.code === "INDEX_BUILDING" ? { indexed: error.indexed, total: error.total, readBlock: error.readBlock } : {}),
  }, { status: known ? error.status : 503, headers: { "Cache-Control": "no-store", ...(error.code === "INDEX_BUILDING" ? { "Retry-After": "1" } : {}) } });
}

// Reuse the existing REST adapter without depending on its marketplace key namespace.
// Environment values are only consumed by the adapter; never logged or returned.
export async function officeIndexStore() {
  if (!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) ||
      !(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)) return null;
  const { store } = await import("./marketplace-core.mjs");
  return {
    async get(key) { const value = await store.command("GET", key); return value ? JSON.parse(value) : null; },
    async put(key, value, { ttl = 300, nx = false, lockKey, owner } = {}) {
      if (lockKey) return Number(await store.command("EVAL", "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[3]); return 1", "2", lockKey, key, JSON.stringify(owner), JSON.stringify(value), String(ttl))) === 1;
      return await store.command("SET", key, JSON.stringify(value), "EX", String(ttl), ...(nx ? ["NX"] : [])) === "OK";
    },
    async release(key, owner) {
      await store.command("EVAL", "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", "1", key, JSON.stringify(owner));
    },
  };
}

export function createOfficePagination({ namespace = "test", storage = null, now = Date.now } = {}) {
  const memory = new Map(), running = new Map(), queries = new Map();
  const base = "office-index:v1:" + namespace;
  const key = (kind, suffix) => base + ":" + kind + ":" + suffix;
  const expired = () => new OfficePaginationError("Snapshot expired. Reload the first page.", 409, "SNAPSHOT_EXPIRED");
  function valid(entry, kind, block) {
    return entry?.version === 1 && entry.kind === kind && entry.readBlock === block &&
      Number.isSafeInteger(block) && block > 0 && entry.expires > now() &&
      Array.isArray(entry.rows) && entry.rows.length <= MAX_ROWS;
  }
  function remember(k, value) {
    memory.set(k, value);
    // 2 kinds x (4 snapshots + build + latest); bounded even across abandoned builds.
    while (memory.size > 12) memory.delete(memory.keys().next().value);
  }
  async function get(k) {
    const cached = memory.get(k);
    if (cached && cached.expires > now()) return cached;
    memory.delete(k);
    const value = await storage?.get(k);
    if (value && value.expires > now()) remember(k, value);
    return value;
  }
  async function put(k, value, lock = {}) {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES)
      throw new OfficePaginationError("Office index capacity exceeded.", 503, "INDEX_CAPACITY");
    if (storage && !await storage.put(k, value, { ttl: Math.max(1, Math.ceil((value.expires - now()) / 1000)), ...lock }))
      throw new OfficePaginationError("Office index lease expired. Retry shortly.", 503, "INDEX_BUILDING");
    remember(k, value);
  }
  async function snapshot(kind, source, block) {
    if (block !== null) {
      const found = await get(key(kind, "slot:" + (block % 4)));
      // Arbitrary historical blocks NEVER trigger scans or allocate cache entries.
      if (!valid(found, kind, block)) {
        const build = await get(key(kind, "build"));
        if (build?.readBlock === block && build.expires > now()) return advance(kind, source, block);
        if (block > await source.currentBlock()) throw new OfficePaginationError("Snapshot block is in the future.");
        throw expired();
      }
      return found;
    }
    const latest = await get(key(kind, "latest"));
    if (latest && latest.completed + FRESH > now()) {
      const found = await get(key(kind, "slot:" + (latest.readBlock % 4)));
      if (valid(found, kind, latest.readBlock)) return found;
    }
    if (running.has(kind)) return running.get(kind);
    const promise = advance(kind, source);
    running.set(kind, promise);
    try { return await promise; } finally { running.delete(kind); }
  }
  async function advance(kind, source, expectedBlock = null) {
    const lockKey = key(kind, "lock"), owner = randomUUID();
    if (storage && !await storage.put(lockKey, owner, { nx: true, ttl: 60 }))
      throw new OfficePaginationError("Office index is building. Retry shortly.", 503, "INDEX_BUILDING");
    try {
      // Always reread shared build state after acquiring the lease. A cold instance's
      // local checkpoint must never overwrite progress another instance persisted.
      const buildKey = key(kind, "build");
      if (storage) memory.delete(buildKey);
      let build = await get(buildKey);
      if (expectedBlock !== null && build?.readBlock !== expectedBlock) throw expired();
      const lock = { lockKey, owner };
      if (!build || build.expires <= now()) {
        const readBlock = await source.currentBlock();
        const total = Number(await source.count(kind, readBlock));
        if (!Number.isSafeInteger(total) || total < 0 || total > MAX_ROWS)
          throw new OfficePaginationError("Office index capacity exceeded.", 503, "INDEX_CAPACITY");
        build = { version: 1, kind, readBlock, total, rows: [], expires: now() + TTL };
      }
      const start = build.rows.length;
      if (start < build.total) {
        const size = Math.min(kind === "people" ? 25 : 50, build.total - start);
        const rows = await source.chunk(kind, start, size, build.readBlock);
        if (rows.length !== size)
          throw new OfficePaginationError("Office index read was incomplete.", 503, "INDEX_UNAVAILABLE");
        build = { ...build, rows: build.rows.concat(rows), expires: now() + TTL };
      }
      if (build.rows.length < build.total) {
        await put(buildKey, build, lock);
        throw new OfficePaginationError("Office index is building. Retry shortly.", 503, "INDEX_BUILDING", { indexed: build.rows.length, total: build.total, readBlock: build.readBlock });
      }
      const completed = now();
      const result = { ...build, completed, expires: completed + TTL,
        pendingTotal: kind === "assignments" ? build.rows.filter(row => row.status === 1).length : undefined,
        rows: kind === "people" ? build.rows.toSorted((a, b) => b.totalCorrect - a.totalCorrect || a.employeeNumber - b.employeeNumber) : build.rows };
      await put(key(kind, "slot:" + (result.readBlock % 4)), result, lock);
      await put(key(kind, "latest"), { readBlock: result.readBlock, completed, expires: result.expires }, lock);
      // Retire checkpoint: a new latest request after FRESH starts at a new block.
      await put(buildKey, { expires: now() }, lock);
      return result;
    } finally { if (storage) await storage.release(lockKey, owner); }
  }
  function filtered(snapshot, options) {
    const { kind, rows, readBlock } = snapshot;
    const filterKey = JSON.stringify([kind, readBlock, snapshot.completed, options.q, options.rank, options.view, options.address]);
    const cached = queries.get(filterKey);
    if (cached && cached.expires > now()) return cached.rows;
    const result = rows.filter(row => kind === "people"
      ? (options.rank === "All" || row.rank === Number(options.rank)) &&
        (!options.q || [row.address, row.agentId, row.rankName, String(row.employeeNumber)].some(v => v?.toLowerCase().includes(options.q)))
      : options.view === "all" || (options.view === "pending" ? row.status === 1 : row.employee.toLowerCase() === options.address));
    queries.set(filterKey, { rows: result, expires: snapshot.expires });
    while (queries.size > 32) queries.delete(queries.keys().next().value);
    return result;
  }
  return {
    async page(kind, options, source) {
      const snap = await snapshot(kind, source, options.block);
      const rows = filtered(snap, options), selected = rows.slice(options.offset, options.offset + options.limit);
      const data = kind === "people" ? selected : await source.details(selected, snap.readBlock);
      return { [kind === "people" ? "employees" : "assignments"]: data,
        total: rows.length, offset: options.offset, limit: options.limit,
        nextOffset: options.offset + selected.length < rows.length ? options.offset + selected.length : null,
        readBlock: snap.readBlock,
        ...(kind === "assignments" ? { pendingTotal: snap.pendingTotal } : {}),
      };
    },
  };
}
