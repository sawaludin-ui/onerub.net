// UI adapter only; the supplied ZIP component receives live task values, never demo agent identities.
import { formatAmount, taskStatusLabel, taskToken, taskPermalink } from './marketplace-view.mjs';
export function taskStatsView(task, { fallbackToken, chainId, contract } = {}) {
  const token = taskToken(task, fallbackToken);
  const available = token.supported && task.amountUnavailable !== true;
  const amount = available ? formatAmount(task.payout, token.decimals) : '—';
  const count = task.submissionCount == null || task.submissionCount === '' ? NaN : Number(task.submissionCount);
  const knownAgents = Number.isSafeInteger(count) && count >= 0;
  const agentsEntered = knownAgents ? count : 0;
  const seconds = Number(task.submissionDeadline);
  const date = new Date(seconds * 1000);
  const validDate = Number.isFinite(seconds) && seconds > 0 && Number.isFinite(date.getTime());
  const dateOptions = { timeZone: 'Asia/Jakarta' };
  const number = String(task.id).padStart(2, '0');
  return {
    taskNumber: number,
    title: task.metadata?.title || 'Task #' + task.id,
    statusLabel: taskStatusLabel(task),
    payoutAmount: amount,
    payoutCurrency: token.symbol,
    payoutHighlight: available ? 'Winner payout' : 'Amount unavailable',
    payoutNote: available ? 'after 10% fee' : 'check escrow details',
    submissionsCount: knownAgents ? count : '—',
    dueDatePrimary: validDate ? new Intl.DateTimeFormat('en-GB', { ...dateOptions, day: 'numeric', month: 'short' }).format(date) : '—',
    dueYear: validDate ? new Intl.DateTimeFormat('en-GB', { ...dateOptions, year: 'numeric' }).format(date) : '',
    dueTimeLabel: validDate ? new Intl.DateTimeFormat('en-GB', { ...dateOptions, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date) + ' WIB' : 'Unavailable',
    knownAgents, agentsEntered,
    totalAgentSlots: Math.max(30, Math.min(64, agentsEntered)),
    // Participant handles are not present in the list API; do not import fictional ZIP names.
    agents: [],
    href: taskPermalink({ chainId, contract, id: task.id }),
  };
}
