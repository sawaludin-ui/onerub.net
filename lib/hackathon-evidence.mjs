// Public-chain evidence helpers; no wallet signing, secrets or organizer eligibility claims.
import { getAddress, isAddress } from 'ethers';

export const SUBMISSION_START = Date.parse('2026-11-18T08:00:00Z') / 1000;
export const SUBMISSION_END = Date.parse('2026-12-09T08:00:00Z') / 1000;
export const RULES_URL = 'https://www.binance.com/en/support/announcement/detail/95f5dbe0ea674a48a739b59e046648bf';

export function checkedAddress(value) {
  if (!isAddress(value)) throw Error('A full valid EVM address is required.');
  return getAddress(value);
}
export async function firstBlockAt(provider, timestamp, head) {
  let low = 0, high = head;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const block = await provider.getBlock(mid);
    if (!block) throw Error('Block history unavailable; cannot establish campaign window.');
    if (Number(block.timestamp) < timestamp) low = mid + 1;
    else high = mid;
  }
  return low;
}
export function distinctInteractions(records, start = SUBMISSION_START, end = SUBMISSION_END) {
  const seen = new Set(), accepted = [];
  for (const record of records) {
    if (Number(record.timestamp) < start || Number(record.timestamp) >= end || record.status !== 1) continue;
    const contract = checkedAddress(record.contract), from = checkedAddress(record.from);
    if (!/^0x[0-9a-f]{64}$/i.test(record.transactionHash)) throw Error('Invalid transaction hash.');
    const key = contract.toLowerCase() + ':' + record.transactionHash.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); accepted.push({ ...record, contract, from });
  }
  return accepted;
}
export function summarizeEvidence(records, holderResults, contracts) {
  const interactions = distinctInteractions(records);
  const byAddress = new Map();
  for (const record of interactions) {
    const key = record.from.toLowerCase();
    const entry = byAddress.get(key) || { address: record.from, transactions: [], contracts: new Set() };
    entry.transactions.push(record.transactionHash); entry.contracts.add(record.contract);
    byAddress.set(key, entry);
  }
  const participants = [...byAddress.entries()].map(([key, entry]) => ({
    address: entry.address, transactionCount: new Set(entry.transactions).size,
    transactions: [...new Set(entry.transactions)], contracts: [...entry.contracts],
    holderAtSnapshot: holderResults[key]?.holder ?? null,
    holderCheckError: holderResults[key]?.error ?? null,
  }));
  return {
    observedSuccessfulTransactions: new Set(interactions.map(r => r.transactionHash.toLowerCase())).size,
    observedContractInteractions: interactions.length,
    uniqueInteractingAddresses: participants.length,
    uniqueCurrentHolders: participants.filter(p => p.holderAtSnapshot === true).length,
    unverifiedHolderAddresses: participants.filter(p => p.holderAtSnapshot === null).length,
    participatingContracts: contracts,
    organizerSubmissionConfirmed: false,
    eligibilityConfirmed: false,
    participants,
    limitations: [
      'Successful event-emitting contract calls only; transactions without events are not discovered by this scan.',
      'Holder status is checked at the fixed audit snapshot, not claimed at historical interaction time.',
      'Only organizer-accepted submitted contracts count; this scan cannot prove submission or eligibility.',
      'Office and marketplace activity are distinct; deduplication counts wallet addresses, not displayed names.',
      'No synthetic wallets, transactions, name-to-wallet lookup, or fabricated volume are included.',
    ],
  };
}
