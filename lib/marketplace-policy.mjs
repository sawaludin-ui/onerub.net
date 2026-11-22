import { MarketplaceError, hash } from './marketplace-core.mjs';

export const MIN_REVIEW_SECONDS = 3600;
export const MIN_SETTLEMENT_SECONDS = 120;
const freezePolicy=value=>Object.freeze({...value,formats:Object.freeze([...value.formats]),retention:Object.freeze({...value.retention})});
export const LEGACY_POLICY = freezePolicy({
  version: 2,
  minScore: 70,
  minimumValidSubmissions: 2,
  maxParticipants: 64,
  maxArtifactBytes: 524288,
  maxTotalBytes: 33554432,
  formats: ['text/plain', 'text/markdown', 'application/json'],
  evaluatorVersion: 'onerub-review-v2',
  tieBreak: 'score-desc-address-asc',
  minReviewWindowSeconds: MIN_REVIEW_SECONDS,
  allFail: 'signed-rejection-refunds-requester',
  timeout: 'requester-refund-after-review-deadline',
  distribution: 'one-winner-90-percent-treasury-10-percent',
  privacy: 'trusted-host-and-model-provider-no-tee',
  delivery: 'requester-and-winner-only-after-three-confirmations',
  retention: { artifactDaysAfterReview: 365, losingReportAccess: 'never-public', metadata: 'public-permanent' },
  dispute: 'no-human-arbitration',
});

export const DEFAULT_POLICY = freezePolicy({
  ...LEGACY_POLICY, version: 3, minimumValidSubmissions: 1,
  settlement: 'any-relayer-signed-decision-funded-escrow-only',
  signerRecovery: 'new-task-rotation-only-revoked-active-tasks-refund-no-migration',
  deliveryPreflight: 'decrypt-integrity-readback-and-retention-before-receipt',
  rights: 'winner-nonexclusive-after-settlement-loser-not-licensed',
});

export function normalizePolicy(value = DEFAULT_POLICY) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MarketplaceError('A readable policy object is required.');
  const template = value.version === 2 ? LEGACY_POLICY : DEFAULT_POLICY;
  const expected = { ...template, minScore: value.minScore ?? template.minScore };
  if (!Number.isInteger(expected.minScore) || expected.minScore < 1 || expected.minScore > 100)
    throw new MarketplaceError('policy.minScore must be an integer from 1 to 100.');
  // Fixed service and contract limits are part of the agreement, not requester hints.
  for (const key of Object.keys(value)) {
    if (!(key in expected) || hash(value[key]) !== hash(expected[key]))
      throw new MarketplaceError(`Unsupported policy field: ${key}.`);
  }
  return structuredClone(expected);
}

export const policyHash = value => hash(normalizePolicy(value));
export function artifactRetentionSeconds(task, now = Math.floor(Date.now() / 1000)) {
  const deadline = Number(task.reviewDeadline);
  if (!Number.isSafeInteger(deadline) || deadline < 1 || !Number.isSafeInteger(now))
    throw new MarketplaceError('A valid review deadline is required for retention.', 409, 'RETENTION_INVALID');
  return Math.max(1, deadline + DEFAULT_POLICY.retention.artifactDaysAfterReview * 86400 - now);
}
