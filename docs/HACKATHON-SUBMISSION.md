# ONERUB.NET — marketplace submission draft

This prepares materials; it is not proof that an entry was submitted or accepted.

Website https://onerub.net. Repository https://github.com/sawaludin-ui/onerub.net.
Chain BNB Smart Chain (56).
Participating marketplace escrow: 0xb30E139eAdE49fdD8ace38FBE0C3dD97C0f5a0Ea.
Deployment transaction: 0x2dcd3d56499fdde8001f9600e3dabfa23d782cc2bf29d523c5655e2330dbaebc (block134905572).
Explorer: https://bscscan.com/address/0xb30E139eAdE49fdD8ace38FBE0C3dD97C0f5a0Ea#code.

## Product

Agent ID holders operate as requester and worker. Requester funds a task in escrow. Workers privately submit encrypted artifacts and commit envelope hashes on-chain. A delegated hosted evaluator compares complete artifacts against an immutable rubric, returning only a winner and bounded score. Requester selects via wallet-authorized contract call. Settlement pays 90% to winner and10% to treasury. Delivery checks confirmed settlement and releases only the winning artifact to authorized requester/winner.

The application checks registry ownership for private signed APIs and the contract checks eligibility at creation/submission. Agent ID is bound to task creator, submission signer and payout destination. API-only requests do not constitute on-chain participation. No claim that wallet ownership proves autonomous AI control.

## Demonstration evidence

- Deployed escrow was independently read back: receipt success, code7726bytes, fee1000bps, nextTaskId1 at prior inspection.
- Automated local Anvil E2E covers task create/fund, two encrypted submissions, commitments, bounded choice, 90/10 settlement, winner-only delivery and loser denial.
- A separate synthetic integration passed against real private Redis and real AI Gateway with chain execution isolated to local Anvil. These are NOT real mainnet earnings or participants.
- No funded mainnet marketplace task or eligible-participant threshold is claimed by this draft. The old office demo is separate legacy activity.

## Mainnet demo still to record

With authorized funded requester and at least two independent Agent ID workers: create/fund, register rubric, upload privately, commit on-chain, evaluate after deadline, authorize selection, verify payout receipts, retrieve winner artifact. Record transaction hashes and only nonprivate evidence. Do not publish losing submissions.

## Limits to disclose

Trusted application/key administrators, storage and model provider; no TEE/host-proof isolation. Existing immutable escrow permits direct requester selection without evaluator receipt or artifact availability checks. Service caps20committed workers per task, requires2valid artifacts, supports UTF-8 text/Markdown/JSON up to512KiB each and750000combined bytes. Invalid/missing artifacts are excluded. No quality arbitration; review timeout permits requester refund. Owner can change treasury and token whitelist. Three-block delivery confirmation is not absolute finality. No independent audit claim.

## Eligibility

Check the current official rules before submission: https://www.binance.com/en/support/announcement/detail/95f5dbe0ea674a48a739b59e046648bf.
The Innovation Award threshold is at least30Agent ID holder addresses interacting with participating contracts during the submission period; it is not a universal30-address requirement for every award. Do not claim it is met. Submission deadline from the announcement:9December2026,15:00WIB. Submit all participating contract addresses and explain which belong to the current product; do not automatically combine legacy usage with new escrow usage.

No website QR/pairing login, collection of wallet secrets, bypassing wallet confirmations, promised returns or fabricated/sybil interactions.
