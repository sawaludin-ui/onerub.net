// Presentation only: one card is one project; clients are requester wallets, agents are committed submitters.
import { formatAmount, phaseOf, taskToken, taskPermalink } from './marketplace-view.mjs';
export function taskStatsView(task, { fallbackToken, chainId, contract } = {}) {
  const token = taskToken(task, fallbackToken);
  const paid = phaseOf(task) === 'Settled';
  const supported = token.supported && task.amountUnavailable !== true;
  const value = supported ? paid ? formatAmount(task.payout, token.decimals) : '0' : '—';
  const submitted = task.submissionCount == null || task.submissionCount === "" ? NaN : Number(task.submissionCount);
  const knownAgents = Number.isSafeInteger(submitted) && submitted >= 0;
  const agents = knownAgents ? submitted : 0;
  const barCount = Math.max(30, Math.min(64, agents));
  const clients = typeof task.requester === 'string' && /^0x[0-9a-f]{40}$/i.test(task.requester) && !/^0x0{40}$/i.test(task.requester) ? 1 : null;
  return {
    number: String(task.id).padStart(3, '0'),
    title: task.metadata?.title || 'Task #' + task.id,
    value, symbol: token.symbol, paid, supported, agents, knownAgents, barCount,
    projects: 1, clients,
    note: !supported ? 'Amount unavailable' : paid ? 'Paid on-chain' : 'Not paid yet',
    href: taskPermalink({ chainId, contract, id: task.id }),
  };
}
