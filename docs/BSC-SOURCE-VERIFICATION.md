# V2 source verification status

Address 0x0D33DD09131aC17827fA165D70daAAB4DBfC299a, chain56, deployment0xd94c61bee96a000c0de1eee1a8713a1e17180db887574f55d82b3e85c703cee9 block135002756. Compiler v0.8.39+commit.ce47f2c8, Cancun, optimizer200, MIT.

Sourcify exact creation/runtime match and live chain readback are recorded in the public deployment manifest.

BscScan status: NOT VERIFIED BY THIS RUN. Update: after explicit authorization, existing Brave session bypassed the headless challenge, source uploaded and final verification was submitted; result was err_code_5 creation-bytecode mismatch with empty compiled contract name/output. This is being diagnosed independently of the exact Sourcify match. See BRAVE-ACCESS-2026-11-22.md. Public form GET200, Continue POST200 to Standard JSON form succeeded; exact deployed compiler input218078bytes uploaded HTTP200 and filename confirmed. Final Verify and Publish requires Turnstile/CAPTCHA; actual Chrome encountered307→403 Just a moment. No explorer API credential is configured; API returned Missing/Invalid API Key. No attempt is counted as successful verification.

Exact input SHA256 f6706e5c3b3d3944536d789120e3a60a31aa971f2f62622df7a209f2aa596e4e. Generate the public verifier bundle using node scripts/export-verification-bundle.mjs after exact deployed input is present. Bundle contains standard-input.json, ABI, deployment manifest, constructor arguments and instructions; no secrets.

Public form: https://bscscan.com/verifyContract?a=0x0D33DD09131aC17827fA165D70daAAB4DBfC299a
Source: https://bscscan.com/address/0x0D33DD09131aC17827fA165D70daAAB4DBfC299a#code

The browser helper accepts PLAYWRIGHT_MODULE/CHROME_EXECUTABLE without hardcoded private paths. It does not solve CAPTCHA or operate a wallet. This remains a compliance gate distinct from Sourcify source provenance.
