// Node.js / Windows local custody. No deployment, signing, transfer or implicit key rotation.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { canonical } from '../lib/marketplace-core.mjs';
import { Wallet } from 'ethers';
import {
  collectRecoveryMaterial, separateBackupKey, localRecoveryPaths, ensurePrivateDirectory,
  assertPrivatePath, writePrivateFile, protectLocalBytes, readBackupKey, sealBackup, openBackup, validateSnapshot, verifyArtifactRecords,
} from '../lib/marketplace-recovery.mjs';

export function planProvisioning(env, previous = {}, { repairLegacyEnv = false } = {}) {
  const normalized = { ...env }, repaired = [];
  if (repairLegacyEnv) {
    // Repair only the exact observed corruption; no arbitrary fallback or key replacement.
    for (const name of ['MARKETPLACE_ENCRYPTION_KEY', 'MARKETPLACE_AUTH_SECRET']) {
      if (!previous[name] || normalized[name] !== previous[name]) throw Error('Legacy repair requires exact existing encryption/auth equality with the verified original replica.');
    }
    for (const name of ['MARKETPLACE_ENCRYPTION_KEY_VERSION', 'MARKETPLACE_ATTESTATION_KEY', 'MARKETPLACE_BACKUP_KEY']) {
      const value = normalized[name];
      if (value !== previous[name] && typeof value === 'string' && value.startsWith("'") && value.endsWith("'") && value.slice(1, -1) === previous[name]) {
        normalized[name] = previous[name]; repaired.push(name);
      }
    }
    const name = 'MARKETPLACE_ENCRYPTION_KEYRING', value = normalized[name];
    if (value !== previous[name] && typeof value === 'string' && value.startsWith("'") && value.endsWith("'") && value.slice(1, -1) === previous[name]?.replaceAll('"', '')) {
      normalized[name] = previous[name]; repaired.push(name);
    }
  }
  const values = collectRecoveryMaterial(previous);
  for (const [name, value] of Object.entries(collectRecoveryMaterial(normalized))) {
    if (values[name] && values[name] !== value) throw Error('Runtime credential copies disagree. Resolve explicitly; provisioning never rotates keys.');
    values[name] = value;
  }
  for (const name of ['MARKETPLACE_ENCRYPTION_KEY', 'MARKETPLACE_AUTH_SECRET', 'MARKETPLACE_ATTESTATION_KEY']) {
    if (!values[name]) throw Error(name + ' must already exist. Provisioning never creates or replaces runtime/signing keys implicitly.');
  }
  new Wallet(values.MARKETPLACE_ATTESTATION_KEY);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(values.MARKETPLACE_ENCRYPTION_KEY) || Buffer.from(values.MARKETPLACE_ENCRYPTION_KEY, 'base64').length !== 32 || Buffer.byteLength(values.MARKETPLACE_AUTH_SECRET) < 32) throw Error('Invalid preserved runtime key.');
  values.MARKETPLACE_ENCRYPTION_KEY_VERSION ||= 'v1';
  let ring;
  try { ring = JSON.parse(values.MARKETPLACE_ENCRYPTION_KEYRING || '{}'); } catch { throw Error('Invalid encryption keyring.'); }
  if (!ring || typeof ring !== 'object' || Array.isArray(ring) || Object.values(ring).some(value => typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value))) throw Error('Invalid encryption keyring.');
  ring.legacy ||= values.MARKETPLACE_ENCRYPTION_KEY;
  const version = values.MARKETPLACE_ENCRYPTION_KEY_VERSION;
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(version) || (ring[version] && ring[version] !== values.MARKETPLACE_ENCRYPTION_KEY)) throw Error('Active encryption version disagrees with preserved keyring.');
  ring[version] = values.MARKETPLACE_ENCRYPTION_KEY;
  values.MARKETPLACE_ENCRYPTION_KEYRING = JSON.stringify(ring);
  if (normalized.MARKETPLACE_BACKUP_KEY && previous.MARKETPLACE_BACKUP_KEY && normalized.MARKETPLACE_BACKUP_KEY !== previous.MARKETPLACE_BACKUP_KEY) throw Error('Backup-key copies disagree; preserve existing backups and resolve explicitly.');
  return { material: values, legacyBackupKey: normalized.MARKETPLACE_BACKUP_KEY || previous.MARKETPLACE_BACKUP_KEY, repaired };
}
export function provisionRoleKeys(material, { createDecisionKey = false, replaceUnactivatedAttestationKey = false, deployment } = {}) {
  const values = { ...material }, priorMaterial = { ...material };
  if (createDecisionKey) {
    if (values.MARKETPLACE_DECISION_KEY || values.MARKETPLACE_DECISION_KEY_ID) throw Error('Decision key already exists; explicit rotation is a separate operation.');
    values.MARKETPLACE_DECISION_KEY = randomBytes(48).toString('base64');
    values.MARKETPLACE_DECISION_KEY_ID = 'decision-' + randomBytes(8).toString('hex');
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(values.MARKETPLACE_DECISION_KEY_ID || '') || Buffer.byteLength(values.MARKETPLACE_DECISION_KEY || '') < 32) throw Error('An independent versioned decision key is required.');
  if ([values.MARKETPLACE_AUTH_SECRET, values.MARKETPLACE_ENCRYPTION_KEY, values.MARKETPLACE_ATTESTATION_KEY].includes(values.MARKETPLACE_DECISION_KEY)) throw Error('Decision key cannot reuse any runtime role key.');
  if (replaceUnactivatedAttestationKey) {
    if (deployment?.status !== 'not-deployed' || deployment.address || deployment.evaluator || deployment.transactionHash || deployment.deploymentTransaction) throw Error('Fresh initial signer requires an explicit never-activated V2 deployment sentinel.');
    values.MARKETPLACE_ATTESTATION_KEY = Wallet.createRandom().privateKey;
    // Old signer remains in the encrypted prior-material archive, not active signing custody.
  }
  return { material: values, priorMaterial };
}
export function preserveQuotedArtifactKeyVersion(material, authenticatedBackup) {
  validateSnapshot(authenticatedBackup);
  const version = material.MARKETPLACE_ENCRYPTION_KEY_VERSION;
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(version || '')) throw Error('An explicit valid active version is required.');
  const alias = "'" + version + "'";
  if (!authenticatedBackup.records.some(record => record.type === 'string' && record.suffix.startsWith('artifact:') && JSON.parse(record.value).encrypted?.keyVersion === alias)) throw Error('Authenticated historical backup does not prove the exact quoted active version.');
  const ring = JSON.parse(material.MARKETPLACE_ENCRYPTION_KEYRING || '{}');
  if (ring[alias] && ring[alias] !== material.MARKETPLACE_ENCRYPTION_KEY) throw Error('Historical alias already points to another preserved key.');
  ring[alias] = material.MARKETPLACE_ENCRYPTION_KEY;
  return { ...material, MARKETPLACE_ENCRYPTION_KEYRING: JSON.stringify(ring) };
}
export function renderRuntimeEnv(text, material, backupKeyFile) {
  const remove = new Set([...Object.keys(material), 'MARKETPLACE_BACKUP_KEY', 'MARKETPLACE_BACKUP_KEY_FILE']);
  const kept = text.split(/\r?\n/).filter(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || !remove.has(match[1]);
  });
  const additions = { ...material, MARKETPLACE_BACKUP_KEY_FILE: backupKeyFile };
  for (const [name, value] of Object.entries(additions)) {
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw Error('Credential cannot be represented safely in the runtime env format.');
    // Literal apostrophes in historical JSON key IDs require a verified unquoted JSON line.
    const line = value.includes("'") ? name + '=' + value : name + "='" + value + "'";
    if (parseEnv(line)[name] !== value) throw Error('Credential cannot be represented safely in the runtime env format.');
    kept.push(line);
  }
  const rendered = kept.join('\n').replace(/\n*$/, '\n');
  const parsed = parseEnv(rendered);
  if (parsed.MARKETPLACE_BACKUP_KEY || Object.entries(additions).some(([key, value]) => parsed[key] !== value)) throw Error('Runtime env validation failed.');
  return rendered;
}
export async function provision({ apply = false, vaultOnly = false, manifest, repairLegacyEnv = false, createDecisionKey = false, replaceUnactivatedAttestationKey = false, legacyQuotedVersionBackup } = {}) {
  const envFile = path.resolve('.env.local'), runtimeFile = path.resolve('.local/marketplace-runtime-secrets.json');
  assertPrivatePath(envFile);
  if (fs.existsSync(runtimeFile)) assertPrivatePath(runtimeFile);
  const text = fs.readFileSync(envFile, 'utf8');
  const env = { ...parseEnv(text), ...process.env };
  const previous = fs.existsSync(runtimeFile) ? JSON.parse(fs.readFileSync(runtimeFile, 'utf8')) : {};
  const planned = planProvisioning(env, previous, { repairLegacyEnv });
  let material = planned.material;
  const { legacyBackupKey, repaired } = planned;
  const deployment = JSON.parse(fs.readFileSync('lib/marketplace-v2-deployment.json', 'utf8'));
  const recoveryFile = env.MARKETPLACE_RECOVERY_FILE || 'D:/NXR/secrets/onerub-marketplace-recovery.json';
  const canonicalRecoveryFile = fs.existsSync(recoveryFile) ? fs.realpathSync(recoveryFile) : null;
  if (apply && canonicalRecoveryFile) assertPrivatePath(canonicalRecoveryFile);
  const { backupKeyFile, materialDirectory } = localRecoveryPaths(env);
  if (!backupKeyFile || !materialDirectory || path.resolve(backupKeyFile).startsWith(path.resolve(materialDirectory) + path.sep)) throw Error('Backup-key custody must be outside the encrypted recovery material directory.');
  if (!apply && !vaultOnly) return { mode: 'plan', existingEncryptionAuthPreserved: true, plaintextReplication: false, changesApplied: false, backupKeyFile, materialDirectory, repairedNames: repaired, createDecisionKey, replaceUnactivatedAttestationKey };
  if (!apply && (createDecisionKey || replaceUnactivatedAttestationKey || repairLegacyEnv)) throw Error('Runtime repair/key generation requires --apply and verified original backup.');
  if (apply) {
    if (!manifest) throw Error('Apply requires --verified-credential-manifest from a successful DPAPI hardening backup.');
    // Verify full original byte backups before changing any local runtime file.
    const script = path.resolve('scripts/secure-local-credentials.ps1');
    const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'Verify', '-BackupManifest', path.resolve(manifest), '-RequireOriginalMatch', '-ApprovedRecoveryJunctionTarget', 'D:/PLER', '-IncludeDeployer'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    const expected = { env: envFile, runtime: runtimeFile, recovery: recoveryFile };
    if (!Object.entries(expected).every(([id, file]) => result.verified?.some(item => item.id === id && item.hashMatched && item.originalMatched && path.resolve(item.originalPath).toLowerCase() === path.resolve(file).toLowerCase()))) throw Error('Original credential backup verification failed.');
  }
  const roleKeys = provisionRoleKeys(material, { createDecisionKey, replaceUnactivatedAttestationKey, deployment });
  material = roleKeys.material;
  // Render and parse everything before touching any original file.
  let rendered;
  ensurePrivateDirectory(path.dirname(path.resolve(backupKeyFile)));
  let key;
  if (fs.existsSync(backupKeyFile)) {
    key = readBackupKey({ env: {}, keyFile: backupKeyFile });
    if (legacyBackupKey && key !== legacyBackupKey) throw Error('Existing vault key disagrees with legacy key; never rotate backup keys implicitly.');
  } else {
    key = legacyBackupKey || randomBytes(32).toString('base64');
    separateBackupKey(material, key);
    writePrivateFile(backupKeyFile, JSON.stringify(protectLocalBytes(Buffer.from(key))));
    if (readBackupKey({ env: {}, keyFile: backupKeyFile }) !== key) throw Error('DPAPI backup key roundtrip failed.');
  }
  separateBackupKey(material, key);
  let historicalArtifactsVerified = 0;
  if (legacyQuotedVersionBackup) {
    if (!apply || createDecisionKey || replaceUnactivatedAttestationKey || repairLegacyEnv) throw Error('Historical alias custody update cannot be combined with runtime key generation or repair.');
    assertPrivatePath(legacyQuotedVersionBackup);
    const historical = openBackup(JSON.parse(fs.readFileSync(legacyQuotedVersionBackup, 'utf8')), key);
    material = preserveQuotedArtifactKeyVersion(material, historical);
    const names = ['MARKETPLACE_ENCRYPTION_KEY', 'MARKETPLACE_ENCRYPTION_KEY_VERSION', 'MARKETPLACE_ENCRYPTION_KEYRING'];
    const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = material[name];
      historicalArtifactsVerified = verifyArtifactRecords(historical).checked;
    } finally { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
  }
  rendered = apply ? renderRuntimeEnv(text, material, path.resolve(backupKeyFile)) : undefined;
  ensurePrivateDirectory(materialDirectory);
  const materialFile = path.join(materialDirectory, 'runtime-' + Date.now() + '-' + randomUUID() + '.encrypted.json');
  const payload = { version: 1, purpose: 'onerub-runtime-material', material, priorMaterial: roleKeys.priorMaterial };
  writePrivateFile(materialFile, JSON.stringify(sealBackup(payload, key)));
  const reopened = openBackup(JSON.parse(fs.readFileSync(materialFile, 'utf8')), key);
  if (canonical(reopened) !== canonical(payload)) throw Error('Encrypted runtime material roundtrip failed.');
  if (apply) {
    const reference = JSON.stringify({ format: 'onerub-runtime-secret-reference-v1', runtimeFile: '.env.local', encryptedRecoveryMaterial: materialFile, backupKeyFile: path.resolve(backupKeyFile), originalCredentialArchive: path.resolve(manifest) }, null, 2);
    const originals = [[envFile, fs.readFileSync(envFile)], [runtimeFile, fs.readFileSync(runtimeFile)]];
    if (canonicalRecoveryFile) originals.push([canonicalRecoveryFile, fs.readFileSync(canonicalRecoveryFile)]);
    try {
      writePrivateFile(envFile, rendered, { exclusive: false });
      // Other JSON files become non-secret references, not all-keys plaintext replicas.
      writePrivateFile(runtimeFile, reference, { exclusive: false });
      if (canonicalRecoveryFile) writePrivateFile(canonicalRecoveryFile, reference, { exclusive: false });
    } catch {
      let rollbackFailed = false;
      for (const [file, bytes] of originals) { try { writePrivateFile(file, bytes, { exclusive: false }); } catch { rollbackFailed = true; } }
      throw Error(rollbackFailed ? 'Provisioning failed and runtime rollback needs the verified original DPAPI archive.' : 'Provisioning failed; original runtime bytes were restored.');
    } finally { for (const [, bytes] of originals) bytes.fill(0); }
  }
  return { mode: apply ? 'apply' : 'vault-only', existingEncryptionAuthPreserved: true, backupKeyFile: path.resolve(backupKeyFile), encryptedRecoveryMaterial: materialFile, verified: true, plaintextReplication: false, originalsModified: apply, legacyOriginalsPreservedInVerifiedArchive: true, legacyPlaintextReplicasRemoved: apply, repairedNames: repaired, runtimeNames: Object.keys(material), evaluatorAddress: new Wallet(material.MARKETPLACE_ATTESTATION_KEY).address, decisionKeyCreated: createDecisionKey, initialSignerReplaced: replaceUnactivatedAttestationKey, historicalArtifactsVerified };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flags = process.argv.slice(2), index = flags.indexOf('--verified-credential-manifest'), legacyIndex = flags.indexOf('--legacy-quoted-version-backup');
  try { console.log(JSON.stringify(await provision({ apply: flags.includes('--apply'), vaultOnly: flags.includes('--vault-only'), manifest: index >= 0 ? flags[index + 1] : undefined, repairLegacyEnv: flags.includes('--repair-legacy-env'), createDecisionKey: flags.includes('--create-decision-key'), replaceUnactivatedAttestationKey: flags.includes('--replace-unactivated-attestation-key'), legacyQuotedVersionBackup: legacyIndex >= 0 ? flags[legacyIndex + 1] : undefined }))); }
  catch (error) { console.error(JSON.stringify({ error: error.code || 'PROVISIONING_FAILED', message: 'Guarded provisioning failed. Check backup/original equality, explicit flags and private key custody; no credential values were logged.' })); process.exitCode = 1; }
}
