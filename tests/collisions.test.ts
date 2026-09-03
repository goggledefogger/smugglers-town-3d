import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from 'three';
import { VehicleBody, type BuildingCollider } from '../src/core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../src/core/physics/vehicleStats.ts';
import { resolveVehicleCollisions } from '../src/core/physics/vehicleCollisions.ts';
import { sphereVsAabb, compoundVsCompound, capsuleCollider, sphereCollider, type Contact } from '../src/core/physics/collision.ts';
import { Heightfield } from '../src/core/heightfield.ts';
import type { VehicleInput } from '../src/core/physics/vehicleStats.ts';

const FLAT = new Heightfield(840, 1, new Float32Array([0, 0, 0, 0]));
const NO_INPUT: VehicleInput = { throttle: 0, brake: 0, steer: 0, jump: false };
const SUV = VEHICLE_TYPES[2]!;
const SUV_R = SUV.collider.spheres[0]!.r;

function makeBody(typeIdx: number, x: number, z: number, vx = 0, vz = 0): VehicleBody {
  const v = new VehicleBody(VEHICLE_TYPES[typeIdx]!);
  v.pos.set(x, 1, z);
  v.vel.set(vx, 0, vz);
  return v;
}

describe('collision primitives', () => {
  const min = new Vector3(0, 0, 0), max = new Vector3(10, 10, 10);
  const hit: Contact = { nx: 0, ny: 0, nz: 0, push: 0 };

  it('sphere outside a box: normal from the nearest face, push = overlap', () => {
    expect(sphereVsAabb(-3, 5, 5, 2, min, max, hit)).toBe(false);
    expect(sphereVsAabb(-1, 5, 5, 2, min, max, hit)).toBe(true);
    expect([hit.nx, hit.ny, hit.nz]).toEqual([-1, 0, 0]);
    expect(hit.push).toBeCloseTo(1, 6);
  });

  it('sphere centre inside a box leaves by the NEAREST face', () => {
    expect(sphereVsAabb(1, 5, 5, 2, min, max, hit)).toBe(true);
    expect([hit.nx, hit.ny, hit.nz]).toEqual([-1, 0, 0]);
    expect(hit.push).toBeCloseTo(3, 6); // 1 to the face + the radius
  });

  it('a capsule reaches further along its length than across it', () => {
    const cap = capsuleCollider(1, 2);
    const q = new Quaternion(); // forward -z
    const n = new Vector3();
    const ball = sphereCollider(1);
    // 3.5 ahead: the nose sphere at z=-2 is 1.5 from the ball, radii sum to 2 → overlap
    expect(compoundVsCompound(new Vector3(), q, cap, new Vector3(0, 0, -3.5), q, ball, n)).toBeCloseTo(0.5, 6);
    expect(n.z).toBeLessThan(-0.99);
    // 3.5 to the side: nearest sphere is sqrt(3.5²+2²) ≈ 4 away → clear
    expect(compoundVsCompound(new Vector3(), q, cap, new Vector3(3.5, 0, 0), q, ball, n)).toBe(0);
  });
});

describe('resolveVehicleCollisions', () => {
  it('separates overlapping vehicles along the contact normal', () => {
    const a = makeBody(2, 0, 0);
    const b = makeBody(2, 3, 0);
    resolveVehicleCollisions([a, b], () => {});
    expect(a.pos.distanceTo(b.pos)).toBeGreaterThanOrEqual(2 * SUV_R - 0.1);
  });

  it('conserves momentum along the contact axis', () => {
    const a = makeBody(2, 0, 0, 10, 0);
    const b = makeBody(2, 3.5, 0, 0, 0);
    const before = a.vel.x * a.stats.mass + b.vel.x * b.stats.mass;
    resolveVehicleCollisions([a, b], () => {});
    const after = a.vel.x * a.stats.mass + b.vel.x * b.stats.mass;
    expect(after).toBeCloseTo(before, 6);
  });

  it('a bigger vehicle touches sooner than a smaller one', () => {
    const buggy = makeBody(0, 0, 0), monster = makeBody(4, 0, 0);
    const probe = (v: VehicleBody, x: number): boolean => {
      const other = makeBody(2, x, 0);
      let hit = false;
      resolveVehicleCollisions([v, other], () => { hit = true; });
      return hit;
    };
    expect(probe(monster, 4.1)).toBe(true);
    expect(probe(buggy, 4.1)).toBe(false);
  });

  it('reports every contacting pair to the ram hook', () => {
    const a = makeBody(2, 0, 0, 10, 0);
    const b = makeBody(2, 3.5, 0, 0, 0);
    const pairs: [number, number][] = [];
    resolveVehicleCollisions([a, b], (x, y) => pairs.push([x.id, y.id]));
    expect(pairs).toEqual([[a.id, b.id]]);
  });
});

describe('building AABB resolution', () => {
  const building: BuildingCollider = {
    min: new Vector3(10, 0, -5),
    max: new Vector3(18, 30, 5)
  };

  it('pushes a vehicle out of a building it penetrates', () => {
    // car starts inside the penetration zone just east of the east face
    const v = makeBody(2, 0, 0);
    v.pos.set(19, 1, 0);
    v.vel.x = -10;
    v.step(1 / 60, NO_INPUT, FLAT, [building]);
    expect(v.pos.x).toBeGreaterThanOrEqual(18 + SUV_R - 0.5);
  });

  it('bounces velocity and applies damage on a hard hit', () => {
    const v = makeBody(2, 0, 0);
    v.pos.set(19, 1, 0);
    v.vel.x = -30;
    v.step(1 / 60, NO_INPUT, FLAT, [building]);
    expect(v.vel.x).toBeGreaterThan(0);
    expect(v.damage).toBeGreaterThan(0);
  });

  it('the nose hits a wall ahead before the centre would', () => {
    // wall across -z; the car faces -z with its nose sphere a half-length ahead
    const wall: BuildingCollider = { min: new Vector3(-20, 0, -30), max: new Vector3(20, 20, -10) };
    const v = makeBody(2, 0, 0);
    const half = -SUV.collider.spheres[0]!.z;
    v.pos.set(0, 1, -10 + SUV_R + half - 0.3); // centre clear, nose overlapping
    v.step(1 / 60, NO_INPUT, FLAT, [wall]);
    expect(v.pos.z).toBeGreaterThan(-10 + SUV_R + half - 0.05);
  });
});
