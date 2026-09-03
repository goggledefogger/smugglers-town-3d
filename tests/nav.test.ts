import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { NavGrid } from '../src/core/ai/NavGrid.ts';
import type { BuildingCollider } from '../src/core/physics/VehicleBody.ts';

function box(x0: number, z0: number, x1: number, z1: number): BuildingCollider {
  return { min: new Vector3(x0, 0, z0), max: new Vector3(x1, 20, z1) };
}

describe('NavGrid', () => {
  it('marks cells under colliders (with a car-width margin) and nothing else', () => {
    const g = new NavGrid(60);
    expect(g.isEmpty).toBe(true);
    g.rebuild([box(-1.5, -15, 1.5, 15)]);
    expect(g.isEmpty).toBe(false);
    expect(g.isBlockedAt(0, 0)).toBe(true);
    expect(g.isBlockedAt(0, 14)).toBe(true);
    expect(g.isBlockedAt(-10, 0)).toBe(false);
    expect(g.isBlockedAt(0, 20)).toBe(false);
  });

  it('routes around a wall instead of through it', () => {
    const g = new NavGrid(60);
    g.rebuild([box(-1.5, -15, 1.5, 15)]);
    const field = g.flowField(10, 0);
    // the far side is reachable, and the distance reflects the detour
    expect(field.distanceAt(-10, 0)).toBeGreaterThan(7);
    const wp = field.waypoint(-10, 0, 3, new Vector3());
    expect(wp).not.toBeNull();
    // the first waypoint heads toward the wall's end, not into it
    expect(Math.abs(wp!.z)).toBeGreaterThan(3);
    expect(g.isBlockedAt(wp!.x, wp!.z)).toBe(false);
  });

  it('drives straight when next to the target and reports unreachable targets', () => {
    const g = new NavGrid(60);
    g.rebuild([box(-1.5, -15, 1.5, 15)]);
    const field = g.flowField(10, 0);
    expect(field.waypoint(9, 1, 3, new Vector3())).toBeNull();
    // a target inside a solid block is moved to the nearest free cell
    g.rebuild([box(-9, -9, 9, 9)]);
    expect(g.flowField(0, 0).distanceAt(20, 20)).toBeLessThan(Infinity);
    // a target inside a hollow enclosure is unreachable from outside
    g.rebuild([box(-12, -12, 12, -9), box(-12, 9, 12, 12), box(-12, -12, -9, 12), box(9, -12, 12, 12)]);
    const sealed = g.flowField(0, 0);
    expect(sealed.distanceAt(4, 4)).toBeLessThan(Infinity);
    expect(sealed.distanceAt(20, 20)).toBe(Infinity);
    expect(sealed.waypoint(20, 20, 3, new Vector3())).toBeNull();
  });
});
