// Node.js: freeze public source identity at build time; hosting metadata is never authoritative.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true});
  if (result.error || result.status !== 0) throw Error('Release provenance requires a Git checkout with readable HEAD');
  return result.stdout;
}
const safePath = name => /^[a-zA-Z0-9_./@()[\] -]+$/.test(name) && !name.split('/').some(p => p.startsWith('.') && !['.github'].includes(p)) && !/(^|\/)(secrets?|credentials?)(\/|\.)/i.test(name) && !/\.(pem|key|dpapi)$/i.test(name);
const runtimePath = name => safePath(name) && (/^(app|lib|public|contracts|scripts)\//.test(name) || /^(package(-lock)?\.json|next\.config\.[cm]?js|jsconfig\.json|vercel\.json|\.github\/workflows\/release-verification\.yml)$/.test(name));
function fileDigest(root, names) {
  return sha256(JSON.stringify(names.map(name => {
    const file = path.join(root, name);
    return [name, fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null];
  })));
}
export function createReleaseManifest({root = defaultRoot, env = process.env, builtAt = new Date().toISOString()} = {}) {
  const sourceCommit = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) throw Error('Invalid source commit');
  const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const changed = git(root, ['diff', '--name-only', '-z', 'HEAD', '--']).split('\0').filter(Boolean);
  const dirtyPaths = [...new Set([...changed, ...untracked])].filter(runtimePath).sort();
  const names = [...new Set([...tracked, ...untracked])].filter(runtimePath).sort();
  const sourceDigest = fileDigest(root, names);
  const routes = names.filter(n => /^app\/.*\/(route|page)\.[cm]?[jt]sx?$/.test(n) || /^app\/(page|route)\.[jt]sx?$/.test(n)).filter(n => fs.existsSync(path.join(root,n))).map(n => {
    const route = n.replace(/^app/, '').replace(/\/(page|route)\.[cm]?[jt]sx?$/, '').replace(/\/\([^/]+\)/g, '');
    return route || '/';
  }).sort();
  const rawHostingCommit = env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || '';
  const hostingCommit = /^[a-f0-9]{40,64}$/i.test(rawHostingCommit) ? rawHostingCommit.toLowerCase() : null;
  return {
    schemaVersion: 1, sourceCommit, sourceDigest, sourceDigestAlgorithm: 'sha256-sorted-path-and-byte-digests-v1',
    sourceFileCount: names.length, dirty: dirtyPaths.length > 0,
    dirtyDigest: fileDigest(root, dirtyPaths), dirtyFiles: dirtyPaths,
    hostingCommit, hostingCommitMatchesSource: hostingCommit === null ? null : hostingCommit === sourceCommit,
    buildId: sourceCommit.slice(0,12) + '-' + sourceDigest.slice(0,20), builtAt, routes,
    // This identifies build inputs, not a reproducible binary or a cryptographic signature.
    evidence: {source: 'git-head-and-build-workspace', dirtyScope: 'runtime-source-inputs', signed: false},
  };
}
export function writeReleaseManifest(options = {}) {
  const root = options.root || defaultRoot;
  const manifest = createReleaseManifest(options);
  if (options.requireClean && manifest.dirty) throw Error('Release requires a clean runtime source tree');
  const target = path.join(root, 'artifacts/release/manifest.json');
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const manifest = writeReleaseManifest({requireClean: process.argv.includes('--require-clean')});
  console.log(JSON.stringify(manifest));
}
