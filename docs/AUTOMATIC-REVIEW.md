# Automatic review and receipt-only settlement

## Production model proof

A real deployed-function probe invoked the same runEvaluator path with synthetic encrypted arithmetic text, through Vercel AI Gateway and google/gemini-2.5-flash-lite. It returned PROVIDER_PROBE_OK / HTTP200 in1656ms. No participant report, task decision, commitment or payout was changed. This proves one request at that instant, not unlimited quota or guaranteed later availability. Protected ops POST allows only fixed synthetic probe and isolated Redis smoke; no arbitrary prompt is accepted. All ops/scheduler endpoints require CRON_SECRET bearer and return no-store.

## Trigger and state

GitHub Actions schedule */5 * * * * and workflow_dispatch invoke the production automation route. It is a persistent repository workflow, not a local-computer loop or chat reminder. Actual Vercel team plan is Hobby; native cron is only once daily with up-to-hour jitter, so it is not used to pretend minute-level execution. GitHub schedule itself is best-effort and can be delayed. A manual dispatch and authenticated tick remain available.

Each bounded tick incrementally discovers tasks and stores due times in Redis. Before submission deadline it only queues; it never evaluates early. During Review it resumes existing signed checkpoints, one valid candidate at a time. EDF deadline ordering with FIFO ties, atomic claim/fence, expired-lease recovery, and safe ack/retry handle at-least-once delivery. It does not ask participants for repeated signatures to run server-owned evaluation. Private artifacts remain in the trusted server/model workflow.

A terminal MAC-authenticated decision is passed to the dedicated settlement relayer. Existing signReviewDecision validates policy, signer/revocation, all-candidate coverage, artifact decryption, hash/readback and retention before receipt. Only selectWinner/rejectAll calldata on the fixed verified chain56 V2 escrow is allowed. No approval, deposit, arbitrary transfer, alternate recipient, early winner or automatic expired-task refund.

## Relayer gas and custody

A NEW dedicated relayer address was provisioned without moving funds:0x8a55B7b7Bb7fbEdCf7A6F91e898785a88168fF78. Key stored as sensitive production variable, never used as evaluator/deployer/requester key. Local recovery copy encrypted; no key printed. It is initially unfunded, so automatic payout is BLOCKED until BNB gas is supplied. No automatic top-up or spend from any personal wallet. Escrow bounty is not used to buy model calls or gas.

Relayer journals the EXACT signed raw transaction before broadcasting. One signer-global nonce lane, fenced lock and receipt reconciliation prevent advancing nonce on an ambiguous send. Pending raw transaction is retried exactly, not re-signed as another payout. Unknown/reverted journals remain blocked for operator reconciliation. Conservative defaults:gas price<=1gwei, gas<=500000, worst-case transaction cost<=0.0005BNB, daily cap0.005BNB and100transactions. These are ceilings, not estimated cost promises.

## Capacity is NOT a promise of 1000 reviews/hour

1000synthetic tasks test bounded queue memory/state and concurrency, not real provider throughput. Shared provider gate starts at most one request every7seconds:1000candidate calls alone require at least7000seconds (~117minutes), excluding latency and scheduling. A task can have up to64candidates. Therefore1000tasks simultaneously entering one-hour review windows cannot be guaranteed by this configuration. capacityReport flags overload, daily automated provider-dispatch budget defaults100, and excess jobs remain deferred/blocked rather than inventing results or overspending. Interactive requests share provider capacity but are outside the automation-specific daily cap.

Moving beyond those limits requires measured provider quota, funded infrastructure/gas, more sustainable task review windows/admission control, and deadline-aware capacity planning. We do not silently change any existing immutable task policy or deadline. Timeout/refund paths remain as published.

## Operational checks

- Provider probe: real function/model request, no private participant input.
- Redis smoke: fixed Lua programs on random isolated keys, actual hosted Redis; exact namespace cleanup.
- Queue:1000-task synthetic state-machine test, simultaneous claims, fencing, retries, budget rollover and deadline gates.
- Relayer: local Anvil receipt-gated real90/10 payout/all-fail refund, lost-send response, nonce serialization.
- Protected route: unauthenticated calls401, no caller-selected task/decision.

Never label fully operational auto-payout until scheduler execution, provider probe, actual Redis Lua AND relayer gas are verified.
