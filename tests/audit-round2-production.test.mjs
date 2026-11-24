// Node.js local-only audit diagnostics; no network, environment secrets, wallet or provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { summarizeEvidence, SUBMISSION_START, SUBMISSION_END } from '../lib/hackathon-evidence.mjs';
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('direct dependency pins agree with lock and tmp override remains explicit', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.match(version, /^[0-9]+[.][0-9]+[.][0-9]+$/);
    assert.equal(lock.packages['node_modules/' + name].version, version);
  }
  assert.equal(pkg.overrides.solc.tmp, '0.2.7');
});

test('campaign interval excludes failed and post-deadline activity without certifying eligibility', () => {
  const contract = '0x1111111111111111111111111111111111111111';
  const from = '0x2222222222222222222222222222222222222222';
  const row = { contract, from, transactionHash: '0x' + 'ab'.repeat(32), status: 1, timestamp: SUBMISSION_START };
  const summary = summarizeEvidence([row, row, {...row, status: 0}, {...row, timestamp: SUBMISSION_END}], {[from]: {holder:true}}, [{address:contract,submitted:false}]);
  assert.equal(summary.observedSuccessfulTransactions, 1);
  assert.equal(summary.uniqueCurrentHolders, 1);
  assert.equal(summary.organizerSubmissionConfirmed, false);
  assert.equal(summary.eligibilityConfirmed, false);
});

test('retained participation snapshot predates active V2 and is not thirty eligible holders', () => {
  const evidence = JSON.parse(read('docs/audit-evidence/hackathon-participation.json'));
  const active = JSON.parse(read('lib/marketplace-v2-deployment.json'));
  assert.ok(evidence.snapshotBlock < active.blockNumber);
  assert.ok(evidence.uniqueCurrentHolders < 30);
  assert.equal(evidence.eligibilityConfirmed, false);
  assert.equal(evidence.participatingContracts.some(c => c.address.toLowerCase() === active.address.toLowerCase()), false);
});

test('static demo HTML carries its own restrictive CSP and no script', () => {
  const proxy = read('proxy.js');
  const config = read('next.config.mjs');
  const demo = read('public/demo/onerub-agent-id-demo.html');
  assert.match(proxy, /matcher:/);
  assert.ok(config.includes('source: "/api/:path*"'));
  // Static assets bypass the dynamic nonce policy, so this page declares its own
  // policy instead of silently inheriting nothing.
  assert.ok(demo.includes('http-equiv="Content-Security-Policy"'));
  assert.ok(demo.includes("default-src 'none'"));
  assert.ok(demo.includes("media-src 'self'"));
  assert.ok(demo.includes("frame-ancestors 'none'"));
  assert.match(demo, /<style>/);
  assert.equal(/<script/i.test(demo), false);
  const withoutStyles = demo.replace(new RegExp('<style>[^]*?</style>', 'g'), '');
  const inlineEvent = new RegExp("(?:^|" + String.fromCharCode(92) + "s)on[a-z]+" + String.fromCharCode(92) + "s*=", "i");
  assert.equal(inlineEvent.test(withoutStyles), false);
});

test('public handbook preserves user authorization and discloses trusted-host processing', () => {
  const handbook = read('public/skill.md');
  assert.match(handbook, /Exact-amount approvals only/);
  assert.match(handbook, /preserve all required user confirmations/i);
  assert.ok(handbook.includes("model/provider/host as trusted"));
  assert.match(read('public/terms.md'), /no bounty/i);
});
