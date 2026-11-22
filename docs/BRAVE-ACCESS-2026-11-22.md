# Authorized Brave session access — 22 November 2026

The participant explicitly authorized using their Brave browser. Existing Brave was accessed through Windows UI Automation; no remote-debugging port was enabled, no process/profile was killed or copied, and no passwords/cookies/session tokens were extracted. Only task-related pages/controls were used.

## Current verified status

Later same-tab inspection now confirms BscScan Source Code Verified — Exact Match with the V2 source published. The Binance form is accessible; field3 was filled with the verified source link and independently read back. No form submission or X edit occurred. The earlier login/verification failures below are chronological history, not current blockers. See [current source verification](BSC-SOURCE-VERIFICATION.md).

## Binance form (earlier observation)

The official project survey opens the Binance Log In page in this Brave profile. Windows accessibility confirmed Log In, Email/Phone number, and native sign-in methods. No credential value was read or entered and no submission was sent. The participant needs to authenticate directly in Brave, not send password, OTP or cookies in chat.

## BscScan progress

The real Brave session loaded the public verifier without the headless403 challenge. Exact deployed Standard JSON input uploaded successfully and the public constructor arguments were filled from the verified manifest. Final Submit source code for verification was invoked.

Result: Unable to Verify Contract Source Code, err_code_5, compiled contract name empty and reported creation bytecode mismatch. Displayed compiler v0.8.39+commit.ce47f2c8, optimizer enabled/runs200 and four constructor addresses matched intended values. Therefore bscscanVerified remains false. This replaces the previous purely CAPTCHA-blocked state for the Brave session, not the underlying Sourcify exact-match proof.

A second final-submission attempt also returned err_code_5. It changed only compiler outputSelection to the fully qualified main contract and explicit bytecode.object fields. Local solc compilation proved creation/runtime identical to the deployed artifact; BscScan still returned err_code_5 with empty compiled output. No deployment, wallet signing, value transfer, third-party credential collection or fabricated eligibility was performed during browser access.
