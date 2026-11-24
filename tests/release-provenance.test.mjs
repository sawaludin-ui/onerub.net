// Isolated Git fixtures only; no deployment credentials or provider calls.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createReleaseManifest, writeReleaseManifest} from '../scripts/build-release-manifest.mjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onerub-release-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, ...args], {encoding:'utf8',windowsHide:true});
    assert.equal(result.status, 0, result.stderr);return result.stdout.trim();
  };
  const put = (name, value) => {fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),value);};
  git('init');git('config','user.name','Synthetic fixture');git('config','user.email','fixture@example.invalid');git('config','core.autocrlf','false');
  put('.gitignore','artifacts/\n.env*\n.local/\n');
  put('app/api/release/route.js','export const GET = () => Response.json({});\n');
  put('app/page.js','export default function Page() {}\n');
  put('lib/runtime.mjs','export const value = 1;\n');
  put('package-lock.json','{}\n');git('add','.');git('commit','-m','Synthetic clean source');
  return {root,git,put};
}
test('clean source digest and build ID reproducible; generated manifest does not hash itself',t=>{
  const f=fixture(t),options={root:f.root,env:{},builtAt:'2026-11-24T17:00:00.000Z'};
  const a=writeReleaseManifest(options),b=createReleaseManifest(options);
  assert.deepEqual(a,b);assert.equal(a.dirty,false);assert.equal(a.sourceCommit,f.git('rev-parse','HEAD'));
  assert.deepEqual(a.routes,['/','/api/release']);assert.equal(a.sourceFileCount,4);
  assert.equal(a.hostingCommit,null);assert.equal(a.hostingCommitMatchesSource,null);
});
test('stale hosting SHA cannot substitute for actual Git HEAD',t=>{
  const f=fixture(t),a=createReleaseManifest({root:f.root,env:{VERCEL_GIT_COMMIT_SHA:'a'.repeat(40)}});
  assert.equal(a.sourceCommit,f.git('rev-parse','HEAD'));assert.equal(a.hostingCommit,'a'.repeat(40));assert.equal(a.hostingCommitMatchesSource,false);
  const b=createReleaseManifest({root:f.root,env:{VERCEL_GIT_COMMIT_SHA:'secret-value-not-a-sha'}});
  assert.equal(b.hostingCommit,null);assert.ok(!JSON.stringify(b).includes('secret-value'));
});
test('changed, staged, new and deleted runtime inputs alter digest and fail clean gate',t=>{
  const f=fixture(t),options={root:f.root,env:{}},a=createReleaseManifest(options);
  f.put('lib/runtime.mjs','export const value = 2;\n');f.git('add','lib/runtime.mjs');
  f.put('lib/new.mjs','export const added = true;\n');fs.unlinkSync(path.join(f.root,'app/page.js'));
  const b=createReleaseManifest(options);assert.notEqual(a.sourceDigest,b.sourceDigest);assert.notEqual(a.buildId,b.buildId);
  assert.equal(b.dirty,true);assert.deepEqual(b.dirtyFiles,['app/page.js','lib/new.mjs','lib/runtime.mjs']);assert.ok(!b.routes.includes('/'));
  assert.throws(()=>writeReleaseManifest({...options,requireClean:true}),/clean runtime source/);
});
test('ignored credentials and generated files never affect public provenance',t=>{
  const f=fixture(t),options={root:f.root,env:{}};const a=createReleaseManifest(options);
  f.put('.env.local','SYNTHETIC_SECRET=do-not-publish');f.put('.local/private.json','do-not-publish');f.put('artifacts/release/manifest.json','{}');
  const b=createReleaseManifest(options);assert.equal(a.sourceDigest,b.sourceDigest);assert.equal(b.dirty,false);assert.ok(!JSON.stringify(b).includes('do-not-publish'));
});
test('public endpoint freezes imported manifest and never reads runtime provider SHA',()=>{
  const source=fs.readFileSync(new URL('../app/api/release/route.js',import.meta.url),'utf8');
  assert.match(source,/import manifest from/);assert.match(source,/no-store/);assert.doesNotMatch(source,/process\.env|readFile|exec|spawn/);
});
