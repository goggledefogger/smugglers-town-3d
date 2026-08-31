import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { VehicleBody, type BuildingCollider } from '../src/core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../src/core/physics/vehicleStats.ts';
import { resolveVehicleCollisions, DEFAULT_RAM_CONFIG } from '../src/core/physics/vehicleCollisions.ts';
import { Heightfield } from '../src/core/heightfield.ts';
import type { VehicleInput } from '../src/core/physics/vehicleStats.ts';

const FLAT = new Heightfield(840, 1, new Float32Array([0, 0, 0, 0]));
const NO_INPUT: VehicleInput = { throttle: 0, brake: 0, steer: 0, jump: false };

function makeBody(typeIdx: number, x: number, z: number, vx = 0, vz = 0): VehicleBody {
  const v = new VehicleBody(VEHICLE_TYPES[typeIdx]!);
  v.pos.set(x, 1, z);
  v.vel.set(vx, 0, vz);
  return v;
}

describe('resolveVehicleCollisions', () => {
  it('separates overlapping vehicles along the contact normal', () => {
    const a = makeBody(2, 0, 0);
    const b = makeBody(2, 3, 0);
    resolveVehicleCollisions([a, b], DEFAULT_RAM_CONFIG, 1, () => {});
    expect(a.pos.distanceTo(b.pos)).toBeGreaterThanOrEqual(DEFAULT_RAM_CONFIG.ramRadius - 0.1);
  });

  it('conserves momentum along the contact axis', () => {
    const a = makeBody(2, 0, 0, 10, 0);
    const b = makeBody(2, 3.5, 0, 0, 0);
    const before = a.vel.x * a.stats.mass + b.vel.x * b.stats.mass;
    resolveVehicleCollisions([a, b], DEFAULT_RAM_CONFIG, 1, () => {});
    const after = a.vel.x * a.stats.mass + b.vel.x * b.stats.mass;
    expect(after).toBeCloseTo(before, 6);
  });

  it('transfers contraband to the attacker on cross-team ram, cooldown-blocks re-steal', () => {
    const a = makeBody(2, 0, 0, 10, 0);
    const b = makeBody(2, 3.5, 0, 0, 0);
    const teams = new Map([[a.id, 0], [b.id, 1]]);
    // sequence: first ram transfers; second ram within cooldown is blocked
    let carrier = 'a';
    let lastTransfer = -Infinity;
    const onRam = (x: VehicleBody, y: VehicleBody) => {
      const attacker = carrier === 'a' ? y : x;
      const victim = carrier === 'a' ? x : y;
      if (teams.get(attacker.id) !== teams.get(victim.id)) {
        if (performance.now() / 1000 - lastTransfer > DEFAULT_RAM_CONFIG.transferCooldownS) {
          carrier = attacker === a ? 'a' : 'b';
          lastTransfer = performance.now() / 1000;
        }
      }
    };
    resolveVehicleCollisions([a, b], DEFAULT_RAM_CONFIG, 1, onRam);
    expect(carrier).toBe('b');
    resolveVehicleCollisions([a, b], DEFAULT_RAM_CONFIG, 1, onRam);
    expect(carrier).toBe('b'); // cooldown blocked
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
    expect(v.pos.x).toBeGreaterThanOrEqual(18 + 2.2 - 0.5);
  });

  it('bounces velocity and applies damage on a hard hit', () => {
    const v = makeBody(2, 0, 0);
    v.pos.set(19, 1, 0);
    v.vel.x = -30;
    v.step(1 / 60, NO_INPUT, FLAT, [building]);
    expect(v.vel.x).toBeGreaterThan(0);
    expect(v.damage).toBeGreaterThan(0);
  });
});
