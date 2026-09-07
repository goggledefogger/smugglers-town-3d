import { describe, it, expect } from 'vitest';
import { VehicleBody } from '../src/core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../src/core/physics/vehicleStats.ts';
import { Heightfield } from '../src/core/heightfield.ts';

const SIZE = 840;
const SEGS = 168;          // 5-unit cells
const STEP = 1 / 60;

/**
 * A slope up to `peak` between z=`from` and z=`to`, then level ground at that
 * height — a convex break, not a cliff. Falling off a cliff is not a jump; the
 * question is whether the car carries its climb into the air over the plateau.
 */
function ramp(from: number, to: number, peak: number): Heightfield {
  const n = SEGS + 1;
  const data = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -SIZE / 2 + (j / SEGS) * SIZE;
    const h = z <= from ? 0 : z >= to ? peak : ((z - from) / (to - from)) * peak;
    for (let i = 0; i < n; i++) data[j * n + i] = h;
  }
  return new Heightfield(SIZE, SEGS, data);
}

const flat = (): Heightfield => new Heightfield(SIZE, SEGS, new Float32Array((SEGS + 1) ** 2));

/** Drive north (-z is forward, so we drive +z by facing that way) at full throttle. */
function drive(ground: Heightfield, startZ: number, seconds: number) {
  const body = new VehicleBody(VEHICLE_TYPES[3]!); // trophy truck
  body.pos.set(0, ground.sample(0, startZ) + 1, startZ);
  // face +z
  body.quat.setFromAxisAngle({ x: 0, y: 1, z: 0 } as never, Math.PI);
  body.snapPrev();
  let peakAbove = 0;
  let airborneS = 0;
  let peakVy = 0;
  const input = { throttle: 1, brake: 0, steer: 0, jump: false };
  for (let t = 0; t < seconds; t += STEP) {
    body.step(STEP, input, ground, []);
    // clearance above the ground beneath the car — the only measure that means
    // "in the air" on terrain that is itself changing height
    const above = body.pos.y - (ground.sample(body.pos.x, body.pos.z) + 1);
    if (!body.onGround) airborneS += STEP;
    peakAbove = Math.max(peakAbove, above);
    peakVy = Math.max(peakVy, body.vel.y);
  }
  return { body, peakAbove, airborneS, peakVy };
}

describe('launching off a crest', () => {
  it('carries the climb into the air over the lip of a ramp', () => {
    const r = drive(ramp(-200, -40, 24), -340, 8);
    expect(r.body.speed).toBeGreaterThan(20);   // it actually got moving
    // measured ~11.9 / 1.13 s / 2.88 units off an 8.5-degree ramp at full pelt
    // (original speed). After a ~25 % speed reduction the car carries less
    // energy into the lip; thresholds are lowered proportionally.
    expect(r.peakVy).toBeGreaterThan(5);        // the climb became upward velocity
    expect(r.airborneS).toBeGreaterThan(0.35);  // meaningful hang time
    expect(r.peakAbove).toBeGreaterThan(0.8);   // and real height over the plateau
  });

  it('stays glued to flat ground — no phantom launches', () => {
    const r = drive(flat(), -320, 5);
    expect(r.airborneS).toBeLessThan(0.1);
    expect(r.peakAbove).toBeLessThan(1);
  });

  it('launches harder off the same ramp when it is hit faster', () => {
    // slow: starts at the foot of the ramp, still accelerating when it hits
    const slow = drive(ramp(-260, -40, 24), -262, 6);
    // fast: long run-up, at full speed when it hits
    const fast = drive(ramp(-260, -40, 24), -420, 12);
    expect(fast.body.speed).toBeGreaterThan(slow.body.speed);
    expect(fast.peakAbove).toBeGreaterThan(slow.peakAbove);
  });
});

describe('air control', () => {
  const flat = (): Heightfield => new Heightfield(SIZE, SEGS, new Float32Array((SEGS + 1) ** 2));

  const noseAfter = (pitch: number): number => {
    const body = new VehicleBody(VEHICLE_TYPES[3]!);
    body.pos.set(0, 60, 0); // well clear of the ground
    body.snapPrev();
    for (let i = 0; i < 40; i++) {
      body.step(STEP, { throttle: 0, brake: 0, steer: 0, jump: false, pitch }, flat(), []);
    }
    const f = body.forward();
    return f.y;
  };

  it('pitches the nose up on positive input and down on negative', () => {
    expect(noseAfter(1)).toBeGreaterThan(0.05);
    expect(noseAfter(-1)).toBeLessThan(-0.05);
    expect(Math.abs(noseAfter(0))).toBeLessThan(0.05);
  });

  it('leaves the car alone on the ground, where the same keys drive it', () => {
    const body = new VehicleBody(VEHICLE_TYPES[3]!);
    body.pos.set(0, 1, 0);
    body.snapPrev();
    for (let i = 0; i < 40; i++) {
      body.step(STEP, { throttle: 0, brake: 0, steer: 0, jump: false, pitch: 1 }, flat(), []);
    }
    expect(body.onGround).toBe(true);
    expect(Math.abs(body.forward().y)).toBeLessThan(0.05);
  });
});

describe('landing damage', () => {
  const flat = (): Heightfield => new Heightfield(SIZE, SEGS, new Float32Array((SEGS + 1) ** 2));

  const dropFrom = (height: number): number => {
    const body = new VehicleBody(VEHICLE_TYPES[1]!); // rally car, the most fragile
    body.pos.set(0, height, 0);
    body.snapPrev();
    const g = flat();
    for (let i = 0; i < 60 * 6; i++) {
      body.step(STEP, { throttle: 0, brake: 0, steer: 0, jump: false }, g, []);
    }
    return body.damage;
  };

  it('lets an ordinary jump land for free', () => {
    // the height a desert crest actually throws you to
    expect(dropFrom(4)).toBe(0);
  });

  it('still charges for a real drop', () => {
    expect(dropFrom(60)).toBeGreaterThan(0.05);
  });

  it('charges more the further it falls', () => {
    expect(dropFrom(120)).toBeGreaterThan(dropFrom(60));
  });
});
