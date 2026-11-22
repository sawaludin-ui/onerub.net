// Node.js / encrypted backups and explicitly isolated Redis drills. Never prints credentials.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { keccak256 } from 'ethers';
import { store, storePrefix, artifactKey, encryptArtifact, hash, canonical } from '../lib/marketplace-core.mjs';
import {
  snapshot, sealBackup, openBackup, restoreSnapshot, verifyArtifactRecords, validateSnapshot,
  readBackupKey, collectRecoveryMaterial, separateBackupKey, applyRecoveryMaterial,
  assertPrivatePath, ensurePrivateDirectory, writePrivateFile,
} from '../lib/marketplace-recovery.mjs';

export function loadRecoveryEnvironment(text, env = process.env) {
  const local = parseEnv(text);
  // A key inherited from the caller is intentional injection; a key in .env.local is NOT.
  delete local.MARKETPLACE_BACKUP_KEY;
  for (const [name, value] of Object.entries(local)) if (env[name] === undefined) env[name] = value;
}
export function loadRecoveryMaterial(file, key) {
  assertPrivatePath(file);
  const payload = openBackup(JSON.parse(fs.readFileSync(file, 'utf8')), key);
  if (payload.version !== 1 || payload.purpose !== 'onerub-runtime-material') throw Error('Unsupported runtime material vault.');
  applyRecoveryMaterial(payload.material);
}
export function dataOnlySnapshot(value) {
  validateSnapshot(value);
  // Intentionally excludes credentials, recoveryMaterial and provider/deployer configuration.
  return { version: 1, namespace: value.namespace, ...(value.capturedAt ? { capturedAt: value.capturedAt } : {}), records: value.records };
}
export async function runRecovery({ command = 'backup', sourceFile, materialFile, intoEmptyProduction = false, outputDirectory = process.env.MARKETPLACE_DATA_BACKUP_DIRECTORY || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'OneRubDataBackups')) } = {}) {
  if (!['backup', 'drill', 'restore', 'verify'].includes(command)) throw Error('Use backup, drill, verify <file>, or restore <file> --into-empty-production.');
  const key = readBackupKey();
  if (materialFile) loadRecoveryMaterial(materialFile, key);
  separateBackupKey(collectRecoveryMaterial(), key);
  if (command === 'restore' || command === 'verify') {
    if (!sourceFile) throw Error('An explicit encrypted snapshot file is required.');
    assertPrivatePath(sourceFile);
    const payload = openBackup(JSON.parse(fs.readFileSync(sourceFile, 'utf8')), key);
    validateSnapshot(payload);
    const integrity = verifyArtifactRecords(payload);
    if (command === 'verify') return { verified: true, records: payload.records.length, verifiedArtifacts: integrity.checked, sourceNamespace: payload.namespace, networkMutated: false };
    if (!intoEmptyProduction) throw Error('Restore requires --into-empty-production. Existing records are never overwritten.');
    if (payload.namespace !== storePrefix) throw Error('Backup belongs to another chain/escrow namespace. Reconcile it explicitly; cross-deployment restores are not automatic.');
    const { written, ...result } = await restoreSnapshot(payload, { namespace: storePrefix });
    return { ...result, ...integrity, restoredInto: storePrefix, existingRecordsOverwritten: false };
  }
  ensurePrivateDirectory(outputDirectory);
  const token = randomBytes(16).toString('hex');
  const sourceNamespace = command === 'drill' ? 'onerub:recovery-drill:' + token + ':source:' : storePrefix;
  const restoreNamespace = 'onerub:recovery-drill:' + token + ':restored:';
  const inserted = [], restored = [];
  let file;
  try {
    if (command === 'drill') {
      const suffix = artifactKey('1', '0x0000000000000000000000000000000000000001');
      const bytes = Buffer.from('Synthetic isolated OneRub Redis recovery drill. No participant data.');
      const encrypted = encryptArtifact(bytes, suffix);
      const value = { size: bytes.length, encrypted, contentHash: hash(encrypted), plaintextHash: keccak256(bytes), syntheticRecoveryDrill: true };
      const exact = sourceNamespace + suffix;
      if (await store.command('SET', exact, JSON.stringify(value), 'NX', 'EX', '600') !== 'OK') throw Error('Isolated fixture namespace collision. Nothing was overwritten.');
      inserted.push(exact);
    }
    const data = dataOnlySnapshot(await snapshot({ namespace: sourceNamespace }));
    const integrity = verifyArtifactRecords(data);
    file = path.join(outputDirectory, 'marketplace-' + Date.now() + '-' + randomUUID() + '.encrypted.json');
    writePrivateFile(file, JSON.stringify(sealBackup(data, key)));
    const reopened = openBackup(JSON.parse(fs.readFileSync(file, 'utf8')), key);
    if (canonical(reopened) !== canonical(data)) throw Error('Snapshot read-after-write roundtrip differs.');
    validateSnapshot(reopened); verifyArtifactRecords(reopened);
    let drill;
    if (command === 'drill') {
      const result = await restoreSnapshot(reopened, { namespace: restoreNamespace, onWrite: key => restored.push(key) });
      const recovered = await snapshot({ namespace: restoreNamespace });
      const checked = verifyArtifactRecords(recovered);
      if (recovered.records.length !== reopened.records.length || checked.checked !== 1 || result.restored !== 1) throw Error('Isolated Redis recovery did not reproduce its synthetic artifact.');
      for (const item of recovered.records) {
        const original = reopened.records.find(record => record.suffix === item.suffix);
        if (!original || canonical(original.value) !== canonical(item.value)) throw Error('Recovered record bytes differ.');
      }
      drill = { passed: true, restored: result.restored, checked: checked.checked, sourceNamespace, restoreNamespace, productionNamespaceMutated: false };
    }
    return { file, records: data.records.length, verifiedArtifacts: integrity.checked, verified: true, credentialMaterialIncluded: false, encryption: 'AES-256-GCM with separately managed backup key', drill };
  } finally {
    // Only exact keys successfully inserted by this invocation are eligible for cleanup.
    const owned = [...inserted, ...restored];
    if (owned.length) {
      if (!owned.every(key => key.startsWith(sourceNamespace) && sourceNamespace.startsWith('onerub:recovery-drill:') || key.startsWith(restoreNamespace))) throw Error('Refusing cleanup outside the isolated drill namespaces.');
      await store.command('DEL', ...owned);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (fs.existsSync('.env.local')) loadRecoveryEnvironment(fs.readFileSync('.env.local', 'utf8'));
    const args = process.argv.slice(2), index = args.indexOf('--material-vault');
    console.log(JSON.stringify(await runRecovery({ command: args[0] || 'backup', sourceFile: args[1] && !args[1].startsWith('--') ? args[1] : undefined, materialFile: index >= 0 ? args[index + 1] : undefined, intoEmptyProduction: args.includes('--into-empty-production') })));
  } catch (error) { console.error(JSON.stringify({ error: error.code || 'RECOVERY_FAILED', message: 'Recovery failed closed. Check key custody, artifact integrity, explicit target and private ACL; no secret details were logged.' })); process.exitCode = 1; }
}
