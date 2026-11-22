# V2 BscScan source verification — confirmed

[Published source on BscScan](https://bscscan.com/address/0x0D33DD09131aC17827fA165D70daAAB4DBfC299a#code) now displays **Source Code Verified — Exact Match**. Observed directly in the authorized existing Brave tab, with no new tab/window and no wallet transaction. The main source and imported dependencies are publicly visible.

- Contract: OneRubMarketplaceEscrowV2, chain56, address0x0D33DD09131aC17827fA165D70daAAB4DBfC299a.
- Compiler v0.8.39+commit.ce47f2c8; optimizer enabled200runs; Cancun EVM.
- Source begins SPDX-License-Identifier: MIT. Explorer license metadata header displays -NA-; do not claim the header says MIT.
-65 public ABI entries independently match the local deployment ABI.
- Source verification is not a security audit, eligibility approval, or evidence of paid use.

Field3 of the official Binance project form was filled with the source URL above in the existing Brave tab and independently read back. No final form submission was sent, and the X field was not changed.

Earlier CAPTCHA/403 and err_code_5 screenshots are historical failed attempts. They are not the current verification status. The reason for the later status change is not established; do not invent an asynchronous-success explanation. No replacement contract was deployed.

[Exact Match screenshot](audit-evidence/bscscan-exact-match.png), [proof metadata](audit-evidence/bscscan-verification.json), [ABI proof](audit-evidence/bscscan-abi-readback.json). Public source bundles can be reproduced with node scripts/export-verification-bundle.mjs.
