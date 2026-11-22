# Hosted evaluator rate-limit handling

Real provider tests found a burst limit, not an authentication or negative-content failure: a bounded20request run produced9HTTP200 then11HTTP429 with Retry-After8–10seconds. Separate correct/adversarial probes both returned200 and the adversarial answer correctly failed acceptance.

Implemented: at most two retries, only explicit429/502/503/504, one shared45second wall budget, numeric/date Retry-After honored, no early retry when cooldown exceeds remaining time, no replay for network/timeout/400/401/402/403/500/invalidJSON unknown completion. Public EVALUATOR_RATE_LIMIT(503) exposes only bounded integer retryAfterSeconds and Retry-After header; no provider body/status/secret. Fresh single-use authorization is required for a later API attempt.

Scoped40tests passed after the transport patch. A single paced20case run with1.2seconds between cases passed13/20:10correct reports accepted,3incorrect/adversarial reports rejected. A16second429 recovered through bounded retry; subsequent60second cooldowns were intentionally not retried inside45seconds. This is NOT a20/20 benchmark, proof of production throughput, universal prompt-injection resistance or complete work-quality validation.

The configured provider needs higher capacity or lower admission/dispatch rate for larger task bursts. Do not enlarge execution beyond the lease/settlement window or treat unavailable evaluation as accepted work. Tasks can resume review checkpoints with fresh authorization after cooldown. RPC/storage/encryption/receipt-signer readiness does not certify provider capacity or future delivery; public health remains unknown/degraded for those task-specific dependencies.

No production participant data was used; all benchmark text was synthetic arithmetic. No chain transactions or wallets were involved in these model probes.
