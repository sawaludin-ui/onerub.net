# ONERUB — remediation release status

## Implemented and released

- Credential NTFS permissions restricted to operator/SYSTEM/Administrators; DPAPI originals verified; independent decision MAC and initial evaluator signer; encryption/auth preserved. Historical quoted-version alias now maps to the exact same preserved key; authenticated historical backup verified1record/1artifact read-only after guarded migration.
- Shared verified deployment/ABI resolver for browser/server/CLI; chain+escrow+task identity for storage/signing/routes; V1 new hosted funding disabled when fallback is active.
- V2 revision3 deployed at0x0D33DD09131aC17827fA165D70daAAB4DBfC299a, transaction0xd94c61bee96a000c0de1eee1a8713a1e17180db887574f55d82b3e85c703cee9, block135002756. Cost0.00016641485BNB. Source exact-match creation/runtime verified with Sourcify plus live chain readback; BscScan is a separate pending gate.
- Singleton work, participant-triggered/resumable review, receipt-gated any-relayer settlement from funded escrow only, explicit all-fail, per-task signer/treasury snapshots and revoke/refund policy. No participant wallet key or unlimited approval.
- Atomic artifact admission/capacity, nonshortening retention, decryption+commitment+plaintext+size+pointer readback before receipt; explicit payment-versus-delivery status.
- Versioned independent decision MAC verification; original verdict preserved across authorized key retirement/rotation; exact per-task signer keyring.
- Role-specific first-fold onboarding,90/10/zero-loser+gas disclosure, observer board, namespaced task permalinks, bounded errors, trust cards, source/support/security/terms, Playground separation. Supplied sculpture/Office data preserved.
- Keyboard dialog forward/reverse Tab cycle, Escape and focus restoration; mobile/desktop actual production gates.
- Private GitHub vulnerability reporting enabled and read back; source publication scanning found zero actual credential matches in release files.

## Test and release evidence

- Final full suite after V2 activation and rate-limit/legacy-recovery patches:142tests,142pass,0fail,0skipped,88.565s. Local Anvil/mock tests are not real paid marketplace use.
- Dependency check tmp0.2.7 matches override+lock; npm audit known advisories0 across installed dependency report, not a code audit.
- Real private Redis:6/6 synthetic checks for PING, atomic admission, immutability, capacity, nonshortening TTL and encrypted integrity readback.
- Real isolated encrypted backup/restore drill:1record,1artifact,1restored, productionNamespaceMutated=false. Separate data backup key, no credential material in data snapshot.
- Production web Vercel deployment https://onerub-gch2rydnm-fertalites-projects.vercel.app aliased https://onerub.net.
- Public config,health,list,observer,permissions,Playground,handbook,security,terms,submission all HTTP200 and deployment identity matches. [Readback evidence](audit-evidence/production-release.json).
- Browser production1440×900 and390×844: actual configV2+enabled funding, first-fold role/risk, no overflow,12Tab/ShiftTab/Escape/focus, foreign namespace404, observer/trust pass. Actual GET-only homepage also inspected with no fixtures; no wallet mutations. Fixture task/payment screenshots are explicitly simulated.

## Still not established; never fabricate

- Mainnet funded task→worker artifact→review→payout→retrieval remains absent; production board currently0tasks. Deployment is not payment evidence.
- Participation scan12interacting addresses/11current holders does not establish30eligible addresses; only real participants and organizer-accepted contracts count.
- Official submission requires Binance account login; no authenticated form session or receipt available. Form-level30-address wording may be stricter than award-specific announcement language.
- BscScan headless flow was blocked by Turnstile/403 and no API key. Authorized existing Brave session later uploaded exact source and submitted final verification; returned err_code_5 with empty compiled contract output and creation-bytecode mismatch. bscscanVerified=false; exact Sourcify match is not substituted for BscScan success. See BRAVE-ACCESS-2026-11-22.md.
- Provider benchmark availability failure diagnosed by bounded status-only run: first9cases HTTP200, remaining11 HTTP429 with Retry-After8–10seconds; separate positive and adversarial probes both HTTP200. This is a real burst-rate limit, not evidence that negative content is rejected. Bounded429/502/503/504 retry now honors Retry-After inside a shared45second budget with at most2retries and no replay of unknown network completion. Final paced20case run13/20passed: one16second429 cooldown recovered; later60second cooldowns correctly returned EVALUATOR_RATE_LIMIT instead of exceeding the budget. Provider throughput remains limited; no20/20claim. No universal correctness/injection-resistance claim. Health remains degraded/unknown for provider,uploads,task-specific delivery rather than green based on configuration.
- Host/key administrators, storage and model providers remain trusted. Refund/expiry/revocation or membership loss can leave worker costs unpaid. No human arbitration, host-proof secrecy, or unconditional delivery guarantee.

## Relevant runbooks

[Release gates](RELEASE-GATES.md), [form access](HACKATHON-FORM-ACCESS-2026-11-22.md), [submission package](HACKATHON-SUBMISSION.md), [policy](../public/terms.md), [security](../public/security.md).
