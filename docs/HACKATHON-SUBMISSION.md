# ONERUB.NET — submission package

Status: prepared materials, not an organizer receipt. Do not mark submitted/accepted until an authenticated official form returns confirmation.

## Official form and deadline

Project form https://www.binance.com/en/survey/fb26d2bd25e04329b1ba77c7b3811d23 requires Binance account login. Deadline 9 December2026 15:00WIB. Provenance and the form-level30-address condition are documented in [form access evidence](HACKATHON-FORM-ACCESS-2026-11-22.md). This is not the separate community X-post survey.

## Project description

Name: ONERUB.NET. Website https://onerub.net. Source https://github.com/sawaludin-ui/onerub.net. BNB Smart Chain56.

ONERUB is a task competition for Agent ID wallets. Requesters fund token escrow; workers privately upload encrypted deliverables and commit hashes onchain; a trusted hosted evaluator scores complete artifacts against a committed rubric. One winner receives90%, treasury10%, other workers0. Gas and model costs are separate. Agent ID is used for eligibility, task provenance and payout attribution, not as proof of autonomous AI or work quality.

The remediation protocol supports one valid candidate and an explicit no-acceptable-result outcome, atomic admission/capacity, candidate/policy-bound EIP712 receipts, worker-driven review, and receipt-relayed settlement from already funded escrow. Default evaluator/treasury changes apply to new tasks; each existing V2 task snapshots its signer and feeRecipient. Revocation blocks affected receipts and permits refund, not silent signer migration. Prepayment checks validate decryption, integrity, readback and retention; delivery is still offchain and not atomic with payment.

## Participating contract manifest

Read the actual active deployment from /api/marketplace/config. A local V2 sentinel is not a deployed contract and must never be submitted as an address.

- V1 marketplace escrow:0xb30E139eAdE49fdD8ace38FBE0C3dD97C0f5a0Ea. Deployment tx0x2dcd3d56499fdde8001f9600e3dabfa23d782cc2bf29d523c5655e2330dbaebc, block134905572. Immutable requester-direct settlement; no evaluator receipt enforcement.
- Office Playground:0x7d7A4B8f27838aca993d6C2c086031301ee33A9C. Public daily work/human approval/badges, not marketplace payout. Include only if actually part of the submitted project and explain separately.
- V2 revision3 marketplace:0x0D33DD09131aC17827fA165D70daAAB4DBfC299a. Deployment tx0xd94c61bee96a000c0de1eee1a8713a1e17180db887574f55d82b3e85c703cee9, block135002756. Compiler0.8.39, Cancun, receipt-gated singleton+relayer. Sourcify exact creation/runtime confirmed; runtime hash0x83523edf730da9f53cd97c64d3132eade4434fb774efe9f42846356c597fa4fb. Actual gas cost0.00016641485BNB. BscScan now independently displays Source Code Verified — Exact Match with published source at https://bscscan.com/address/0x0D33DD09131aC17827fA165D70daAAB4DBfC299a#code . This is deployment/source evidence, not a paid task or eligibility claim.

BscScan source verification must be established for each submitted deployment. Sourcify exact-match is distinct evidence, not an automatic substitute for the explicit BscScan requirement.

## Evidence available and gaps

Read-only scan in [participation evidence](audit-evidence/hackathon-participation.json): snapshot134963053,30 event-emitting successful transactions,12 interacting addresses,11 current Agent ID holders across scanned contracts. Includes deployer activity; holder status at snapshot is not historical holder eligibility. This does NOT satisfy or certify30eligible participant addresses or paid marketplace usage.

Local Anvil/memory regressions are synthetic, not mainnet income, users or independent security audit. Real funded mainnet task→private submission→review→payout→winner delivery proof must be recorded separately without revealing losing reports. A fresh deployment alone does not fill this gap.

The announcement places30addresses under Innovation, but the project form introduction states it as general eligibility. Treat the stricter form gate as applicable until organizer clarification; do not promise a Pioneer entry can bypass it. Only submitted/accepted contracts and valid period interactions count.

## Materials for the authenticated form

- Project name, website, source/release and architecture explanation above.
- Actual participating contract addresses, deployment txs, BscScan verified source and current owner privileges.
- Product demonstration recording plus reproducible read-only links and transaction receipts when genuine.
- Agent ID usage and unique eligible interaction evidence with limitations.
- [Wallet protocol](../public/skill.md), [work/data terms](../public/terms.md), [security policy](../public/security.md).
- Reward address, contact and participant eligibility answers must belong to the submitting person/team; they cannot be inferred from deployer/treasury.

No fake accounts, fake volume, unlimited approvals, third-party QR/pairing login, bypassed user confirmation, collection of wallet secrets, Binance impersonation or promised returns. No submission receipt is claimed by this document.
