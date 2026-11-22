import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonical, decryptArtifact, hash, fail, store, storePrefix } from './marketplace-core.mjs';
import { keccak256 } from 'ethers';

function backupKey(raw = process.env.MARKETPLACE_BACKUP_KEY) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) fail('A separate canonical 32-byte recovery encryption key is required.', 503, 'RECOVERY_KEY_REQUIRED');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) fail('A separate 32-byte recovery encryption key is required.', 503, 'RECOVERY_KEY_REQUIRED');
  return key;
}
export function sealBackup(value, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', backupKey(key), iv);
  cipher.setAAD(Buffer.from('onerub-recovery-v1'));
  const ciphertext = Buffer.concat([cipher.update(canonical(value)), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function openBackup(envelope, key) {
  if (!envelope || envelope.version !== 1 || !/^[A-Za-z0-9+/]{16}$/.test(envelope.iv || '') || !/^[A-Za-z0-9+/]{22}==$/.test(envelope.tag || '') || typeof envelope.ciphertext !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.ciphertext)) fail('Invalid or unsupported backup envelope.', 400, 'INVALID_BACKUP');
  const decipher = createDecipheriv('aes-256-gcm', backupKey(key), Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from('onerub-recovery-v1')); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
}
// Local key custody is deliberately outside the data snapshot directory.
export function localRecoveryPaths(env = process.env) {
  const root = env.LOCALAPPDATA;
  return {
    backupKeyFile: env.MARKETPLACE_BACKUP_KEY_FILE || (root && path.join(root, 'OneRubBackupKey', 'backup-key.dpapi.json')),
    materialDirectory: env.MARKETPLACE_RECOVERY_VAULT_DIRECTORY || (root && path.join(root, 'OneRubCredentialRecovery', 'runtime-material')),
  };
}
const localSecretProgram = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$r = [Console]::In.ReadToEnd() | ConvertFrom-Json
$operator = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($operator, 'S-1-5-18', 'S-1-5-32-544')
function Ordinary($p) {
  $part = [IO.Path]::GetFullPath($p)
  while ($part) {
    if (Test-Path -LiteralPath $part) {
      if (((Get-Item -Force -LiteralPath $part).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unexpected reparse point.' }
    }
    $parent = Split-Path -Parent $part; if ($parent -eq $part) { break }; $part = $parent
  }
}
function PrivateAcl($p) {
  Ordinary $p
  $a = Get-Acl -LiteralPath $p
  if (-not $a.AreAccessRulesProtected) { throw 'Run credential ACL hardening first.' }
  if ($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'Unexpected owner.' }
  foreach ($rule in $a.Access) {
    if ($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow') { throw 'Unexpected credential access rule.' }
  }
  foreach ($sid in $allowed) {
    if (-not ($a.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl })) { throw 'Missing operator/admin access.' }
  }
}
switch ($r.operation) {
  'protect' {
    $b = [Convert]::FromBase64String($r.payload)
    try { [Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))) } finally { [Array]::Clear($b, 0, $b.Length) }
  }
  'unprotect' {
    $b = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($r.payload), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { [Console]::Write([Convert]::ToBase64String($b)) } finally { [Array]::Clear($b, 0, $b.Length) }
  }
  'assert' { PrivateAcl $r.path }
  'file-acl' {
    Ordinary $r.path
    $owner = (Get-Acl -LiteralPath $r.path).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $allowed) { throw 'Unexpected credential owner.' }
    $a = New-Object Security.AccessControl.FileSecurity; $a.SetAccessRuleProtection($true, $false)
    foreach ($sid in $allowed) { [void]$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'None', 'None', 'Allow'))) }
    [IO.File]::SetAccessControl($r.path, $a); PrivateAcl $r.path
  }
  'directory' {
    Ordinary $r.path
    if (Test-Path -LiteralPath $r.path) { PrivateAcl $r.path } else {
      [void](New-Item -ItemType Directory -Path $r.path)
      $a = New-Object Security.AccessControl.DirectorySecurity; $a.SetAccessRuleProtection($true, $false)
      foreach ($sid in $allowed) { [void]$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))) }
      [IO.Directory]::SetAccessControl($r.path, $a); PrivateAcl $r.path
    }
  }
  default { throw 'Invalid credential operation.' }
}
`;
function localSecretOperation(operation, file, bytes) {
  if (process.platform !== 'win32') fail('DPAPI requires Windows; inject an independently managed recovery key on other platforms.', 503, 'DPAPI_REQUIRED');
  try {
    // Secret bytes travel over local stdio, never command arguments, logs or tool output.
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(localSecretProgram, 'utf16le').toString('base64')], {
      input: JSON.stringify({ operation, path: file, payload: bytes?.toString('base64') }),
      encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch { fail('Local credential operation failed. Check private ACL, original Windows profile and DPAPI availability; no secret was logged.', 503, 'LOCAL_CREDENTIAL_FAILURE'); }
}
export function assertPrivatePath(file) {
  if (process.platform === 'win32') return localSecretOperation('assert', path.resolve(file));
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) fail('Credential path must be owner-only and not a symlink.', 503, 'CREDENTIAL_ACL_REQUIRED');
}
export function ensurePrivateDirectory(directory) {
  if (!directory) fail('An explicit private recovery directory is required.', 503, 'RECOVERY_DIRECTORY_REQUIRED');
  if (process.platform === 'win32') localSecretOperation('directory', path.resolve(directory));
  else { fs.mkdirSync(directory, { mode: 0o700, recursive: true }); assertPrivatePath(directory); }
}
export function writePrivateFile(file, bytes, { exclusive = true } = {}) {
  if (fs.existsSync(file)) assertPrivatePath(file);
  else assertPrivatePath(path.dirname(path.resolve(file)));
  fs.writeFileSync(file, bytes, { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
  // Windows inherits only the already-private folder, then freezes that exact file's ACL.
  if (process.platform === 'win32') localSecretOperation('file-acl', path.resolve(file));
  assertPrivatePath(file);
  const actual = fs.readFileSync(file), expected = Buffer.from(bytes);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('Private file read-after-write verification failed.', 503, 'RECOVERY_WRITE_FAILED');
}
export function protectLocalBytes(bytes) {
  return { format: 'onerub-dpapi-current-user-v1', scope: 'CurrentUser', ciphertext: localSecretOperation('protect', undefined, Buffer.from(bytes)) };
}
export function openLocalBytes(envelope) {
  if (envelope?.format !== 'onerub-dpapi-current-user-v1' || envelope.scope !== 'CurrentUser' || typeof envelope.ciphertext !== 'string') fail('Invalid local credential vault.', 400, 'INVALID_BACKUP');
  return Buffer.from(localSecretOperation('unprotect', undefined, Buffer.from(envelope.ciphertext, 'base64')), 'base64');
}
export function readBackupKey({ env = process.env, keyFile = localRecoveryPaths(env).backupKeyFile } = {}) {
  if (env.MARKETPLACE_BACKUP_KEY) { backupKey(env.MARKETPLACE_BACKUP_KEY); return env.MARKETPLACE_BACKUP_KEY; }
  if (!keyFile || !fs.existsSync(keyFile)) fail('An independently injected backup key or separate DPAPI backup-key file is required; runtime env files are not backup-key custody.', 503, 'RECOVERY_KEY_REQUIRED');
  assertPrivatePath(keyFile);
  const bytes = openLocalBytes(JSON.parse(fs.readFileSync(keyFile, 'utf8')));
  try { const value = bytes.toString('utf8'); backupKey(value); return value; } finally { bytes.fill(0); }
}
export const RECOVERY_MATERIAL_NAMES = Object.freeze([
  'MARKETPLACE_ENCRYPTION_KEY', 'MARKETPLACE_ENCRYPTION_KEY_VERSION', 'MARKETPLACE_ENCRYPTION_KEYRING',
  'MARKETPLACE_AUTH_SECRET', 'MARKETPLACE_ATTESTATION_KEY', 'MARKETPLACE_ATTESTATION_KEYS_JSON', 'MARKETPLACE_DECISION_KEY_ID', 'MARKETPLACE_DECISION_KEY',
  'MARKETPLACE_DECISION_KEYS_JSON', 'MARKETPLACE_DECISION_LEGACY_KEY', 'MARKETPLACE_DECISION_LEGACY_VERIFY_UNTIL',
]);
export function collectRecoveryMaterial(env = process.env) {
  return Object.fromEntries(RECOVERY_MATERIAL_NAMES.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
}
export function separateBackupKey(material, raw) {
  backupKey(raw);
  if (Object.values(material).some(value => value === raw)) fail('Backup key must be independent of runtime encryption and signing keys.', 503, 'RECOVERY_KEY_NOT_SEPARATE');
  if ('MARKETPLACE_BACKUP_KEY' in material) fail('Backup key cannot be included in recovery material.', 400, 'RECOVERY_KEY_NOT_SEPARATE');
}
export function applyRecoveryMaterial(material, env = process.env) {
  if (!material || typeof material !== 'object' || Array.isArray(material) || Object.keys(material).some(key => !RECOVERY_MATERIAL_NAMES.includes(key))) fail('Recovery material contains unsupported credentials.', 400, 'INVALID_BACKUP');
  for (const [name, value] of Object.entries(material)) {
    if (typeof value !== 'string' || (env[name] && env[name] !== value)) fail('Recovery material conflicts with configured runtime keys; resolve explicitly before restoring.', 409, 'RECOVERY_KEY_CONFLICT');
  }
  Object.assign(env, material);
}

export async function snapshot({ storage = store, namespace = storePrefix } = {}) {
  if (!/^onerub:[a-zA-Z0-9:_-]+:$/.test(namespace)) fail('Invalid recovery namespace.');
  const records = [], seen = new Set(); let cursor = '0';
  do {
    const result = await storage.command('SCAN', cursor, 'MATCH', namespace + '*', 'COUNT', '100');
    cursor = String(result[0]);
    for (const key of result[1]) {
      if (typeof key !== 'string' || !key.startsWith(namespace) || seen.has(key)) continue;
      seen.add(key);
      const suffix = key.slice(namespace.length);
      if (/^(nonce:|rate:|evaluation-lock:|events:|health:)/.test(suffix)) continue;
      const type = await storage.command('TYPE', key), ttl = Number(await storage.command('TTL', key));
      if (type === 'none' || ttl === -2) continue;
      if (!['string', 'hash'].includes(type)) fail('Unexpected record type in recovery namespace.', 409);
      const value = await storage.command(type === 'hash' ? 'HGETALL' : 'GET', key);
      records.push({ suffix, type, value, expiresAt: ttl >= 0 ? Date.now() + ttl * 1000 : null });
    }
  } while (cursor !== '0');
  return { version: 1, namespace, capturedAt: new Date().toISOString(), records };
}
export function validateSnapshot(backup) {
  if (backup?.version !== 1 || !/^onerub:[a-zA-Z0-9:_-]+:$/.test(backup.namespace || '') || !Array.isArray(backup.records) || (backup.capturedAt !== undefined && !Number.isFinite(Date.parse(backup.capturedAt)))) fail('Invalid recovery snapshot metadata.', 400, 'INVALID_BACKUP');
  const seen = new Set();
  for (const record of backup.records) {
    if (!record || !/^[a-zA-Z0-9:_-]+$/.test(record.suffix) || /^(nonce:|rate:|evaluation-lock:|events:|health:)/.test(record.suffix) || seen.has(record.suffix)) fail('Invalid or duplicate recovery record.', 400, 'INVALID_BACKUP');
    seen.add(record.suffix);
    if (record.expiresAt !== null && (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0)) fail('Invalid recovery expiry.', 400, 'INVALID_BACKUP');
    if (record.type === 'string') {
      if (typeof record.value !== 'string') fail('Invalid string record.', 400, 'INVALID_BACKUP');
    } else if (record.type === 'hash') {
      const entries = Array.isArray(record.value) ? record.value : record.value && typeof record.value === 'object' ? Object.entries(record.value).flat() : [];
      if (!entries.length || entries.length % 2 || entries.some(value => typeof value !== 'string')) fail('Invalid hash record.', 400, 'INVALID_BACKUP');
      const keys = entries.filter((_, i) => i % 2 === 0);
      if (new Set(keys).size !== keys.length) fail('Duplicate hash field.', 400, 'INVALID_BACKUP');
    } else fail('Unsupported restore record type.', 400, 'INVALID_BACKUP');
  }
}
export async function restoreSnapshot(backup, { storage = store, namespace, now = Date.now(), onWrite } = {}) {
  if (!/^onerub:[a-zA-Z0-9:_-]+:$/.test(namespace || '')) fail('An explicit isolated or production namespace is required.');
  validateSnapshot(backup);
  // Validate the entire snapshot and current target before the first mutation.
  for (const record of backup.records) {
    if ((record.expiresAt === null || record.expiresAt > now) && Number(await storage.command('EXISTS', namespace + record.suffix))) fail('Restore target already contains a record. Nothing is overwritten.', 409, 'RESTORE_CONFLICT');
  }
  let restored = 0, skippedExpired = 0;
  const written = [];
  for (const record of backup.records) {
    if (!/^[a-zA-Z0-9:_-]+$/.test(record.suffix)) fail('Invalid backup record key.');
    const ttl = record.expiresAt === null ? null : Math.floor((record.expiresAt - now) / 1000);
    if (ttl !== null && ttl <= 0) { skippedExpired++; continue; }
    const key = namespace + record.suffix;
    if (record.type === 'string') {
      const args = ['SET', key, record.value, 'NX']; if (ttl !== null) args.push('EX', String(ttl));
      if (await storage.command(...args) !== 'OK') fail('Restore target already contains this record. Nothing is overwritten.', 409, 'RESTORE_CONFLICT');
    } else if (record.type === 'hash') {
      const entries = Array.isArray(record.value) ? record.value : Object.entries(record.value).flat();
      if (await storage.command('EVAL', "if redis.call('EXISTS',KEYS[1])==1 then return 0 end; for i=2,#ARGV,2 do redis.call('HSET',KEYS[1],ARGV[i],ARGV[i+1]) end; if tonumber(ARGV[1])>0 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return 1", '1', key, String(ttl || -1), ...entries) !== 1) fail('Restore target already contains this hash.', 409, 'RESTORE_CONFLICT');
    } else fail('Unsupported restore record type.');
    restored++; written.push(key); onWrite?.(key);
  }
  return { restored, skippedExpired, written };
}
export function verifyArtifactRecords(backup) {
  let checked = 0;
  for (const item of backup.records.filter(r => r.type === 'string' && r.suffix.startsWith('artifact:'))) {
    const record = JSON.parse(item.value), bytes = decryptArtifact(record.encrypted, item.suffix);
    if (hash(record.encrypted) !== record.contentHash || keccak256(bytes) !== record.plaintextHash || bytes.length !== record.size) fail('Recovered artifact integrity check failed.', 409);
    checked++;
  }
  return { checked };
}
