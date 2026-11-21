import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEX_DIMENSIONS,
  RING_PRESETS,
  evaluateTilePose,
  wrapPhase,
} from '../lib/supplied-hex/loopMath.js';

test('RING_PRESETS preserves all 6 rings and required brand names', () => {
  assert.equal(RING_PRESETS.length, 6);
  for (const ring of RING_PRESETS) {
    assert.equal(ring.tiles.length, 6);
  }
  const brands = RING_PRESETS.flatMap((r) => r.tiles.map((t) => t.brand)).filter(
    (b) => b !== 'none',
  );
  assert.ok(brands.includes('ONERUB'));
  assert.ok(brands.includes('workday'));
  assert.ok(brands.includes('ORACLE'));
});

test('6 tiles per ring form exact 60-degree hexagonal symmetry', () => {
  const poses = Array.from({ length: 6 }, (_, i) => evaluateTilePose(0.1, i));
  for (let i = 0; i < 6; i++) {
    const next = (i + 1) % 6;
    let diff = poses[next].azimuth - poses[i].azimuth;
    if (diff < 0) diff += Math.PI * 2;
    assert.ok(
      Math.abs(diff - Math.PI / 3) < 1e-9,
      `Expected 60deg spacing, got ${diff}`,
    );
    assert.equal(poses[i].radius, HEX_DIMENSIONS.dockRadius);
    assert.equal(poses[i].tiltX, 0);
    assert.equal(poses[i].isDetached, false);
  }
});

test('loop boundary u=0 and u=1 match seamlessly with C1 continuity', () => {
  const eps = 1e-4;
  for (let i = 0; i < 6; i++) {
    const start = evaluateTilePose(0, i);
    const end = evaluateTilePose(1 - 1e-9, i);
    const justBefore = evaluateTilePose(1 - eps, i);
    const justAfter = evaluateTilePose(eps, i);

    assert.ok(Math.abs(start.y - end.y) < 1e-6);
    assert.ok(Math.abs(start.radius - end.radius) < 1e-6);
    assert.ok(Math.abs(start.tiltX - end.tiltX) < 1e-5);

    const vBefore = (end.y - justBefore.y) / eps;
    const vAfter = (justAfter.y - start.y) / eps;
    assert.ok(
      Math.abs(vBefore - vAfter) < 0.08,
      `Velocity discontinuity at loop seam: ${vBefore} vs ${vAfter}`,
    );
  }
});

test('core-to-flight transition at coreEndPhase is continuous without jumps', () => {
  const { coreEndPhase } = HEX_DIMENSIONS;
  const eps = 1e-4;
  for (let i = 0; i < 6; i++) {
    const before = evaluateTilePose(coreEndPhase - eps, i);
    const at = evaluateTilePose(coreEndPhase, i);
    const after = evaluateTilePose(coreEndPhase + eps, i);

    assert.ok(Math.abs(at.y - before.y) < 0.01);
    assert.ok(Math.abs(after.y - at.y) < 0.01);
    assert.ok(Math.abs(after.radius - at.radius) < 0.01);
  }
});

test('detached tiles travel upward during mid-flight with safe radial clearance from core', () => {
  const { coreEndPhase, innerApothem, tileDepth, rowPitch } = HEX_DIMENSIONS;
  const outerCoreRadius = innerApothem + tileDepth;
  const flightSpan = 1 - coreEndPhase;
  // Mid-flight s in [0.24, 0.72] -> strictly inside upward glide segment
  const uEarly = coreEndPhase + 0.26 * flightSpan;
  const uMid = coreEndPhase + 0.48 * flightSpan;
  const uLate = coreEndPhase + 0.70 * flightSpan;

  for (let i = 0; i < 6; i++) {
    const p1 = evaluateTilePose(uEarly, i);
    const p2 = evaluateTilePose(uMid, i);
    const p3 = evaluateTilePose(uLate, i);

    assert.equal(p1.isDetached, true);
    assert.equal(p2.isDetached, true);
    assert.ok(p2.y > p1.y, `Expected upward ascent: ${p2.y} > ${p1.y}`);
    assert.ok(p3.y > p2.y, `Expected upward ascent: ${p3.y} > ${p2.y}`);

    // While passing beside docked rings (-1.5*rowPitch .. +1.5*rowPitch), inner face must clear core outer radius
    if (p2.y > -1.6 * rowPitch && p2.y < 1.6 * rowPitch) {
      const innerEdgeRadius = p2.radius - tileDepth * 0.5;
      assert.ok(
        innerEdgeRadius > outerCoreRadius + 0.25,
        `Collision risk at y=${p2.y}: innerEdge=${innerEdgeRadius}, coreOuter=${outerCoreRadius}`,
      );
    }
  }
});

test('wrapPhase normalizes negative and >1 phases into [0, 1)', () => {
  assert.ok(Math.abs(wrapPhase(1.25) - 0.25) < 1e-12);
  assert.ok(Math.abs(wrapPhase(-0.25) - 0.75) < 1e-12);
  assert.equal(wrapPhase(0), 0);
});
