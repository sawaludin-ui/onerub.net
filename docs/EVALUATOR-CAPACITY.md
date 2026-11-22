# Hosted evaluator — shared dispatch and resumable cooldown

## Root cause and current implementation

Initial unpaced runs failed after9–10requests with HTTP429. Per-request bounded retries improved13/20cases but still failed at provider60second cooldowns. This was insufficient: parallel tasks could still consume a shared upstream quota. Those failed runs remain historical evidence.

Production now uses a provider-wide Redis dispatch gate, separate from task/contract/model identity. Redis server TIME and atomic Lua enforce one in-flight request, a60second ownership lease, default7000ms between dispatches and a shared max Retry-After cooldown after429. All instances using an upstream account must share Redis and MARKETPLACE_EVALUATOR_QUEUE_SCOPE. No secret is stored in the queue key or public health response.

Denied dispatch does not reserve a future slot, spend a model call or debit a candidate attempt. Evaluation returns HTTP200 with status=cooldown,outcome=pending,processed,total,retryAfterSeconds,retryAt,nextAction=evaluate. Existing candidate cursor/scores and any saved final verdict remain unchanged; the per-task lock is released. Resume with fresh authorization after Retry-After. No settlement receipt can be prepared from pending review.

There are no inline provider retries or sleeps in the production shared-gate path. Each model request and preceding gate/quota work fit the existing45second budget; network/timeout failures are not automatically replayed. The standalone transport helper retains bounded retries for explicit transient responses, but normal runEvaluator always supplies the shared dispatch gate.

## Actual verification

One bounded20case benchmark through the real Redis scheduler and configured google/gemini-2.5-flash-lite provider passed20/20: all20HTTP200, zero429,144837ms total,7000ms minimum dispatch spacing. Ten correct arithmetic artifacts accepted; ten synthetic negative/injection artifacts rejected. [Public benchmark evidence](audit-evidence/evaluator-benchmark.json). This is not real paid usage, universal injection resistance, or proof of complex work quality.

Read-only queue.inspect reports current cooldown without mutation or model call. Health shows cooldown with bounded retry fields when observed; an open gate remains provider status unknown, never a green success based only on configuration.

## Remaining limits

No FIFO fairness or guaranteed future throughput. Other applications or calls outside this shared gate can exhaust the same provider account. Higher volume needs measured admission/capacity planning, not longer hidden waits beyond the lease/settlement budget. Storage, host, provider and signer remain trusted; missing provider capacity is not acceptable work and never authorizes payout.
