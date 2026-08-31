import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { VehicleBody, DEFAULT_PHYSICS } from '../src/core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../src/core/physics/vehicleStats.ts';
import { Heightfield } from '../src/core/heightfield.ts';
import type { VehicleInput } from '../src/core/physics/vehicleStats.ts';

const FLAT = new Heightfield(840, 1, new Float32Array([0, 0, 0, 0]));
const NO_INPUT: VehicleInput = { throttle: 0, brake: 0, steer: 0, jump: false };
const NO_BUILDINGS: never[] = [];

function makeBody(typeIdx = 2): VehicleBody {
  return new VehicleBody(VEHICLE_TYPES[typeIdx]!);
}

function run(body: VehicleBody, input: VehicleInput, seconds: number, dt = 1 / 60): void {
  for (let t = 0; t < seconds; t += dt) body.step(dt, input, FLAT, NO_BUILDINGS);
}

describe('VehicleBody.step', () => {
  it('accelerates forward under throttle', () => {
    const v = makeBody();
    v.pos.set(0, 1, 0);
    run(v, { ...NO_INPUT, throttle: 1 }, 1);
    const fwd = v.forward();
    expect(v.vel.dot(fwd)).toBeGreaterThan(5);
  });

  it('brings speed to near zero under full brake', () => {
    const v = makeBody();
    v.pos.set(0, 1, 0);
    run(v, { ...NO_INPUT, throttle: 0.01 }, 0.5);
    run(v, { ...NO_INPUT, brake: 1 }, 2);
    expect(v.speed).toBeLessThan(1);
  });

  it('auto-rights an inverted vehicle in under a second of sim time', () => {
    const v = makeBody();
    v.pos.set(0, 1, 0);
    v.quat.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
    run(v, NO_INPUT, 0.9);
    const up = new Vector3(0, 1, 0).applyQuaternion(v.quat);
    expect(up.y).toBeGreaterThan(0.7);
  });

  it('applies landing damage on hard impacts', () => {
    const v = makeBody();
    v.pos.set(0, 20, 0);
    v.vel.y = -40;
    run(v, NO_INPUT, 0.5);
    expect(v.damage).toBeGreaterThan(0);
  });

  it('does not fall below ground clearance', () => {
    const v = makeBody();
    v.pos.set(0, 20, 0);
    run(v, NO_INPUT, 2);
    expect(v.pos.y).toBeGreaterThanOrEqual(1.0 - 1e-6);
  });

  it('bounds the vehicle inside the play field', () => {
    const v = makeBody();
    v.pos.set(0, 1, 0);
    run(v, { ...NO_INPUT, throttle: 1 }, 6);
    // forward is -Z: most displacement lands on Z; both axes stay in bounds
    expect(Math.abs(v.pos.z)).toBeLessThanOrEqual(DEFAULT_PHYSICS.worldHalf - 8 + 1e-3);
    expect(Math.abs(v.pos.x)).toBeLessThanOrEqual(DEFAULT_PHYSICS.worldHalf - 8 + 1e-3);
  });
});
