// Server-only public participant reads; BSC V2 snapshots, no event scans or wallet operations.
import { Contract, getAddress, ZeroAddress } from "ethers";
import { deployment, MarketplaceError, taskId, withChain } from "./marketplace-core.mjs";

const MAX_PARTICIPANTS = 64;
const CONCURRENCY = 6;
const CACHE_LIMIT = 128;
const INFLIGHT_LIMIT = 8;
const IDENTITY_ABI = ["function handleOf(address) view returns(string)"];
const rpcError = () => new MarketplaceError("Public participants are temporarily unavailable.", 503, "PARTICIPANTS_UNAVAILABLE");
const invalidSnapshot = () => new MarketplaceError("Invalid confirmed snapshot block.", 400, "INVALID_SNAPSHOT");
const invalidData = () => new MarketplaceError("The participant snapshot could not be verified.", 503, "PARTICIPANTS_INCONSISTENT");

function integer(value, max = Number.MAX_SAFE_INTEGER) {
  const text = String(value);
  if (!/^\d{1,16}$/.test(text)) throw invalidData();
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) throw invalidData();
  return number;
}
function wallet(value) {
  try {
    const result = getAddress(value);
    if (result === ZeroAddress) throw invalidData();
    return result;
  } catch { throw invalidData(); }
}
function snapshot(value, active) {
  if (value === undefined) return undefined;
  if (!/^\d{1,16}$/.test(String(value))) throw invalidSnapshot();
  const block = Number(value);
  if (!Number.isSafeInteger(block) || block < active.blockNumber) throw invalidSnapshot();
  return block;
}

export function participantQuery(params, active = deployment) {
  for (const key of ["chainId", "escrowAddress", "contract", "block"]) {
    if (params.getAll(key).length > 1)
      throw new MarketplaceError("Duplicate participant query selector.");
  }
  if ((params.has("chainId") && params.get("chainId") !== String(active.chainId)) ||
      ["escrowAddress", "contract"].some(key => params.has(key) && params.get(key).toLowerCase() !== active.address.toLowerCase()))
    throw new MarketplaceError("This marketplace deployment is not active. Use the exact chain and escrow identity.", 409, "DEPLOYMENT_MISMATCH");
  return { block: snapshot(params.has("block") ? params.get("block") : undefined, active) };
}

function identityView(handle) {
  if (handle === "") return { agentId: null, identityStatus: "unregistered" };
  // Do not truncate/normalize untrusted names into a different identity.
  if (typeof handle !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,254}[a-z0-9])?$/.test(handle))
    return { agentId: null, identityStatus: "unknown" };
  return { agentId: handle + ".ai", identityStatus: "resolved" };
}

async function mapBounded(items, fn) {
  const rows = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      rows[index] = await fn(items[index], index);
    }
  }));
  return rows;
}

