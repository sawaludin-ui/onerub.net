// Pure runtime contract: safe to import in documentation generators and clients.
export const METADATA_FIELDS = Object.freeze([
  ['title', 5, 140], ['description', 20, 12000], ['rubric', 10, 8000], ['category', 2, 60],
]);
export const METADATA_EXAMPLE = Object.freeze({ title: 'Review a public report', description: 'Review the supplied public report and explain every conclusion.', rubric: 'Correctness 70 points; clarity 30 points.', category: 'research' });
export const metadataPayload = metadata => ({ metadata });
export const signedMetadata = payload => Object.hasOwn(payload, 'metadata') ? payload.metadata : payload;
export const ACTION_CONTRACT = Object.freeze({
  metadata: { method: 'POST', path: '/api/marketplace/tasks/{id}/metadata', payload: { metadata: METADATA_EXAMPLE },
    legacy: 'Signed flat payload metadata accepted; unsigned top-level metadata is never used.',
    authorization: 'Sign the hash of the EXACT raw payload. Shape normalization happens only after verification.',
    success: { registered: true, criteriaHash: 'keccak256(canonical(metadata))' },
    retry: { idempotent: true, successReplay: '409 REPLAY; GET task to confirm commitment', validation: 'Nonce unchanged; changed payload requires matching new authorization.', unavailable: 'Retry identical signed request at most twice with 1s/2s backoff within expiry; read back after ambiguous result.' } },
  upload: { retry: 'Single-use nonce; get fresh challenge before retry. Check existing receipt first.' },
  receipt: { retry: 'Single-use nonce; fresh challenge for subsequent reads.' },
  evaluate: { retry: 'Single-use nonce; fresh challenge, honor Retry-After and pending/cooldown state.' },
  delivery: { retry: 'Single-use nonce; fresh challenge, requester-only.' },
  funding: { actions: ['approve', 'createAndFund'], warning: '409 HEALTH_ACK_REQUIRED',
    acknowledgement: { accepted: true, token: 'response.healthAcknowledgement.token', expiresAt: 'response.healthAcknowledgement.expiresAt' },
    expirySeconds: 120, fatal: '503 FUNDING_UNAVAILABLE is not bypassable',
    limitation: 'Read-only readiness is not proof of provider/upload/delivery success. Direct contract calls cannot be blocked by this API.' }
});
export function fundingReadinessContract(checks = {}) {
  return Object.fromEntries(['rpc', 'storage', 'encryption', 'attestation', 'evaluator', 'uploads', 'delivery'].map(k => {
    const c = checks[k] || {};
    return [k, { status: ['available', 'unavailable', 'unknown', 'cooldown', 'not-required'].includes(c.status) ? c.status : 'unknown',
      ...(typeof c.basis === 'string' && /^[a-z0-9-]{1,100}$/.test(c.basis) ? { basis: c.basis } : {}),
      ...(Number.isSafeInteger(c.retryAt) ? { retryAt: c.retryAt } : {}) }];
  }));
}
