import { describe, it, expect } from 'vitest';
import { DriverBrain, DEFAULT_DRIVER } from '../src/core/ai/DriverBrain.ts';
import { VehicleBody } from '../src/core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../src/core/physics/vehicleStats.ts';
import type { MatchState } from '../src/core/gameplay/MatchRules.ts';
import { Vector3 } from 'three';

function makeBody(x: number, z: number, quatYawDeg = 0): VehicleBody {
  const v = new VehicleBody(VEHICLE_TYPES[2]!);
  v.pos.set(x, 1, z);
  v.quat.setFromAxisAngle(new Vector3(0, 1, 0), (quatYawDeg * Math.PI) / 180);
  return v;
}

function makeMatchState(carrier: VehicleBody | null): MatchState {
  return {
    scores: { 0: 0, 1: 0 },
    carrier,
    contrabandPos: new Vector3(100, 3, 0),
    dropZonePos: new Vector3(-100, 0, 0),
    winner: null
  };
}

describe('DriverBrain', () => {
  it('seeks the contraband when no one carries', () => {
    const self = makeBody(0, 0);
    const brain = new DriverBrain(DEFAULT_DRIVER, v => (v === self ? 0 : 1));
    brain.think(1, self, makeMatchState(null));
    const input = brain.input();
    expect(Math.abs(input.steer)).toBeLessThanOrEqual(1);
    expect(input.throttle).toBeGreaterThan(0);
  });

  it('chases an enemy carrier', () => {
    const self = makeBody(0, 0);
    const enemy = makeBody(50, 50);
    const brain = new DriverBrain(DEFAULT_DRIVER, v => (v === self ? 0 : 1));
    brain.think(1, self, makeMatchState(enemy));
    const input = brain.input();
    expect(input.throttle).toBeGreaterThan(0);
    expect(Math.abs(input.steer)).toBeLessThanOrEqual(1);
  });

  it('keeps driving when the carrier vanishes before the next re-evaluation', () => {
    const self = makeBody(0, 0);
    const enemy = makeBody(50, 50);
    const brain = new DriverBrain(DEFAULT_DRIVER, v => (v === self ? 0 : 1));
    brain.think(1, self, makeMatchState(enemy)); // enters chase
    // delivered a few ms later: still in chase, no carrier
    expect(() => brain.think(0.01, self, makeMatchState(null))).not.toThrow();
    expect(brain.input().throttle).toBeGreaterThan(0);
  });

  it('delivers when self carries — drives toward the drop zone', () => {
    const self = makeBody(0, 0);
    const brain = new DriverBrain(DEFAULT_DRIVER, () => 0);
    brain.think(1, self, makeMatchState(self));
    const input = brain.input();
    expect(input.throttle).toBeGreaterThan(0);
    expect(Math.abs(input.steer)).toBeLessThanOrEqual(1);
  });

  it('clamps steering to [-1, 1] however sharp the turn', () => {
    const self = makeBody(0, 0, 0);
    const brain = new DriverBrain(DEFAULT_DRIVER, () => 0);
    const state = makeMatchState(null);
    state.contrabandPos.set(0, 3, 50);
    brain.think(1, self, state);
    const input = brain.input();
    expect(input.steer).toBeGreaterThanOrEqual(-1);
    expect(input.steer).toBeLessThanOrEqual(1);
  });
});
