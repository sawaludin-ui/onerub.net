import { Contract } from 'ethers';
import { artifactKey, capabilities, deployment, store, storePrefix, submission, taskView, withChain, MarketplaceError } from './marketplace-core.mjs';
import { validatedArtifact } from './marketplace-service.mjs';
import { createPublicEventIndex, redisIndexStorage, PublicIndexError, withoutManifest } from './marketplace-event-index.mjs';

function indexFor(contract, provider, rangeSize = 2000) {
  if (!capabilities().privateStorage) throw new PublicIndexError('INDEX_BUILDING', { status: 'unavailable', code: 'STORAGE_UNAVAILABLE' });
  return createPublicEventIndex({ storage: redisIndexStorage(store, storePrefix), provider, parseLog: log => contract.interface.parseLog(log), deployment, range: rangeSize });
}
function indexFailure(error) {
  const e = new MarketplaceError(error instanceof PublicIndexError ? error.message : 'Public event history is temporarily unavailable.', 503, error.code === 'INDEX_CAPACITY' ? 'INDEX_CAPACITY' : 'INDEX_BUILDING');
  e.index = error.index || { status: 'unavailable' };
  // A provider-specific log/RPC failure must still let withChain try the next endpoint.
  // Capacity errors are deterministic and therefore not provider-retryable.
  e.providerRetryable = !(error instanceof PublicIndexError);
  return e;
}
// Ops/scheduler bootstrap: never loops to genesis completion inside a request.
export async function advancePublicEventIndex({ block, rangeSize = 2000 } = {}) {
  if (!Number.isSafeInteger(rangeSize) || rangeSize < 1 || rangeSize > 10000) throw new MarketplaceError('Invalid index range.', 400, 'INVALID_INDEX_RANGE');
  try {
    return await withChain(async (contract, provider, snapshot) => {
      try { return withoutManifest(await indexFor(contract, provider, rangeSize).advance(snapshot)); }
      catch (e) { throw indexFailure(e); }
    }, { block });
  } catch (e) { return { ...(e.index || { status: 'unavailable' }), code: e.code || 'INDEX_BUILDING' }; }
}
export async function taskEvents(taskId, { block } = {}) {
  return withChain(async (contract, provider, snapshot) => {
    try { const index = indexFor(contract, provider); return await index.taskEvents(taskId, await index.snapshot(snapshot)); }
    catch (e) { throw indexFailure(e); }
  }, { block });
}
export async function readSubmissionOrder(taskId, worker, { snapshotBlock } = {}) {
  return withChain(async (contract, provider, snapshot) => {
    try { const index = indexFor(contract, provider); return await index.submissionOrder(taskId, worker, await index.snapshot(snapshot)); }
    catch (e) { throw indexFailure(e); }
  }, { block: snapshotBlock });
}

export async function observation(task, { storage = store, events, readSubmission = submission, storageEnabled = capabilities().privateStorage } = {}) {
  const history = events || await taskEvents(task.id, { block: task.readBlock });
  const funded = history.find(e => e.event === 'TaskCreated');
  const settlement = history.find(e => e.event === 'Settled');
  const decision = storageEnabled ? await storage.get('decision:' + task.id) : null;
  let deliveryStatus = task.phase === 'Settled' ? 'unavailable' : 'locked-until-settlement';
  if (settlement && task.readBlock < settlement.blockNumber + 3) deliveryStatus = 'pending-confirmations';
  else if (task.phase === 'Settled' && storageEnabled) {
    try {
      const record = await storage.get(artifactKey(task.id, task.winner));
      const committed = await readSubmission(task.id, task.winner, { block: task.readBlock });
      validatedArtifact(record, task.id, task.winner, committed);
      deliveryStatus = 'available-to-requester-and-winner';
    } catch { deliveryStatus = 'recovery-required'; }
  }
  const bounty = funded?.bounty;
  return {
    ...(bounty ? { bounty, fee: String(BigInt(bounty) / 10n), payout: String(BigInt(bounty) - BigInt(bounty) / 10n), amountUnavailable: false } : {}),
    observation: { paymentStatus: task.phase === 'Settled' ? 'paid-on-chain' : ['Refunded', 'Cancelled'].includes(task.phase) ? 'returned-on-chain' : 'not-settled',
      deliveryStatus, decisionStatus: ['winner', 'no_acceptable_submission'].includes(decision?.outcome) ? decision.outcome : decision ? 'unverified' : 'not-evaluated',
      settlementTxHash: settlement?.transactionHash || null, settlementBlock: settlement?.blockNumber || null,
      events: history },
  };
}


export async function agentProfile(who, { block, offset = 0, limit = 24 } = {}) {
  if (!/^0x[0-9a-f]{40}$/i.test(who) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new MarketplaceError('Invalid profile pagination.', 400, 'INVALID_PROFILE');
  return withChain(async (contract, provider, snapshot) => {
    let page, indexState;
    try {
      const index = indexFor(contract, provider), s = await index.snapshot(snapshot);
      page = await index.profile(who, { offset, limit }, s); indexState = withoutManifest(s);
    } catch (e) { throw indexFailure(e); }
    // Hydrate only selected indexed IDs. Phase and payout remain authoritative chain reads.
    const history = await Promise.all(page.rows.map(async r => {
      const [t, phase] = await Promise.all([contract.getTask(r.id, { blockTag: snapshot }), contract.phaseOf(r.id, { blockTag: snapshot })]);
      return { ...taskView(r.id, t, phase), readBlock: snapshot, role: r.requested ? 'requester' : r.won ? 'winner' : 'worker' };
    }));
    const registry = new Contract(deployment.registry, ['function balanceOf(address) view returns(uint256)'], provider);
    return { activeDeployment: deployment, address: who, eligible: (await registry.balanceOf(who, { blockTag: snapshot })) > 0n, summary: page.summary, history,
      totalHistory: page.totalHistory, nextOffset: page.nextOffset, readBlock: snapshot, index: indexState,
      reputationBasis: 'confirmed-public-marketplace-history-no-invented-score', legacyOffice: { separate: true, url: '/playground' } };
  }, { block });
}
