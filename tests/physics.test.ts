import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { VehicleBody, DEFAULT_PHYSICS } from '../src/core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../src/core/physics/vehicleStats.ts';
import { Heightfield } from '../src/core/heightfield.ts';
import type { VehicleInput } from '../src/core/physics/vehicleStats.ts';

const FLAT = new Heightfield(5600, 1, new Float32Array([0, 0, 0, 0]));
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

  it('brakes forward motion to a stop', () => {
    const v = makeBody();
    v.pos.set(0, 1, 0);
    run(v, { ...NO_INPUT, throttle: 1 }, 1);
    const fwd = v.forward();
    expect(v.vel.dot(fwd)).toBeGreaterThan(20);
    run(v, { ...NO_INPUT, brake: 1 }, 1);
    expect(v.vel.dot(fwd)).toBeLessThan(1);
  });

  it('reverses when brake is held from a stop, capped below forward top speed', () => {
    const v = makeBody();
    v.pos.set(0, 1, 0);
    run(v, { ...NO_INPUT, brake: 1 }, 3);
    const back = -v.vel.dot(v.forward());
    expect(back).toBeGreaterThan(5);
    expect(back).toBeLessThan(DEFAULT_PHYSICS.maxSpeed * 0.5);
  });

  it('caps forward speed at the vehicle top speed', () => {
    const v = makeBody(1); // rally car: fastest
    v.pos.set(0, 1, 0);
    run(v, { ...NO_INPUT, throttle: 1 }, 4);
    expect(v.speed).toBeLessThanOrEqual(DEFAULT_PHYSICS.maxSpeed * VEHICLE_TYPES[1]!.maxSpeed + 1e-6);
  });

  it('steers left (+steer) on the ground and yaws the same way in the air', () => {
    const g = makeBody();
    g.pos.set(0, 1, 0);
    g.vel.set(0, 0, -20);
    run(g, { ...NO_INPUT, throttle: 1, steer: 1 }, 0.3);
    expect(g.forward().x).toBeLessThan(-0.05);
    const a = makeBody();
    a.pos.set(0, 30, 0);
    run(a, { ...NO_INPUT, steer: 1 }, 0.2);
    expect(a.angVel.y).toBeGreaterThan(0);
  });

  it('auto-rights an inverted vehicle in under a second of sim time', () => {
    const v = makeBody();
    v.pos.set(0, 1, 0);
    v.quat.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
    run(v, NO_INPUT, 0.9);
    const up = new Vector3(0, 1, 0).applyQuaternion(v.quat);
    expect(up.y).toBeGreaterThan(0.7);
  });

  it('lets low-grip cars slide where high-grip ones bite', () => {
    const rally = makeBody(1);   // grip 0.70
    const suv = makeBody(2);     // grip 1.00
    const monster = makeBody(4); // grip 1.20
    for (const v of [rally, suv, monster]) {
      v.pos.set(0, 1, 0);
      v.vel.set(20, 0, 0); // pure sideways (facing -z)
      run(v, NO_INPUT, 0.5);
    }
    expect(Math.abs(rally.vel.x)).toBeGreaterThan(5);
    expect(Math.abs(suv.vel.x)).toBeLessThan(1);
    expect(Math.abs(monster.vel.x)).toBeLessThan(Math.abs(suv.vel.x) + 1e-6);
  });

  it('handbrake drops lateral grip so even a high-grip car slides', () => {
    const suv = makeBody(2);     // grip 1.00 — bites hard normally
    const suvNoHand = makeBody(2);
    for (const v of [suv, suvNoHand]) {
      v.pos.set(0, 1, 0);
      v.vel.set(20, 0, 0); // pure sideways
    }
    run(suv, { ...NO_INPUT, handbrake: true }, 0.5);
    run(suvNoHand, NO_INPUT, 0.5);
    // with the handbrake the SUV keeps most of its sideways speed (slides);
    // without it the grip bleeds it to a near-stop (the test above)
    expect(Math.abs(suv.vel.x)).toBeGreaterThan(10);
    expect(Math.abs(suvNoHand.vel.x)).toBeLessThan(1);
  });

  it('accelerates and tops out by type', () => {
    const rally = makeBody(1);
    const monster = makeBody(4);
    for (const v of [rally, monster]) {
      v.pos.set(0, 1, 0);
      run(v, { ...NO_INPUT, throttle: 1 }, 1);
    }
    expect(rally.speed).toBeGreaterThan(monster.speed * 1.5);
    // keep driving (teleported back each second so the field edge isn't hit):
    // the top-speed stat must be the terminal velocity, not a drag accident
    for (let s = 0; s < 5; s++) {
      for (const v of [rally, monster]) {
        v.pos.set(0, 1, 0);
        run(v, { ...NO_INPUT, throttle: 1 }, 1);
      }
    }
    expect(rally.speed).toBeCloseTo(DEFAULT_PHYSICS.maxSpeed * VEHICLE_TYPES[1]!.maxSpeed, -1);
    expect(monster.speed).toBeCloseTo(DEFAULT_PHYSICS.maxSpeed * VEHICLE_TYPES[4]!.maxSpeed, -1);
  });

  it('turns faster with a higher handling stat', () => {
    const buggy = makeBody(0);   // steer 1.25
    const monster = makeBody(4); // steer 0.85
    for (const v of [buggy, monster]) {
      v.pos.set(0, 1, 0);
      v.vel.set(0, 0, -20);
      run(v, { ...NO_INPUT, throttle: 1, steer: 1 }, 0.3);
    }
    expect(Math.abs(buggy.forward().x)).toBeGreaterThan(Math.abs(monster.forward().x) * 1.2);
  });

  it('scales landing damage by durability', () => {
    const buggy = makeBody(0);   // durability 0.55
    const monster = makeBody(4); // durability 1.5
    for (const v of [buggy, monster]) {
      v.pos.set(0, 20, 0);
      v.vel.y = -40;
      run(v, NO_INPUT, 0.5);
    }
    expect(monster.damage).toBeGreaterThan(0);
    expect(buggy.damage).toBeGreaterThan(monster.damage * 2);
  });

  it('applies landing damage on hard impacts', () => {
    const v = makeBody();
    v.pos.set(0, 20, 0);
    v.vel.y = -40;
    run(v, NO_INPUT, 0.5);
    expect(v.damage).toBeGreaterThan(0);
  });

  it('stays planted driving downhill instead of riding the air state', () => {
    // ground rises toward +z; forward is -z, so this is a 7% descent
    const slope = new Heightfield(5600, 1, new Float32Array([0, 0, 400, 400]));
    const v = makeBody();
    v.pos.set(0, slope.sample(0, 0) + 1, 0);
    let airborneSteps = 0;
    for (let t = 0; t < 3; t += 1 / 60) {
      v.step(1 / 60, { ...NO_INPUT, throttle: 1 }, slope, NO_BUILDINGS);
      if (!v.onGround) airborneSteps++;
    }
    expect(v.speed).toBeGreaterThan(20);
    expect(airborneSteps).toBeLessThan(3);
    expect(v.onGround).toBe(true);
  });

  it('eases over a bump instead of snapping to it', () => {
    // a 0.5-unit step in the ground: the body should take several steps to climb it
    const step = new Heightfield(8, 4, new Float32Array([
      0, 0, 0.5, 0.5, 0.5, 0, 0, 0.5, 0.5, 0.5, 0, 0, 0.5, 0.5, 0.5, 0, 0, 0.5, 0.5, 0.5, 0, 0, 0.5, 0.5, 0.5
    ]));
    const v = makeBody();
    v.pos.set(-3, 1, 0);
    v.step(1 / 60, NO_INPUT, step, NO_BUILDINGS);
    v.pos.x = 3; // teleport onto the high side
    v.step(1 / 60, NO_INPUT, step, NO_BUILDINGS);
    expect(v.pos.y).toBeGreaterThan(1.05);
    expect(v.pos.y).toBeLessThan(1.4);
    for (let t = 0; t < 0.5; t += 1 / 60) v.step(1 / 60, NO_INPUT, step, NO_BUILDINGS);
    expect(v.pos.y).toBeCloseTo(1.5, 2);
  });

  it('keeps steering for a moment after lift-off', () => {
    // 4 units up: above the snap band, so genuinely airborne from the first step
    const v = makeBody();
    v.pos.set(0, 5, 0);
    v.vel.set(0, 0, -20);
    run(v, { ...NO_INPUT, steer: 1 }, 0.15);
    expect(v.onGround).toBe(false);
    expect(v.forward().x).toBeLessThan(-0.1);
  });

  it('rides on the average of the four wheel contact heights', () => {
    // 2-unit checkerboard bumps: the center node is 0 but every wheel point sits partway up a bump
    const data = new Float32Array(25);
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) data[j * 5 + i] = ((i + j) % 2) * 2;
    const bumpy = new Heightfield(8, 4, data);
    const v = makeBody();
    v.pos.set(0, 5, 0);
    for (let t = 0; t < 1.5; t += 1 / 60) v.step(1 / 60, NO_INPUT, bumpy, NO_BUILDINGS);
    expect(v.groundY).toBeCloseTo(1.125, 3);
    expect(v.pos.y).toBeCloseTo(2.125, 1);
  });

  it('still leaves the ground on a jump', () => {
    const v = makeBody();
    v.pos.set(0, 1, 0);
    run(v, { ...NO_INPUT, jump: true }, 0.25);
    expect(v.pos.y - v.groundY).toBeGreaterThan(2.5);
    expect(v.onGround).toBe(false);
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

  it('climbs steep hills smoothly without sustaining crash damage or bouncing into the air', () => {
    // 30% upward incline along -Z: y = -z * 0.3
    const rampData = new Float32Array(25);
    // 5x5 grid from z = 50 to z = -50 (size = 100, 4 segments)
    // row 0 is z = -50 (high), row 4 is z = +50 (low)
    for (let j = 0; j < 5; j++) {
      const z = -50 + j * 25;
      const h = Math.max(0, -z * 0.3);
      for (let i = 0; i < 5; i++) rampData[j * 5 + i] = h;
    }
    const ramp = new Heightfield(100, 4, rampData);
    const v = makeBody();
    v.pos.set(0, 1, 10);
    v.vel.set(0, 0, -35); // driving forward fast into the hill

    // Step for 0.5s onto the hill
    for (let t = 0; t < 0.5; t += 1 / 60) {
      v.step(1 / 60, { ...NO_INPUT, throttle: 1 }, ramp, NO_BUILDINGS);
    }

    // Must have taken ZERO crash impact damage from driving into the hill
    expect(v.damage).toBe(0);
    // Must remain firmly on the ground, not bounced into the sky
    expect(v.onGround).toBe(true);
    // Must have climbed the hill smoothly
    expect(v.pos.y).toBeGreaterThan(1.5);
  });

  it('smoothly recovers small tilt angles without getting stuck leaning', () => {
    const v = makeBody();
    v.pos.set(0, 1, 0);
    // Tilt the car 8 degrees to the right
    v.quat.setFromAxisAngle(new Vector3(0, 0, 1), 8 * Math.PI / 180);
    run(v, NO_INPUT, 0.6);
    // Car should have righted itself back to upright (tilt angle < 1 degree)
    const upW = new Vector3(0, 1, 0).applyQuaternion(v.quat);
    const tiltAngDeg = Math.acos(Math.min(1, upW.y)) * (180 / Math.PI);
    expect(tiltAngDeg).toBeLessThan(1.0);
  });

  it('averages elevated surface elevation across all 4 wheel contacts', () => {
    const v = makeBody();
    v.pos.set(0, 1, 0);
    // surfaceProvider returns 10m only on the front half (z < 0), null behind
    const surfFn = (_x: number, z: number) => (z < 0 ? 10 : null);
    v.step(1 / 60, NO_INPUT, FLAT, NO_BUILDINGS, surfFn);
    // Front contact point is at z = -1.3 (returns 10), rear at z = +1.3 (returns 0),
    // right at z = 0 (returns 0), left at z = 0 (returns 0)
    // 0.25 * (10 + 0 + 0 + 0) = 2.5
    expect(v.groundY).toBeCloseTo(2.5, 1);
  });
});
