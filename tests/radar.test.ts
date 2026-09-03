import { describe, it, expect } from 'vitest';
import { hillshade, radarProject, headingOf } from '../src/ui/hud/radar.ts';

const NORTH = headingOf(0, -1);
const EAST = headingOf(1, 0);

describe('headingOf', () => {
  it('measures clockwise from world north, which is -Z', () => {
    expect(NORTH).toBeCloseTo(0, 9);
    expect(EAST).toBeCloseTo(Math.PI / 2, 9);
    expect(headingOf(-1, 0)).toBeCloseTo(-Math.PI / 2, 9);
    expect(Math.abs(headingOf(0, 1))).toBeCloseTo(Math.PI, 9);
  });
});

describe('radarProject', () => {
  it('puts whatever is ahead of you at the top of the radar', () => {
    // facing north, something to the north
    const a = radarProject(0, -50, NORTH, 100, 80);
    expect(a.y).toBeLessThan(0);
    expect(Math.abs(a.x)).toBeLessThan(1e-9);
    // facing east, something to the east is still "ahead" and so still up
    const b = radarProject(50, 0, EAST, 100, 80);
    expect(b.y).toBeLessThan(0);
    expect(Math.abs(b.x)).toBeLessThan(1e-9);
  });

  it('puts what is on your right on the right, at every heading', () => {
    for (let yaw = -Math.PI; yaw <= Math.PI; yaw += Math.PI / 8) {
      // a point 50 units to the player's own right
      const rightX = Math.cos(yaw);
      const rightZ = Math.sin(yaw);
      const p = radarProject(50 * rightX, 50 * rightZ, yaw, 100, 80);
      expect(p.x).toBeGreaterThan(0);
      expect(Math.abs(p.y)).toBeLessThan(1e-9);
    }
  });

  it('scales range to the rim and reports nothing clamped inside it', () => {
    const p = radarProject(0, -100, NORTH, 100, 80);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(80, 9);
    expect(p.clamped).toBe(false);
  });

  it('pins a distant target to the rim, keeping its bearing', () => {
    const far = radarProject(0, -5000, NORTH, 100, 80);
    expect(far.clamped).toBe(true);
    expect(Math.hypot(far.x, far.y)).toBeCloseTo(80, 9);
    expect(far.y).toBeLessThan(0); // still says "north of you"
    const near = radarProject(0, -50, NORTH, 100, 80);
    expect(Math.atan2(far.y, far.x)).toBeCloseTo(Math.atan2(near.y, near.x), 9);
  });

  it('survives a target exactly on the player without dividing by zero', () => {
    const p = radarProject(0, 0, NORTH, 100, 80);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});

describe('hillshade', () => {
  it('is brightest on slopes facing the light and darkest on those facing away', () => {
    const flat = hillshade(0, 0);
    // ground rising toward +x/+z tilts its normal toward the north-west light
    const facingLight = hillshade(0.6, 0.6);
    const facingAway = hillshade(-0.6, -0.6);
    expect(facingLight).toBeGreaterThan(flat);
    expect(flat).toBeGreaterThan(facingAway);
  });

  it('stays inside 0..1 for any slope, however absurd', () => {
    for (const g of [-1e6, -10, -1, 0, 1, 10, 1e6]) {
      const v = hillshade(g, -g);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('separates a ridge from flat ground enough to read', () => {
    // the point of the layer: a drivable flat and a wall must not look alike
    expect(Math.abs(hillshade(0, 0) - hillshade(-1.2, -1.2))).toBeGreaterThan(0.15);
  });
});
