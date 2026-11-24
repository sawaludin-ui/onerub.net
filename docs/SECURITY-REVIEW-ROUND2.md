# Round-2 adversarial review before promotion

Baseline `c93f9e2`. Three independent reviewers plus root integration. This is a bounded review, not a formal audit and **not** a claim that the product is free of bugs or unhackable.

## Confirmed and fixed in this round

### R2-1 — Candidate plaintext digests were returned to every committed worker

`evaluateTask` kept `plaintextHash` per candidate and the private API returned the internal decision unchanged. Any committed worker could read every other candidate's plaintext digest after review started. A digest of low-entropy work allows offline confirmation of a guessed report; it is not plaintext recovery, but it is unnecessary disclosure.

Fix: the HTTP boundary now projects the decision. `plaintextHash`, the decision MAC, its digest and the MAC version fields are withheld; only outcome, score, coverage, excluded reasons and the on-chain-relevant `contentHash`/`artifactPtrHash`/`size` are returned. The internal record keeps every field for integrity checks and payout preflight.

### R2-2 — Resumable review checkpoints were unauthenticated

`evaluation-job:<id>` was trusted after only comparing model/version/policy. A tampered record (datastore write compromise or a corrupted restore) could promote a rejected candidate to an accepted one, or skip an unreviewed candidate, and the result would be attested with a valid MAC. Remote unauthenticated write was **not** demonstrated; this required write access or a bad restore.

Fix: checkpoints are now authenticated with a key derived from the versioned decision key. Any mismatch, missing MAC or key rotation discards progress and restarts evaluation from the first candidate — discarding can only cost work, never change who is paid. Before attesting, the service also proves `processed === total`; a short or skipped pass fails with `COVERAGE_INCOMPLETE` and `coverage.complete` is computed instead of hard-coded.

### R2-3 — Static demo page had no policy

The demo HTML is served as a static asset, outside the dynamic nonce policy. Fix: the page now declares `default-src 'none'` with only `img-src/media-src 'self'`, inline styles, `form-action 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`. It contains no script.

### R2-4 — Documentation lagged the completed submission

The form was completed by the user ("Survey already completed"). Docs now record that instead of saying the form was never sent. A completed survey still does not prove accepted contract addresses or eligibility.

## Reviewed, no new exploit established

V2 receipt/domain binding, candidate-root hashing, 90/10 accounting, relayer constraints, revoke/rotation paths, token balance-delta checks, legacy V1 boundaries, auth replay separation, artifact integrity, quota/lease handling and provider budget. Known intentional limits stand: requester membership loss can block settlement while expiry refunds the requester; permanent signer revocation can leave work unpaid; the hosted signer, storage and model remain trusted; payment and artifact retrieval are not atomic.

## Residual

No funded mainnet lifecycle, `0` live tasks, health still `degraded`/unknown for provider, uploads and delivery; retained participation evidence predates V2 and shows 11 holders, not 30 eligible participants. Fresh BscScan re-check returned 403 while retained Exact Match evidence stands.

Reproductions live in [audit-round2 tests](../tests/audit-round2-backend.test.mjs) and [production tests](../tests/audit-round2-production.test.mjs); reviewer reports in [audit-round2](audit-round2/production-rules.md).
