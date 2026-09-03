import { describe, it, expect } from 'vitest';
import { navOrientation, navOps, navTransform, GROUND_LEAN } from '../src/ui/hud/navArrow.ts';

/**
 * CSS transform space: X right, Y DOWN, Z toward the viewer. The chevron's
 * clip-path puts its apex at the top of the box, so at rest the nose is (0,-1,0).
 */
type Vec = readonly [number, number, number];
const APEX: Vec = [0, -1, 0];
/** Straight out of the plate's face before any rotation — the plate's normal. */
const NORMAL: Vec = [0, 0, 1];

const rot = (axis: 'x' | 'z', deg: number, v: Vec): Vec => {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return axis === 'x'
    ? [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]
    : [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
};

/** Apply exactly what the component emits, ops listed outermost first. */
const place = (yaw: number, v: Vec = APEX): Vec => {
  const ops = navOps(navOrientation(yaw, 1000));
  let out = v;
  for (let i = ops.length - 1; i >= 0; i--) out = rot(ops[i]![0], ops[i]![1], out);
  return out;
};

const bearings = (): number[] => {
  const out: number[] = [];
  for (let yaw = -Math.PI; yaw <= Math.PI + 1e-9; yaw += Math.PI / 12) out.push(yaw);
  return out;
};

describe('nav chevron orientation', () => {
  it('points where the target is, not at the mirror of it', () => {
    const ahead = place(0);
    expect(ahead[1]).toBeLessThan(0);              // up the screen
    expect(Math.abs(ahead[0])).toBeLessThan(1e-9); // dead centre
    expect(ahead[2]).toBeLessThan(0);              // leaning away from the camera

    expect(place(Math.PI / 2)[0]).toBeGreaterThan(0.5);  // target right → nose right
    expect(place(-Math.PI / 2)[0]).toBeLessThan(-0.5);   // target left  → nose left

    const behind = place(Math.PI);
    expect(behind[1]).toBeGreaterThan(0); // down the screen
    expect(behind[2]).toBeGreaterThan(0); // swung toward the camera, so it looms
  });

  it('never rolls: the plate normal is identical at every bearing', () => {
    const base = place(0, NORMAL);
    for (const yaw of bearings()) {
      const n = place(yaw, NORMAL);
      for (let i = 0; i < 3; i++) expect(n[i]).toBeCloseTo(base[i]!, 9);
    }
  });

  it('never turns edge-on: the plate holds one fixed angle to the camera', () => {
    for (const yaw of bearings()) {
      expect(place(yaw, NORMAL)[2]).toBeCloseTo(Math.cos((GROUND_LEAN * Math.PI) / 180), 9);
    }
  });

  it('sweeps monotonically through a turn instead of flipping', () => {
    let prev = -Infinity;
    for (let yaw = -Math.PI / 2; yaw <= Math.PI / 2 + 1e-9; yaw += Math.PI / 36) {
      const x = place(yaw)[0];
      expect(x).toBeGreaterThan(prev);
      prev = x;
    }
  });

  it('shrinks and fades only as the beacon takes over near the target', () => {
    const far = navOrientation(0, 400);
    expect(far.scale).toBe(1);
    expect(far.opacity).toBe(1);
    const near = navOrientation(0, 0);
    expect(near.scale).toBeLessThan(far.scale);
    expect(near.opacity).toBeLessThan(far.opacity);
    expect(near.opacity).toBeGreaterThan(0);
  });

  it('emits the transform in the same order as the ops', () => {
    expect(navTransform(navOrientation(Math.PI / 2, 1000)))
      .toBe(`rotateX(${GROUND_LEAN.toFixed(2)}deg) rotateZ(90.00deg) scale(1.000)`);
  });
});
