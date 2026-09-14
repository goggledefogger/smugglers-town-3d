import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { SpawnPlanner, DEFAULT_SPAWN } from '../src/core/spawn/SpawnPlanner.ts';
import { NavGrid } from '../src/core/world/NavGrid.ts';
import { EMPTY_SPACE, type OpenSpace } from '../src/core/world/OpenSpace.ts';
import { mulberry32 } from '../src/core/rng.ts';
import type { BuildingCollider } from '../src/core/physics/VehicleBody.ts';

const teamOf = (i: number): 0 | 1 => (i < 4 ? 0 : 1);

function box(x0: number, z0: number, x1: number, z1: number): BuildingCollider {
  return { min: new Vector3(x0, 0, z0), max: new Vector3(x1, 30, z1) };
}

describe('SpawnPlanner', () => {
  it('is deterministic from a seed', () => {
    const a = new SpawnPlanner(DEFAULT_SPAWN, EMPTY_SPACE, mulberry32(7)).matchSpawns(8, teamOf);
    const b = new SpawnPlanner(DEFAULT_SPAWN, EMPTY_SPACE, mulberry32(7)).matchSpawns(8, teamOf);
    const c = new SpawnPlanner(DEFAULT_SPAWN, EMPTY_SPACE, mulberry32(8)).matchSpawns(8, teamOf);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('puts each team on its own arc and faces everyone at the ring centre', () => {
    const pts = new SpawnPlanner(DEFAULT_SPAWN, EMPTY_SPACE, mulberry32(1)).matchSpawns(8, teamOf);
    const centroid = (team: 0 | 1): { x: number; z: number } => {
      const own = pts.filter((_, i) => teamOf(i) === team);
      return { x: own.reduce((s, p) => s + p.x, 0) / own.length, z: own.reduce((s, p) => s + p.z, 0) / own.length };
    };
    const c0 = centroid(0), c1 = centroid(1);
    // opposite arcs: team centroids sit on opposite sides of the ring
    expect(Math.hypot(c0.x - c1.x, c0.z - c1.z)).toBeGreaterThan(DEFAULT_SPAWN.ringRadius);
    for (const p of pts) {
      // forward is -Z rotated by yaw: (-sin, -cos) must point at the origin
      const fwd = { x: -Math.sin(p.yaw), z: -Math.cos(p.yaw) };
      const toCenter = { x: -p.x, z: -p.z };
      const len = Math.hypot(toCenter.x, toCenter.z);
      expect(fwd.x * toCenter.x / len + fwd.z * toCenter.z / len).toBeGreaterThan(0.99);
    }
  });

  it('moves the whole grid to open ground when the field centre is built up', () => {
    // a solid block over the centre, open ground to the east
    const grid = new NavGrid(840);
    grid.rebuild([box(-60, -60, 60, 60)]);
    const pts = new SpawnPlanner(DEFAULT_SPAWN, grid, mulberry32(3)).matchSpawns(8, teamOf);
    for (const p of pts) {
      expect(grid.isBlockedAt(p.x, p.z)).toBe(false);
      expect(grid.clearanceAt(p.x, p.z)).toBeGreaterThanOrEqual(DEFAULT_SPAWN.carClearance - grid.cell);
    }
  });

  it('pinned to a point, forms the ring on the nearest open ground to it instead of the roomiest place in the field', () => {
    const grid = new NavGrid(840);
    grid.rebuild([box(-60, -60, 60, 60)]);
    const free = new SpawnPlanner(DEFAULT_SPAWN, grid, mulberry32(3)).matchSpawns(8, teamOf);
    const pinned = new SpawnPlanner(DEFAULT_SPAWN, grid, mulberry32(3)).matchSpawns(8, teamOf, { x: 0, z: 0 });
    const far = (pts: { x: number; z: number }[]): number => Math.max(...pts.map(p => Math.hypot(p.x, p.z)));
    expect(far(pinned)).toBeLessThan(60 + DEFAULT_SPAWN.ringRadius + 30);
    expect(far(free)).toBeGreaterThan(far(pinned));
    for (const p of pinned) expect(grid.isBlockedAt(p.x, p.z)).toBe(false);
  });

  it('never returns a blocked point even when nothing meets the clearance it wants', () => {
    // a dense grid of pillars: nowhere has 30 units clear, but there is always open ground
    const walls: BuildingCollider[] = [];
    for (let x = -400; x <= 400; x += 24) for (let z = -400; z <= 400; z += 24) walls.push(box(x, z, x + 6, z + 6));
    const grid = new NavGrid(840);
    grid.rebuild(walls);
    const pts = new SpawnPlanner({ ...DEFAULT_SPAWN, ringRadius: 30 }, grid, mulberry32(5)).matchSpawns(8, teamOf);
    for (const p of pts) expect(grid.isBlockedAt(p.x, p.z)).toBe(false);
  });

  it('respawns just inside the base, facing the field', () => {
    const planner = new SpawnPlanner(DEFAULT_SPAWN, EMPTY_SPACE, mulberry32(2));
    const base = { x: 273, z: 0 };
    const p = planner.respawn(base);
    expect(p.x).toBeLessThan(base.x);
    expect(p.x).toBeGreaterThan(base.x - 60);
    expect(Math.abs(p.z)).toBeLessThan(1);
    expect(-Math.sin(p.yaw)).toBeLessThan(-0.99); // facing -x, toward the centre
  });

  it('keeps the crate away from cars and bases', () => {
    const planner = new SpawnPlanner(DEFAULT_SPAWN, EMPTY_SPACE, mulberry32(9));
    const avoid = [{ x: 0, z: 0 }, { x: 100, z: 100 }, { x: -100, z: -100 }];
    for (let i = 0; i < 20; i++) {
      const p = planner.item(avoid);
      for (const a of avoid) expect(Math.hypot(p.x - a.x, p.z - a.z)).toBeGreaterThan(DEFAULT_SPAWN.itemMinDist);
    }
  });
});

describe('NavGrid as OpenSpace', () => {
  it('measures clearance as distance to the nearest wall', () => {
    const grid = new NavGrid(120);
    grid.rebuild([box(-3, -60, 3, 60)]); // a wall down the middle
    expect(grid.clearanceAt(0, 0)).toBe(0);
    const near = grid.clearanceAt(-9, 0);
    const far = grid.clearanceAt(-30, 0);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
  });

  it('findOpen walks out to the nearest point with enough room', () => {
    const grid = new NavGrid(120);
    grid.rebuild([box(-3, -60, 3, 60)]);
    const p = grid.findOpen(0, 0, 9)!;
    expect(p).not.toBeNull();
    expect(grid.clearanceAt(p.x, p.z)).toBeGreaterThanOrEqual(9);
    expect(Math.abs(p.x)).toBeLessThan(30); // it did not run to the far edge
  });

  it('mostOpen prefers the roomiest place near the ask, and never blocks', () => {
    const grid = new NavGrid(120);
    grid.rebuild([box(-60, -60, -20, 60)]); // west third solid
    const p = grid.mostOpen(0, 0, 1000)!; // asks for more than exists
    expect(p).not.toBeNull();
    expect(grid.isBlockedAt(p.x, p.z)).toBe(false);
    expect(p.x).toBeGreaterThan(-20);
  });

  it('EMPTY_SPACE is always open', () => {
    const s: OpenSpace = EMPTY_SPACE;
    expect(s.clearanceAt(0, 0)).toBe(Infinity);
    expect(s.findOpen(5, 6, 100)).toEqual({ x: 5, z: 6 });
  });

  it('exposes initialDropHeight for match countdown drop and dropHeight for respawn', () => {
    const planner = new SpawnPlanner(DEFAULT_SPAWN);
    expect(planner.initialDropHeight).toBe(65);
    expect(planner.dropHeight).toBe(14);

    const custom = new SpawnPlanner({ ...DEFAULT_SPAWN, initialDropHeight: 80, dropHeight: 20 });
    expect(custom.initialDropHeight).toBe(80);
    expect(custom.dropHeight).toBe(20);
  });
});
