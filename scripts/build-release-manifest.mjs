// Node.js: freeze public source identity at build time; hosting metadata is never authoritative.
// With Git available the manifest is rebuilt from HEAD. Without Git (Vercel build container) an
// existing frozen manifest is verified file-by-file against the shipped workspace; any byte that
// differs fails the build instead of claiming provenance.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const FROZEN = 'release/manifest.json';
const sha256 = value => createHash('sha256').update(value).digest('hex');
function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}
const safePath = name => /^[a-zA-Z0-9_./@()[\] -]+$/.test(name) && !name.split('/').some(p => p.startsWith('.') && !['.github'].includes(p)) && !/(^|\/)(secrets?|credentials?)(\/|\.)/i.test(name) && !/\.(pem|key|dpapi)$/i.test(name);
// Keep the digest to files that the hosting build actually uploads (.vercelignore excludes the rest).
const HOSTING_SKIPPED_SCRIPT = /^scripts\/(art\/|deploy[^/]*\.mjs$|preflight-deploy\.mjs$|recover-deployment\.mjs$|provision[^/]*\.mjs$|verify[^/]*\.mjs$|marketplace-recovery\.mjs$|secure-local-credentials\.ps1$)/;
const runtimePath = name => safePath(name) && (/^(app|lib|public|contracts)\//.test(name) || /^scripts\//.test(name) && !HOSTING_SKIPPED_SCRIPT.test(name) || /^(package(-lock)?\.json|next\.config\.[cm]?js|jsconfig\.json|vercel\.json|\.github\/workflows\/release-verification\.yml)$/.test(name));
const SKIP = new Set(['node_modules', '.next', '.git', '.local', '.vercel', 'artifacts', '.agents']);
function walk(root, prefix = '') {
  const out = [];
  const dir = path.join(root, prefix);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (SKIP.has(entry.name)) continue;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else if (entry.isFile() && runtimePath(rel)) out.push(rel);
  }
  return out;
}
const digestFiles = files => sha256(JSON.stringify(files.map(([name, digest]) => [name, digest])));
function fileDigest(root, names) {
  return sha256(JSON.stringify(names.map(name => {
    const file = path.join(root, name);
    return [name, fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null];
  })));
}
export function createReleaseManifest({ root = defaultRoot, env = process.env, builtAt = new Date().toISOString() } = {}) {
  const sourceCommit = (git(root, ['rev-parse', '--verify', 'HEAD']) || '').trim();
  if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) throw Error('Release provenance requires a Git checkout with readable HEAD');
  const tracked = (git(root, ['ls-files', '-z']) || '').split('\0').filter(Boolean);
  const untracked = (git(root, ['ls-files', '--others', '--exclude-standard', '-z']) || '').split('\0').filter(Boolean);
  const changed = (git(root, ['diff', '--name-only', '-z', 'HEAD', '--']) || '').split('\0').filter(Boolean);
  const dirtyPaths = [...new Set([...changed, ...untracked])].filter(runtimePath).sort();
  const names = [...new Set([...tracked, ...untracked])].filter(runtimePath).sort();
  const files = names.map(name => [name, fs.existsSync(path.join(root, name)) ? sha256(fs.readFileSync(path.join(root, name))) : null]);
  const sourceDigest = digestFiles(files);
  const routes = names.filter(n => /^app\/.*\/(route|page)\.[cm]?[jt]sx?$/.test(n) || /^app\/(page|route)\.[jt]sx?$/.test(n)).filter(n => fs.existsSync(path.join(root, n))).map(n => {
    const route = n.replace(/^app/, '').replace(/\/(page|route)\.[cm]?[jt]sx?$/, '').replace(/\/\([^/]+\)/g, '');
    return route || '/';
  }).sort();
  const rawHostingCommit = env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || '';
  const hostingCommit = /^[a-f0-9]{40,64}$/i.test(rawHostingCommit) ? rawHostingCommit.toLowerCase() : null;
  return {
    schemaVersion: 2, sourceCommit, sourceDigest, sourceDigestAlgorithm: 'sha256-sorted-path-and-byte-digests-v1',
    sourceFileCount: names.length, files, dirty: dirtyPaths.length > 0,
    dirtyDigest: fileDigest(root, dirtyPaths), dirtyFiles: dirtyPaths,
    hostingCommit, hostingCommitMatchesSource: hostingCommit === null ? null : hostingCommit === sourceCommit,
    buildId: sourceCommit.slice(0, 12) + '-' + sourceDigest.slice(0, 20), builtAt, routes,
    // Identifies build inputs, not a reproducible binary and not a cryptographic signature.
    evidence: { source: 'git-head-and-build-workspace', signed: false },
  };
}
export function readFrozen(root = defaultRoot) {
  const file = path.join(root, FROZEN);
  if (!fs.existsSync(file)) throw Error('No frozen release manifest and no Git checkout to create one');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
// Remote/Vercel: prove the shipped workspace is byte-identical to the reviewed commit.
export function verifyFrozenManifest({ root = defaultRoot, env = process.env } = {}) {
  const manifest = readFrozen(root);
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.files) || !/^[a-f0-9]{40,64}$/.test(manifest.sourceCommit || '')) throw Error('Frozen release manifest is not verifiable');
  // Every reviewed file must exist byte-identical. Extra hosting-only files cannot affect the
  // reviewed entry points without changing one of these listed files.
  for (const [name, digest] of manifest.files) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) throw Error('Frozen manifest file is missing from the workspace: ' + name);
    if (sha256(fs.readFileSync(file)) !== digest) throw Error('Release workspace file changed after the frozen manifest: ' + name);
  }
  for (const entry of ['package.json', 'next.config.mjs', 'vercel.json']) {
    if (!manifest.files.some(([name]) => name === entry)) throw Error('Frozen manifest omits the build entry ' + entry);
  }
  if (digestFiles(manifest.files) !== manifest.sourceDigest) throw Error('Frozen release manifest digest is inconsistent');
  const rawHostingCommit = env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || '';
  const hostingCommit = /^[a-f0-9]{40,64}$/i.test(rawHostingCommit) ? rawHostingCommit.toLowerCase() : null;
  if (hostingCommit !== null && hostingCommit !== manifest.sourceCommit) throw Error('Hosting commit does not match the frozen source commit');
  return { ...manifest, hostingCommit, hostingCommitMatchesSource: hostingCommit === null ? null : hostingCommit === manifest.sourceCommit,
    evidence: { source: 'frozen-manifest-verified-against-workspace', signed: false, verifiedAt: new Date().toISOString() } };
}
export function writeReleaseManifest(options = {}) {
  const root = options.root || defaultRoot;
  const manifest = git(root, ['rev-parse', '--verify', 'HEAD']) && createReleaseManifest(options);
  if (!manifest) throw Error('Git checkout required to create a release manifest');
  if (options.requireClean && manifest.dirty) throw Error('Release requires a clean runtime source tree');
  const target = path.join(root, FROZEN);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
export function prepareReleaseManifest({ root = defaultRoot, env = process.env } = {}) {
  const target = path.join(root, FROZEN);
  if (git(root, ['rev-parse', '--verify', 'HEAD'])) return writeReleaseManifest({ root, env });
  const manifest = verifyFrozenManifest({ root, env });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ ...manifest, evidence: { ...manifest.evidence } }, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const command = process.argv[2] || 'prepare';
  const options = { requireClean: process.argv.includes('--require-clean') };
  const manifest = command === 'verify' ? verifyFrozenManifest({}) : command === 'create' ? writeReleaseManifest(options) : prepareReleaseManifest({});
  console.log(JSON.stringify({ buildId: manifest.buildId, sourceCommit: manifest.sourceCommit, sourceDigest: manifest.sourceDigest, dirty: manifest.dirty, evidence: manifest.evidence }));
}
