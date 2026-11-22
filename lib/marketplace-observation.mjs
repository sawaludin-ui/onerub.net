import { ZeroAddress, id, zeroPadValue, toBeHex } from 'ethers';
import { artifactKey, capabilities, deployment, store, submission, taskView, withChain } from './marketplace-core.mjs';
import { validatedArtifact } from './marketplace-service.mjs';

// Only public events and bounded status labels leave this module. No report text.
export async function taskEvents(taskId, { block } = {}) {
  return withChain(async (contract, provider, snapshot) => {
    const filter = { address: deployment.address, topics: [[id('TaskCreated(uint256,address,address,uint256,uint64,uint64,bytes32,bytes32)'), id('Settled(uint256,address,address,uint256,uint256)'), id('Refunded(uint256,address,uint256)'), id('Cancelled(uint256,address,uint256)')], zeroPadValue(toBeHex(taskId), 32)] };
    const logs = [];
    for (let from = deployment.blockNumber; from <= snapshot; from += 2000) {
      const to = Math.min(snapshot, from + 1999);
      const key = `events:${taskId}:${from}:${to}`;
      let batch = capabilities().privateStorage ? await store.get(key) : null;
      if (!batch) {
        const raw = await provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
        batch = raw.map(log => { const parsed = contract.interface.parseLog(log); return { event: parsed.name, transactionHash: log.transactionHash, blockNumber: log.blockNumber,
          ...(parsed.name === 'TaskCreated' ? { bounty: String(parsed.args.bounty) } : {}),
          ...(parsed.name === 'Settled' ? { payout: String(parsed.args.payout), fee: String(parsed.args.fee) } : {}) }; });
        if (capabilities().privateStorage && to < snapshot - 12) await store.put(key, batch, { ttl: 86400 });
      }
      logs.push(...batch);
    }
    return logs;
  }, { block });
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
  return withChain(async (contract, provider, snapshot) => {
    const count = Number(await contract.nextTaskId({ blockTag: snapshot })) - 1;
    const history = [];
    const summary = { requested: 0, submitted: 0, won: 0, paidTasks: 0 };
    for (let top = count; top > 0; top -= 6) {
      const batch = await Promise.all(Array.from({ length: Math.min(6, top) }, (_, i) => top - i).map(async taskId => {
        const [t, phase, sub] = await Promise.all([contract.getTask(taskId, { blockTag: snapshot }), contract.phaseOf(taskId, { blockTag: snapshot }), contract.getSubmission(taskId, who, { blockTag: snapshot })]);
        const task = { ...taskView(taskId, t, phase), readBlock: snapshot };
        const requested = task.requester.toLowerCase() === who.toLowerCase(), submitted = sub.exists, won = task.winner !== ZeroAddress && task.winner.toLowerCase() === who.toLowerCase();
        return { task, requested, submitted, won };
      }));
      for (const r of batch) {
        summary.requested += Number(r.requested); summary.submitted += Number(r.submitted); summary.won += Number(r.won); summary.paidTasks += Number(r.won && r.task.phase === 'Settled');
        if (r.requested || r.submitted) history.push({ ...r.task, role: r.requested ? 'requester' : r.won ? 'winner' : 'worker' });
      }
    }
    const registry = new (await import('ethers')).Contract(deployment.registry, ['function balanceOf(address) view returns(uint256)'], provider);
    return { activeDeployment: deployment, address: who, eligible: (await registry.balanceOf(who, { blockTag: snapshot })) > 0n, summary, history: history.slice(offset, offset + limit), totalHistory: history.length, nextOffset: offset + limit < history.length ? offset + limit : null, readBlock: snapshot, reputationBasis: 'confirmed-public-marketplace-history-no-invented-score', legacyOffice: { separate: true, url: '/playground' } };
  }, { block });
}
