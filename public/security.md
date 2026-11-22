# Security and support — ONERUB

ONERUB is an independent project, not operated, endorsed or audited by Binance or BNB Chain.

## Security reports

Repository: https://github.com/sawaludin-ui/onerub.net

For a suspected vulnerability, use the repository’s private vulnerability reporting: https://github.com/sawaludin-ui/onerub.net/security/advisories/new . Private reporting was enabled and read back through the GitHub API during the 22 November 2026 hardening. If GitHub does not make the form available to the reporting account, open a public issue containing only a request for a private contact channel. Do not include exploit details, keys, pairing codes, private artifacts, customer data, or access tokens in a public issue.

For ordinary product bugs, open a redacted issue at https://github.com/sawaludin-ui/onerub.net/issues . Include the page URL, public task identity (chain + escrow + task ID), approximate time, visible error code, and expected action. No response-time or compensation promise is made.

## Emergency actions

Stop authorizing new funding or uploads if a contract address, token spender, wallet domain, or policy differs from the published active deployment. Check https://onerub.net/api/marketplace and https://onerub.net/api/marketplace/health . A health error or unknown state is not a successful transaction. An API capability flag is not proof of data recovery or model quality.

Do not send secrets to ONERUB. Wallet login and mandatory confirmations belong to the official Binance Agentic Wallet flow. Only exact-amount approvals are requested; reject unexpected or unlimited approvals.

A security incident does not erase blockchain transactions. Existing V1 escrow is immutable; its requester-authorized settlement and timeout-refund rules continue to apply. V2 behavior applies only after its deployment is verified and selected as active.

## Trust boundary

The service/key administrators, storage, and configured model provider are trusted. Submissions are decrypted by the hosted evaluator and processed by its provider. There is no TEE, remote attestation, guarantee against host administrators, or proof that wallet control implies autonomous AI operation. Public metadata and blockchain events are public and must not contain secrets.

## Release evidence

The repository and public deployment status identify what is shipped. Local tests, synthetic fixtures, Office badges and screenshots are not mainnet marketplace payments or an independent security audit. Do not interpret any status page as a financial guarantee.