// Injection is for local read-only fixtures; production always uses the active manifest and withChain.
export function createParticipantReader({
  chain = withChain,
  active = deployment,
  registry = provider => new Contract(active.registry, IDENTITY_ABI, provider),
  now = Date.now,
  budgetMs = 45000,
  callTimeoutMs = 8000,
} = {}) {
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 45000 ||
      !Number.isInteger(callTimeoutMs) || callTimeoutMs < 1 || callTimeoutMs > 8000)
    throw new Error("Invalid participant read budget.");
  const cache = new Map(), inflight = new Map();
  let runningCalls = 0;
  const waiting = [];
  async function acquire() {
    if (runningCalls >= CONCURRENCY) await new Promise(resolve => waiting.push(resolve));
    else runningCalls++;
    return () => {
      const next = waiting.shift();
      if (next) next();
      else runningCalls--;
    };
  }

  async function load(id, requestedBlock) {
    let expired = false, provider;
    const end = now() + budgetMs;
    const check = () => { if (expired || now() >= end) throw rpcError(); };
    const destroy = () => { try { provider?.destroy(); } catch { /* no public provider details */ } };
    async function call(fn) {
      check();
      const release = await acquire();
      let timer;
      try {
        check();
        return await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, reject) => {
            timer = setTimeout(() => { destroy(); reject(rpcError()); }, Math.min(callTimeoutMs, Math.max(1, end - now())));
          }),
        ]);
      } finally { clearTimeout(timer); release(); }
    }
    let deadline;
    try {
      const outcome = await Promise.race([
        chain(async (contract, p, block) => {
          provider = p;
          // Returning errors prevents withChain from repeating a partially read 64-row batch.
          try {
            check();
            if (!Number.isSafeInteger(block) || block < active.blockNumber) throw invalidSnapshot();
            if (requestedBlock !== undefined) {
              const head = integer(await call(() => p.getBlockNumber()));
              if (block !== requestedBlock || block > head - 3) throw invalidSnapshot();
            }
            const tag = { blockTag: block };
            const task = await call(() => contract.getTask(id, tag));
            if (integer(task.status, 4) === 0)
              throw new MarketplaceError("Task not found.", 404, "NOT_FOUND");
            wallet(task.requester);
            const total = integer(task.submissionCount, MAX_PARTICIPANTS);
            const raw = await call(() => contract.getSubmittersPage(id, 0, MAX_PARTICIPANTS, tag));
            if (!Array.isArray(raw) || raw.length !== total) throw invalidData();
            const wallets = raw.map(wallet);
            if (new Set(wallets.map(value => value.toLowerCase())).size !== total) throw invalidData();
            // Only the explicitly public timestamp is retained from the submission struct.
            const participants = await mapBounded(wallets, async (address, index) => {
              const submission = await call(() => contract.getSubmission(id, address, tag));
              if (submission.exists !== true) throw invalidData();
              const submittedAt = integer(submission.submittedAt);
              if (submittedAt < 1) throw invalidData();
              return { ordinal: index + 1, wallet: address, agentId: null, identityStatus: "unknown", submittedAt };
            });
            let identityFailed = false, identity;
            try { if (total) identity = registry(p); } catch { identityFailed = true; }
            await mapBounded(participants, async row => {
              if (identityFailed) return;
              try {
                const handle = await call(() => identity.handleOf(row.wallet, tag));
                Object.assign(row, identityView(handle));
                // Invalid registry output is unknown, not a fabricated/truncated display name.
              } catch { identityFailed = true; }
            });
            check();
            return { value: {
              taskId: id, chainId: active.chainId, escrowAddress: active.address, readBlock: block, total,
              order: "on-chain-submission-append-order",
              identityBasis: "registry-at-read-block-not-historical", participants,
            } };
          } catch (error) { return { error }; }
        }, { confirmations: 3, ...(requestedBlock === undefined ? {} : { block: requestedBlock }) }),
        new Promise((_, reject) => {
          deadline = setTimeout(() => { expired = true; destroy(); reject(rpcError()); }, budgetMs);
        }),
      ]);
      if (outcome.error) throw outcome.error;
      return outcome.value;
    } catch (error) {
      // Never reflect raw RPC/registry messages or decoded submission objects into HTTP errors.
      const safe = {
        INVALID_SNAPSHOT: ["Invalid confirmed snapshot block.", 400],
        NOT_FOUND: ["Task not found.", 404],
        PARTICIPANTS_INCONSISTENT: ["The participant snapshot could not be verified.", 503],
      }[error?.code];
      if (error instanceof MarketplaceError && safe) throw new MarketplaceError(safe[0], safe[1], error.code);
      throw rpcError();
    } finally { clearTimeout(deadline); expired = true; }
  }

  return async function readParticipants(value, { block } = {}) {
    const id = taskId(value), requestedBlock = snapshot(block, active);
    const key = active.chainId + ":" + active.address.toLowerCase() + ":" + id + ":" + (requestedBlock ?? "confirmed");
    const entry = cache.get(key);
    if (entry && entry.expires > now()) {
      cache.delete(key); cache.set(key, entry);
      return structuredClone(entry.value);
    }
    cache.delete(key);
    if (inflight.has(key)) return structuredClone(await inflight.get(key));
    if (inflight.size >= INFLIGHT_LIMIT)
      throw new MarketplaceError("Public participant reads are busy. Please retry.", 503, "PARTICIPANTS_BUSY");
    const promise = load(id, requestedBlock);
    inflight.set(key, promise);
    try {
      const result = await promise;
      for (const [oldKey, item] of cache) if (item.expires <= now()) cache.delete(oldKey);
      while (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
      const ttl = result.participants.some(row => row.identityStatus === "unknown") ? 5000 : 45000;
      cache.set(key, { value: result, expires: now() + ttl });
      return structuredClone(result);
    } finally { inflight.delete(key); }
  };
}

export const readTaskParticipants = createParticipantReader();
