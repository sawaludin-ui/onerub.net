// Client-only public participant reads; no wallet access, signing, private reports or evaluator calls.
const ADDRESS = /^0x[0-9a-f]{40}$/i;
export function participantIdentity(input) {
  const id = String(input.id ?? ''), chainId = Number(input.chainId), contract = String(input.contract ?? '').toLowerCase(), count = Number(input.count);
  if (!/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(chainId) || chainId < 1 || !ADDRESS.test(contract) || !Number.isSafeInteger(count) || count < 0 || count > 64) throw Error('Invalid participant identity');
  return { id, chainId, contract, count, key: [chainId, contract, id, count].join(':') };
}
export function normalizeParticipants(body, input) {
  const identity = participantIdentity(input);
  if (!body || String(body.taskId) !== identity.id || Number(body.chainId) !== identity.chainId || String(body.escrowAddress).toLowerCase() !== identity.contract || body.order !== 'on-chain-submission-append-order' || body.identityBasis !== 'registry-at-read-block-not-historical' || !Number.isSafeInteger(body.readBlock) || body.readBlock < 1 || !Number.isSafeInteger(body.total) || body.total < 0 || body.total > 64 || !Array.isArray(body.participants) || body.participants.length !== body.total) throw Error('Participant response does not match task');
  const seen = new Set();
  const rows = body.participants.map((row, index) => {
    if (!row || row.ordinal !== index + 1 || !ADDRESS.test(row.wallet) || seen.has(row.wallet.toLowerCase()) || !Number.isSafeInteger(row.submittedAt) || row.submittedAt < 1 || !['resolved', 'unregistered', 'unknown'].includes(row.identityStatus)) throw Error('Invalid participant order');
    seen.add(row.wallet.toLowerCase());
    if (row.agentId !== null && (row.identityStatus !== 'resolved' || typeof row.agentId !== 'string' || row.agentId.length > 259 || !row.agentId.endsWith('.ai') || [...row.agentId].some(character => character.charCodeAt(0) <= 32 || character === '<' || character === '>'))) throw Error('Invalid public Agent ID');
    if (row.identityStatus === 'resolved' && !row.agentId) throw Error('Missing resolved Agent ID');
    return Object.freeze({ ordinal: row.ordinal, wallet: row.wallet, agentId: row.agentId, identityStatus: row.identityStatus, submittedAt: row.submittedAt });
  });
  return Object.freeze({ rows: Object.freeze(rows), total: body.total, readBlock: body.readBlock, identityBasis: body.identityBasis });
}
export function shortWallet(wallet) { return wallet ? wallet.slice(0, 6) + '…' + wallet.slice(-4) : ''; }
export function participantTime(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || !Number.isFinite(new Date(seconds * 1000).getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(seconds * 1000)) + ' WIB';
}
export function participantLabel(state, index) {
  const row = state.rows?.[index];
  if (row) return row.agentId || shortWallet(row.wallet);
  return state.status === 'error' ? 'Participants unavailable' : state.status === 'ready' ? 'Awaiting confirmation' : 'Loading .ai…';
}
export function createParticipantLoader({ fetcher = (...args) => fetch(...args), now = Date.now, ttl = 45000, errorTtl = 4000, maxEntries = 64, maxConcurrent = 3, timeoutMs = 50000 } = {}) {
  const cache = new Map(), waiting = [];
  let running = 0;
  async function acquire() { if (running < maxConcurrent) { running++; return; } await new Promise(resolve => waiting.push(resolve)); }
  function release() { const next = waiting.shift(); if (next) next(); else running--; }
  return {
    load(input) {
      const identity = participantIdentity(input), prior = cache.get(identity.key);
      if (prior && (prior.pending || prior.expires > now())) return prior.promise;
      if (cache.size >= maxEntries && !cache.has(identity.key)) {
        const old = [...cache].find(([, item]) => !item.pending);
        if (old) cache.delete(old[0]); else return Promise.reject(Error('Participant reads are busy. Retry shortly.'));
      }
      const entry = { pending: true, expires: 0, promise: null };
      const request = async () => {
        await acquire();
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const query = new URLSearchParams({ chainId: String(identity.chainId), escrowAddress: identity.contract });
          const response = await fetcher('/api/marketplace/tasks/' + identity.id + '/participants?' + query, { cache: 'no-store', signal: controller.signal, headers: { accept: 'application/json' } });
          if (!response.ok) throw Error('Public participant read unavailable. Retry shortly.');
          const data = normalizeParticipants(await response.json(), identity);
          entry.expires = now() + (data.rows.some(row => row.identityStatus === 'unknown') || data.total < identity.count ? errorTtl : ttl);
          return data;
        } catch { entry.expires = now() + errorTtl; throw Error('Public participant read unavailable. Retry shortly.'); }
        finally { entry.pending = false; clearTimeout(timeout); release(); }
      };
      entry.promise = request(); cache.set(identity.key, entry); return entry.promise;
    },
  };
}
export const participantLoader = createParticipantLoader();
