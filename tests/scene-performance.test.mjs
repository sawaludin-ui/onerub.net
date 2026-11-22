import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOfficeScene} from '../lib/office-scene.js';
import {readFile} from 'node:fs/promises';
import {createFrameScheduler} from '../lib/supplied-hex/frameScheduler.js';
import {evaluateTilePose, HEX_DIMENSIONS} from '../lib/supplied-hex/loopMath.js';

function fixture(software = false, fenceAvailable = true) {
  let id = 0, time = 0, draws = 0, continuous = true, signaled = false;
  const tasks = new Map(), fences = new Set(), delays = [];
  const enqueue = (cb, delay) => { tasks.set(++id, cb); delays.push(delay); return id; };
  const host = {
    requestAnimationFrame: cb => enqueue(cb, 16), cancelAnimationFrame: id => tasks.delete(id),
    setTimeout: enqueue, clearTimeout: id => tasks.delete(id),
  };
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 1, SYNC_STATUS: 2, UNSIGNALED: 3,
    fenceSync() { if (!fenceAvailable) return null; const sync = {}; fences.add(sync); return sync; },
    deleteSync(sync) { assert.ok(fences.delete(sync), 'each fence deleted exactly once'); },
    getSyncParameter() { return signaled ? 4 : 3; }, flush() {},
  };
  const scheduler = createFrameScheduler({software, gl, host, now: () => time,
    draw: () => { draws++; scheduler.request(); return continuous; }});
  return {scheduler, tasks, fences, delays, get draws() { return draws; },
    step() { const [key, cb] = tasks.entries().next().value; tasks.delete(key); time += 16; cb(); },
    idle() { continuous = false; }, signal() { signaled = true; }};
}

test('scene module links without nonexistent erased type imports', () => {
  assert.equal(typeof createOfficeScene, 'function');
});

test('visible rendering retains one RAF per frame; suspension cancels work and resumes', () => {
  const f = fixture();
  f.scheduler.request(); f.scheduler.request();
  assert.equal(f.tasks.size, 1);
  for (let i = 0; i < 120; i++) f.step();
  assert.equal(f.draws, 120); assert.equal(f.tasks.size, 1);
  f.scheduler.setActive(false);
  assert.equal(f.tasks.size, 0);
  f.scheduler.request(); assert.equal(f.tasks.size, 0);
  f.scheduler.setActive(true); f.step(); assert.equal(f.draws, 121);
  f.scheduler.dispose(); assert.equal(f.tasks.size, 0);
  f.scheduler.setActive(true); assert.equal(f.tasks.size, 0);
});

test('idle view stops RAF, then interaction requests a single demand draw', () => {
  const f = fixture(); f.idle(); f.scheduler.request(); f.step();
  assert.equal(f.draws, 1); assert.equal(f.tasks.size, 0);
  f.scheduler.request(); f.scheduler.request(); f.step();
  assert.equal(f.draws, 2); assert.equal(f.tasks.size, 0);
  f.scheduler.dispose(); f.scheduler.dispose();
});

test('software suspension and disposal delete pending GPU fences without polling leaks', () => {
  const f = fixture(true); f.scheduler.request();
  assert.equal(f.fences.size, 1); f.step(); assert.equal(f.tasks.size, 1);
  f.scheduler.setActive(false);
  assert.equal(f.fences.size, 0); assert.equal(f.tasks.size, 0);
  f.scheduler.setActive(true); assert.equal(f.fences.size, 1);
  f.scheduler.dispose(); assert.equal(f.fences.size, 0); assert.equal(f.tasks.size, 0);
});

test('software path retains original 5ms fence polling and 80ms draw cadence', () => {
  const f = fixture(true); f.scheduler.request(); f.signal(); f.step();
  assert.deepEqual(f.delays, [5, 80]); assert.equal(f.fences.size, 0);
  f.step(); assert.equal(f.draws, 1); assert.equal(f.fences.size, 1);
  f.scheduler.dispose(); assert.equal(f.fences.size, 0);
  const fallback = fixture(true, false); fallback.scheduler.request();
  assert.deepEqual(fallback.delays, [80]); fallback.scheduler.dispose();
});

test('all sampled original poses are identical and caller-owned output avoids frame allocations', () => {
  // SHA256 of 9,608 original HEAD pose results, including wrap/core/flight boundaries.
  const hash = createHash('sha256'), scratch = {};
  for (let p = -100; p <= 1100; p++) for (let t = -1; t <= 6; t++) {
    const actual = evaluateTilePose(p / 1000, t, HEX_DIMENSIONS, scratch);
    assert.equal(actual, scratch);
    assert.deepEqual(actual, evaluateTilePose(p / 1000, t));
    hash.update(JSON.stringify(actual));
  }
  assert.equal(hash.digest('hex'), 'f885211b3a7f5e5dc38bbc1ef9c69e5168d34e3dd704263401a76724aa3c66c4');
  assert.notEqual(evaluateTilePose(0, 0), evaluateTilePose(0, 0));
});

test('visibility wiring separates motion preferences from offscreen suspension and frees render targets', async () => {
  const component = await readFile(new URL('../app/components/OfficeSculpture.js', import.meta.url), 'utf8');
  const scene = await readFile(new URL('../lib/supplied-hex/hexTowerScene.js', import.meta.url), 'utf8');
  assert.match(component, /const active=ready&&visible&&foreground&&!failed/);
  assert.ok(component.includes('setActive(active)'));
  assert.match(component, /const playing=ready&&motion&&!failed/);
  assert.ok(scene.includes('if (active && !wasActive) lastTime = performance.now()'));
  assert.ok(scene.includes('environmentTarget.dispose()'));
  assert.ok(scene.includes('keyLight.shadow.dispose()'));
  assert.ok(scene.includes('if (w === lastWidth && h === lastHeight) return'));
});
