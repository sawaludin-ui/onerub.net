// Node.js / local recovery only. Fixtures are synthetic; no .env.local loading or network writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { Wallet, keccak256 } from 'ethers';
import { encryptArtifact, hash } from '../lib/marketplace-core.mjs';
import {
  sealBackup, openBackup, collectRecoveryMaterial, separateBackupKey, applyRecoveryMaterial,
  snapshot, restoreSnapshot, validateSnapshot, verifyArtifactRecords, protectLocalBytes,
  openLocalBytes, ensurePrivateDirectory, writePrivateFile, assertPrivatePath, readBackupKey,
} from '../lib/marketplace-recovery.mjs';
import { planProvisioning, renderRuntimeEnv, provisionRoleKeys, preserveQuotedArtifactKeyVersion } from '../scripts/provision-marketplace-hardening.mjs';
import { loadRecoveryEnvironment, dataOnlySnapshot } from '../scripts/marketplace-recovery.mjs';
const key = () => randomBytes(32).toString('base64');
const fixture = () => ({ MARKETPLACE_ENCRYPTION_KEY: key(), MARKETPLACE_AUTH_SECRET: randomBytes(32).toString('hex'), MARKETPLACE_ATTESTATION_KEY: Wallet.createRandom().privateKey, MARKETPLACE_BACKUP_KEY: key(), MARKETPLACE_ENCRYPTION_KEY_VERSION: 'v1' });
const record = (suffix, value = 'synthetic', expiresAt = null) => ({ suffix, type: 'string', value, expiresAt });
const data = records => ({ version: 1, namespace: 'onerub:fixture:', records });
class MemoryStore {
  values = new Map(); writes = 0;
  async command(command, ...args) {
    if (command === 'EXISTS') return this.values.has(args[0]) ? 1 : 0;
    if (command === 'SET') { if (this.values.has(args[0])) return null; this.writes++; this.values.set(args[0], args[1]); return 'OK'; }
    if (command === 'EVAL') { const k = args[2]; if (this.values.has(k)) return 0; this.writes++; this.values.set(k, args.slice(4)); return 1; }
    throw Error('Unexpected fixture command ' + command);
  }
}
test('AES-GCM backup authenticates key/ciphertext/version and never serializes the key', () => {
  for (let i = 0; i < 5; i++) {
    const k = key(), value = data([record('metadata:7')]);
    const sealed = sealBackup(value, k);
    assert.deepEqual(openBackup(sealed, k), value);
    assert.equal(JSON.stringify(sealed).includes(k), false);
    assert.throws(() => openBackup(sealed, key()));
    assert.throws(() => openBackup({ ...sealed, ciphertext: Buffer.alloc(4).toString('base64') }, k));
    assert.throws(() => openBackup({ ...sealed, version: 7 }, k), e => e.code === 'INVALID_BACKUP');
  }
  for (const bad of ['', 'not a key', key().slice(0, -1), key() + '\n']) assert.throws(() => sealBackup({}, bad), e => e.code === 'RECOVERY_KEY_REQUIRED');
});
test('runtime material allowlist excludes deployer/provider/store and backup-key custody', () => {
  const f = fixture(), selected = collectRecoveryMaterial({ ...f, PRIVATE_KEY: 'synthetic-deployer', KV_REST_API_TOKEN: 'synthetic-store', MARKETPLACE_DECISION_KEY: 'd'.repeat(48), MARKETPLACE_ATTESTATION_KEYS_JSON: '{}' });
  assert.equal(Object.hasOwn(selected, 'MARKETPLACE_BACKUP_KEY'), false);
  assert.equal(Object.hasOwn(selected, 'PRIVATE_KEY'), false);
  assert.equal(Object.hasOwn(selected, 'KV_REST_API_TOKEN'), false);
  assert.equal(selected.MARKETPLACE_DECISION_KEY.length, 48);
  assert.equal(selected.MARKETPLACE_ATTESTATION_KEYS_JSON, '{}');
  separateBackupKey(selected, f.MARKETPLACE_BACKUP_KEY);
  assert.throws(() => separateBackupKey(selected, selected.MARKETPLACE_ENCRYPTION_KEY), e => e.code === 'RECOVERY_KEY_NOT_SEPARATE');
  assert.throws(() => separateBackupKey({ MARKETPLACE_BACKUP_KEY: key() }, key()), e => e.code === 'RECOVERY_KEY_NOT_SEPARATE');
});
test('recovered material rejects conflict/unknown credentials before changing any runtime key', () => {
  const env = { MARKETPLACE_AUTH_SECRET: 'current-synthetic' };
  assert.throws(() => applyRecoveryMaterial({ MARKETPLACE_DECISION_KEY: 'synthetic', MARKETPLACE_AUTH_SECRET: 'different' }, env), e => e.code === 'RECOVERY_KEY_CONFLICT');
  assert.deepEqual(env, { MARKETPLACE_AUTH_SECRET: 'current-synthetic' });
  assert.throws(() => applyRecoveryMaterial({ PRIVATE_KEY: 'never accepted' }, env), e => e.code === 'INVALID_BACKUP');
  applyRecoveryMaterial({ MARKETPLACE_DECISION_KEY: 'synthetic' }, env);
  assert.equal(env.MARKETPLACE_DECISION_KEY, 'synthetic');
});
test('restore validates ALL records and target conflicts before its first write', async () => {
  const store = new MemoryStore();
  for (const invalid of [data([record('metadata:1'), record('../escape')]), data([record('metadata:1'), record('metadata:1')]), data([record('nonce:1')]), data([{ ...record('x'), type: 'list' }]), data([{ ...record('x'), expiresAt: NaN }]), data([{ ...record('x'), type: 'hash', value: ['odd'] }])]) {
    await assert.rejects(restoreSnapshot(invalid, { storage: store, namespace: 'onerub:empty:' }));
    assert.equal(store.writes, 0);
  }
  store.values.set('onerub:empty:metadata:2', 'existing');
  await assert.rejects(restoreSnapshot(data([record('metadata:1'), record('metadata:2')]), { storage: store, namespace: 'onerub:empty:' }), e => e.code === 'RESTORE_CONFLICT');
  assert.equal(store.writes, 0);
  assert.equal(store.values.get('onerub:empty:metadata:2'), 'existing');
  await assert.rejects(restoreSnapshot(data([]), { storage: store, namespace: 'other:*:' }));
});
test('restore preserves expiry, supports hashes, and never overwrites existing values', async () => {
  const store = new MemoryStore();
  const input = data([record('metadata:1'), record('expired', 'expired', 900), { suffix: 'workers:1', type: 'hash', value: ['worker', 'pointer'], expiresAt: null }]);
  validateSnapshot(input);
  const restored = await restoreSnapshot(input, { storage: store, namespace: 'onerub:empty:', now: 1000 });
  assert.equal(restored.restored, 2); assert.equal(restored.skippedExpired, 1);
  await assert.rejects(restoreSnapshot(input, { storage: store, namespace: 'onerub:empty:', now: 1000 }), e => e.code === 'RESTORE_CONFLICT');
});
test('snapshot deduplicates SCAN and excludes volatile/foreign namespace records', async () => {
  const ns = 'onerub:fixture:';
  const storage = { async command(command) {
    if (command === 'SCAN') return ['0', [ns + 'metadata:7', ns + 'metadata:7', ns + 'nonce:7', 'onerub:foreign:secret']];
    if (command === 'TYPE') return 'string';
    if (command === 'TTL') return -1;
    if (command === 'GET') return 'synthetic';
    throw Error('Unexpected');
  } };
  const output = await snapshot({ storage, namespace: ns });
  assert.equal(output.records.length, 1); assert.equal(output.records[0].suffix, 'metadata:7');
});
test('artifact recovery verifies decrypted plaintext, content commitment, size and old keyring', () => {
  const names = ['MARKETPLACE_ENCRYPTION_KEY', 'MARKETPLACE_ENCRYPTION_KEY_VERSION', 'MARKETPLACE_ENCRYPTION_KEYRING'];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    const old = key(); process.env.MARKETPLACE_ENCRYPTION_KEY = old; process.env.MARKETPLACE_ENCRYPTION_KEY_VERSION = 'old';
    process.env.MARKETPLACE_ENCRYPTION_KEYRING = JSON.stringify({ old });
    const bytes = Buffer.from('Synthetic offline artifact recovery fixture.'), suffix = 'artifact:7:0x0000000000000000000000000000000000000001';
    const encrypted = encryptArtifact(bytes, suffix);
    const artifact = { encrypted, contentHash: hash(encrypted), plaintextHash: keccak256(bytes), size: bytes.length };
    process.env.MARKETPLACE_ENCRYPTION_KEY = key(); process.env.MARKETPLACE_ENCRYPTION_KEY_VERSION = 'new';
    assert.deepEqual(verifyArtifactRecords(data([record(suffix, JSON.stringify(artifact))])), { checked: 1 });
    assert.throws(() => verifyArtifactRecords(data([record(suffix, JSON.stringify({ ...artifact, size: 1 }))])));
    process.env.MARKETPLACE_ENCRYPTION_KEYRING = '{}';
    assert.throws(() => verifyArtifactRecords(data([record(suffix, JSON.stringify(artifact))])));
  } finally { for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } }
});
test('legacy repair requires exact encryption/auth and accepts ONLY reversible observed quoting', () => {
  const f = fixture(); f.MARKETPLACE_ENCRYPTION_KEYRING = JSON.stringify({ legacy: f.MARKETPLACE_ENCRYPTION_KEY, v1: f.MARKETPLACE_ENCRYPTION_KEY });
  const malformed = { ...f, MARKETPLACE_ENCRYPTION_KEY_VERSION: "'v1'", MARKETPLACE_ATTESTATION_KEY: "'" + f.MARKETPLACE_ATTESTATION_KEY + "'", MARKETPLACE_BACKUP_KEY: "'" + f.MARKETPLACE_BACKUP_KEY + "'", MARKETPLACE_ENCRYPTION_KEYRING: "'" + f.MARKETPLACE_ENCRYPTION_KEYRING.replaceAll('"', '') + "'" };
  assert.throws(() => planProvisioning(malformed, f));
  const result = planProvisioning(malformed, f, { repairLegacyEnv: true });
  assert.equal(result.material.MARKETPLACE_ENCRYPTION_KEY, f.MARKETPLACE_ENCRYPTION_KEY);
  assert.equal(result.material.MARKETPLACE_AUTH_SECRET, f.MARKETPLACE_AUTH_SECRET);
  assert.equal(result.material.MARKETPLACE_ATTESTATION_KEY, f.MARKETPLACE_ATTESTATION_KEY);
  assert.equal(result.legacyBackupKey, f.MARKETPLACE_BACKUP_KEY);
  assert.equal(result.repaired.length, 4);
  assert.throws(() => planProvisioning({ ...malformed, MARKETPLACE_AUTH_SECRET: 'different' }, f, { repairLegacyEnv: true }));
  assert.throws(() => planProvisioning({ ...malformed, MARKETPLACE_ENCRYPTION_KEYRING: "'unrelated'" }, f, { repairLegacyEnv: true }));
});
test('authenticated historical quoted-version alias preserves exact key and env roundtrip', () => {
  const material = planProvisioning(fixture()).material;
  const suffix = 'artifact:1:0x0000000000000000000000000000000000000001';
  const historical = data([record(suffix, JSON.stringify({ encrypted: { keyVersion: "'v1'" } }))]);
  const aliased = preserveQuotedArtifactKeyVersion(material, historical);
  const ring = JSON.parse(aliased.MARKETPLACE_ENCRYPTION_KEYRING);
  assert.equal(ring["'v1'"], material.MARKETPLACE_ENCRYPTION_KEY);
  for (const name of ['MARKETPLACE_AUTH_SECRET', 'MARKETPLACE_ENCRYPTION_KEY', 'MARKETPLACE_ATTESTATION_KEY']) assert.equal(aliased[name], material[name]);
  const parsed = parseEnv(renderRuntimeEnv('', aliased, 'C:/synthetic/key.dpapi.json'));
  assert.equal(parsed.MARKETPLACE_ENCRYPTION_KEYRING, aliased.MARKETPLACE_ENCRYPTION_KEYRING);
  assert.throws(() => preserveQuotedArtifactKeyVersion(material, data([])));
  assert.throws(() => preserveQuotedArtifactKeyVersion({ ...material, MARKETPLACE_ENCRYPTION_KEYRING: JSON.stringify({ "'v1'": key() }) }, historical));
});
test('explicit role-key flags preserve encryption/auth, archive prior signer, reject activation/rotation', () => {
  const f = collectRecoveryMaterial(fixture());
  const result = provisionRoleKeys(f, { createDecisionKey: true, replaceUnactivatedAttestationKey: true, deployment: { status: 'not-deployed' } });
  assert.equal(result.material.MARKETPLACE_AUTH_SECRET, f.MARKETPLACE_AUTH_SECRET);
  assert.equal(result.material.MARKETPLACE_ENCRYPTION_KEY, f.MARKETPLACE_ENCRYPTION_KEY);
  assert.equal(result.priorMaterial.MARKETPLACE_ATTESTATION_KEY, f.MARKETPLACE_ATTESTATION_KEY);
  assert.notEqual(result.material.MARKETPLACE_ATTESTATION_KEY, f.MARKETPLACE_ATTESTATION_KEY);
  assert.notEqual(result.material.MARKETPLACE_DECISION_KEY, f.MARKETPLACE_AUTH_SECRET);
  assert.ok(Buffer.byteLength(result.material.MARKETPLACE_DECISION_KEY) >= 32);
  assert.throws(() => provisionRoleKeys(result.material, { createDecisionKey: true }));
  assert.throws(() => provisionRoleKeys(f, { createDecisionKey: true, replaceUnactivatedAttestationKey: true, deployment: { status: 'active', address: '0x1' } }));
  assert.throws(() => provisionRoleKeys(f));
});
test('env render preserves unrelated settings but removes plaintext backup-key copies and malformed duplicates', () => {
  const f = fixture(), material = collectRecoveryMaterial(f);
  const text = "KEEP_ME=synthetic\nMARKETPLACE_BACKUP_KEY='legacy'\nexport MARKETPLACE_AUTH_SECRET=old\nMARKETPLACE_AUTH_SECRET=older\n";
  const rendered = renderRuntimeEnv(text, material, 'C:/synthetic/backup-key.dpapi.json');
  const parsed = parseEnv(rendered);
  assert.equal(parsed.KEEP_ME, 'synthetic'); assert.equal(parsed.MARKETPLACE_AUTH_SECRET, f.MARKETPLACE_AUTH_SECRET);
  assert.equal(parsed.MARKETPLACE_BACKUP_KEY, undefined);
  assert.equal((rendered.match(/^MARKETPLACE_AUTH_SECRET=/gm) || []).length, 1);
});
test('recovery CLI never trusts backup key from local env and snapshots are data-only', () => {
  const inherited = { MARKETPLACE_BACKUP_KEY: 'independently-injected-synthetic' };
  loadRecoveryEnvironment('MARKETPLACE_BACKUP_KEY=local-plaintext\nMARKETPLACE_BACKUP_KEY_FILE=C:/synthetic/key.dpapi.json\n', inherited);
  assert.equal(inherited.MARKETPLACE_BACKUP_KEY, 'independently-injected-synthetic');
  const clean = {};
  loadRecoveryEnvironment('MARKETPLACE_BACKUP_KEY=local-plaintext\nMARKETPLACE_AUTH_SECRET=synthetic\n', clean);
  assert.equal(clean.MARKETPLACE_BACKUP_KEY, undefined);
  const payload = dataOnlySnapshot({ ...data([record('metadata:7')]), recoveryMaterial: fixture(), MARKETPLACE_BACKUP_KEY: key() });
  assert.equal(Object.hasOwn(payload, 'recoveryMaterial'), false);
  assert.equal(Object.hasOwn(payload, 'MARKETPLACE_BACKUP_KEY'), false);
  assert.throws(() => dataOnlySnapshot({ ...payload, namespace: 'invalid:*:' }), e => e.code === 'INVALID_BACKUP');
});
test('Windows DPAPI five-roundtrip and private file ACL persistence', { skip: process.platform !== 'win32' }, () => {
  const directory = path.join(os.tmpdir(), 'onerub-recovery-test-' + randomUUID());
  try {
    ensurePrivateDirectory(directory); assertPrivatePath(directory);
    for (let i = 0; i < 5; i++) {
      const bytes = randomBytes(32), sealed = protectLocalBytes(bytes);
      assert.deepEqual(openLocalBytes(sealed), bytes);
      assert.equal(JSON.stringify(sealed).includes(bytes.toString('base64')), false);
    }
    const k = key(), file = path.join(directory, 'key.dpapi.json');
    writePrivateFile(file, JSON.stringify(protectLocalBytes(Buffer.from(k))));
    assert.equal(readBackupKey({ env: {}, keyFile: file }), k);
    assertPrivatePath(file);
    assert.throws(() => writePrivateFile(file, 'not overwritten'));
    assert.equal(readBackupKey({ env: {}, keyFile: file }), k);
  } finally {
    const absolute = path.resolve(directory);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('onerub-recovery-test-')) throw Error('Unexpected fixture cleanup target.');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});
