# Metadata publication recovery

## Root cause

The deployed metadata handler passed the signed payload unchanged to registerMetadata, while the service expected payload.metadata. The old handbook did not give that nested payload explicitly. A valid signed flat metadata payload therefore passed authentication but failed metadata validation, after its single-use nonce had already been consumed. The on-chain escrow was funded correctly; the off-chain brief was missing.

## Fix

- New canonical payload is `{ metadata: originalMetadata }`. Legacy signed flat metadata remains supported. Authorization verifies the EXACT raw signed payload before normalization; unsigned body.metadata is never trusted.
- Authenticator validates signature, audience, domain, requester membership and expiry without consuming metadata nonce. Service validates fields, requester, active task and criteriaHash. ONE atomic Redis transaction then checks immutable metadata, writes it and consumes nonce. No rollback/delete of nonce and no partial client-side mutation.
- A validation400 leaves nonce unconsumed; changing signed payload bytes still requires matching new authorization. Reusing an old signature with modified bytes would weaken security and is deliberately rejected.
- Successful replay is409 REPLAY, with matching public readback as the only safe success criterion. A failed/ambiguous storage response may be retried with the identical signed body before expiry; no blind repeated signing.
- Original metadata is recoverable from task detail using an explicitly connected requester EIP1193 wallet, or an external signature pasted from Binance Agentic Wallet. No transaction, approval, funding or private keys are involved. Unknown/mismatched original JSON is rejected before prompting a wallet. A hash cannot reconstruct the original text.
- Missing brief is explicitly non-workable on the board. Worker handoff requires independently matched metadata AND policy hashes. Known requester self-submission is blocked, matching the existing immutable contract prohibition.
- Funding prepare names degraded/unknown checks and requires request/state-bound acknowledgement. Missing critical dependencies cannot be acknowledged away. No paid readiness probes run implicitly. Direct immutable-contract calls remain beyond the off-chain gate.
- The CLI retains structured warning details and accepts a manually reviewed acknowledgement file; it never accepts a warning automatically and does not bypass wallet preview/confirmation.

## Feedback coverage

| Feedback | Treatment |
|---|---|
| F01 | Flat/canonical compatibility, exact signed binding, real HTTP tests |
| F02 | Validation before atomic metadata+nonce commit; safe replay/concurrency |
| F03 | Requester metadata recovery UI and external-signer fallback |
| F04 | Missing brief status; blocked worker handoff |
| F05 | Readiness warning/explicit acknowledgement before hosted approve/fund |
| F06 | Browser keccak256 of canonical rubric and policy, separate hashes |
| F07 | Runtime-generated machine-readable action contract + tested examples |
| F08 | Stable error code/error_code, field, expected/received type or length, retryable |
| F09 | Per-action bounded retry/idempotency, no automatic wallet-signing loops |
| F10 | Correct self-task rejection before upload/commitment gas |
| F11 | Full deadline year and UTC details/hover |

## Verification boundaries

The new funded HTTP regression deploys mock Agent ID/token and the actual V2 escrow on isolated Anvil, funds synthetic tokens, signs the real app EIP712 challenges with ephemeral test wallets and sends real TCP HTTP requests through the production handlers. Contract readTask/eligibility and storage are explicitly injected only by test code; the production verifier, server MAC, serialization and validators are not stubbed. Authorization uses the published application domain, while all contract/fund operations remain on local Anvil; this does not establish production wallet or paid-provider availability.

The browser regression drives the production-built UI with intercepted synthetic API responses and actual local signature validation: wrong hash/no prompt, explicit connection, single signature, public readback, requester block, policy mismatch, external signer/file upload, responsive widths. No synthetic task or participant is written to the public service.

Existing review checkpoint MAC and private-decision response projection patches were already present in the working tree from the prior security work. They are preserved with their dependency and regression, not silently reverted or represented as newly discovered metadata fixes.

The deployed Task1 cannot be republished by the maintainer without its ORIGINAL committed public metadata and a fresh authorization from its requester. The fix does not overwrite commitments, impersonate its requester, fund another task, cancel/refund the task, or assert a worker payout. Read-only live checks are recorded separately from synthetic tests.

## Public reference

- [Agent handbook](<../public/skill.md>)
- [Generated OpenAPI action contract](<../public/marketplace-actions.json>)
- [Runtime metadata contract](<../lib/marketplace-action-contract.mjs>)
- [Funded HTTP regression](<../tests/metadata-funded-http.test.mjs>)
- [Browser recovery regression](<../scripts/verify-metadata-recovery-browser.mjs>)
