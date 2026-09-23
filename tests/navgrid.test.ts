import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { NavGrid } from '../src/core/world/NavGrid.ts';
import type { BuildingCollider } from '../src/core/physics/VehicleBody.ts';

describe('NavGrid expand budget', () => {
  it('a metered field drives straight until it has expanded, then routes like an unmetered one', () => {
    const wall = [{ min: new Vector3(-5, 0, -200), max: new Vector3(5, 10, 200) }] as BuildingCollider[];
    const free = new NavGrid(600, 6);
    free.rebuild(wall);
    const want = free.flowField(100, 0).waypoint(-100, 0, 3, new Vector3());

    const metered = new NavGrid(600, 6);
    metered.rebuild(wall);
    const field = metered.flowField(100, 0);
    metered.expandBudget = 50;
    expect(field.waypoint(-100, 0, 3, new Vector3())).toBeNull();
    let got: Vector3 | null = null;
    for (let frame = 0; frame < 1000 && !got; frame++) {
      metered.expandBudget = 50;
      got = field.waypoint(-100, 0, 3, new Vector3());
    }
    expect(got).not.toBeNull();
    // it may route from a neighbouring cell that was reached first: one cell apart at most
    expect(Math.abs(got!.x - want!.x)).toBeLessThanOrEqual(6);
    expect(Math.abs(got!.z - want!.z)).toBeLessThanOrEqual(6);
  });
});
