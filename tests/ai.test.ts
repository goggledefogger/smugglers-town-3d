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
    contraband: [{ id: 0, pos: new Vector3(100, 3, 0), carrier: carrier, lastTransfer: -Infinity, delivered: false }],
    bases: { 0: new Vector3(-100, 0, 0), 1: new Vector3(100, 0, 0) },
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

  it('delivers when self carries — drives toward its own base', () => {
    // facing -z; own base (team 1) is at +x, so the turn is to the right (negative steer)
    const self = makeBody(0, 0);
    const brain = new DriverBrain(DEFAULT_DRIVER, () => 1);
    brain.think(1, self, makeMatchState(self));
    const input = brain.input();
    expect(input.throttle).toBeGreaterThan(0);
    expect(input.steer).toBeLessThan(0);
  });

  it('steers toward the routed waypoint rather than the raw target', () => {
    // target straight ahead (-z), but the route says go right (+x)
    const self = makeBody(0, 0);
    const brain = new DriverBrain(DEFAULT_DRIVER, () => 0);
    const state = makeMatchState(null);
    state.contraband[0]!.pos.set(0, 3, -100);
    const seen: string[] = [];
    brain.think(1, self, state, (kind, from) => {
      seen.push(kind);
      return new Vector3(from.x + 20, 0, from.z);
    });
    expect(seen).toEqual(['contraband']);
    expect(brain.input().steer).toBeLessThan(0);
  });

  it('reverses out after being wedged at full throttle', () => {
    const self = makeBody(0, 0);
    self.onGround = true; // speed stays 0: wedged against something
    const brain = new DriverBrain(DEFAULT_DRIVER, () => 0);
    const state = makeMatchState(null);
    for (let i = 0; i < 12; i++) brain.think(0.1, self, state);
    const input = brain.input();
    expect(input.brake).toBe(1);
    expect(input.throttle).toBe(0);
  });

  it('clamps steering to [-1, 1] however sharp the turn', () => {
    const self = makeBody(0, 0, 0);
    const brain = new DriverBrain(DEFAULT_DRIVER, () => 0);
    const state = makeMatchState(null);
    state.contraband[0]!.pos.set(0, 3, 50);
    brain.think(1, self, state);
    const input = brain.input();
    expect(input.steer).toBeGreaterThanOrEqual(-1);
    expect(input.steer).toBeLessThanOrEqual(1);
  });

  it('predicts target location ahead of a moving enemy carrier', () => {
    // self at (0, 0) facing north (-z)
    const self = makeBody(0, 0);
    // enemy at (0, 100) moving rapidly east (+x)
    const enemy = makeBody(0, 100);
    enemy.vel.set(40, 0, 0);
    const brain = new DriverBrain(DEFAULT_DRIVER, v => (v === self ? 0 : 1));
    const state = makeMatchState(enemy);
    brain.think(0.1, self, state);
    const input = brain.input();
    // target is in front-right quadrant (+x, -z relative to heading) -> negative steer turns right
    expect(input.throttle).toBeGreaterThan(0);
  });

  it('targets threatening rival when escorting an allied carrier', () => {
    const self = makeBody(80, 0); // team 0 escort
    const ally = makeBody(100, 0); // team 0 carrier
    const rival = makeBody(120, 20); // team 1 threat
    const match = makeMatchState(ally);
    const brain = new DriverBrain(DEFAULT_DRIVER, v => (v === rival ? 1 : 0));
    brain.think(0.1, self, match, null, [self, ally, rival]);
    const input = brain.input();
    expect(input.throttle).toBeGreaterThan(0);
  });

  it('preserves high throttle through turns at speed without scrubbing down to crawl', () => {
    const self = makeBody(0, 0);
    self.speed = 30; // 108 km/h
    const brain = new DriverBrain(DEFAULT_DRIVER, () => 0);
    const state = makeMatchState(null);
    // target at 45 degrees
    state.contraband[0]!.pos.set(40, 3, -40);
    brain.think(0.1, self, state);
    const input = brain.input();
    expect(input.throttle).toBeGreaterThanOrEqual(0.75);
    expect(input.brake).toBe(0);
  });

  it('commits to full throttle and zero brake when in ramming strike distance', () => {
    const self = makeBody(0, 0);
    const enemy = makeBody(0, 25); // within 40m ram distance
    const brain = new DriverBrain(DEFAULT_DRIVER, v => (v === self ? 0 : 1));
    const state = makeMatchState(enemy);
    brain.think(0.1, self, state);
    const input = brain.input();
    expect(input.throttle).toBe(1);
    expect(input.brake).toBe(0);
  });

  it('engages handbrake during high-speed sharp turns to initiate drift', () => {
    const self = makeBody(0, 0);
    self.speed = 40; // 144 km/h
    const brain = new DriverBrain(DEFAULT_DRIVER, () => 0);
    const state = makeMatchState(null);
    // target directly behind (180 deg turn)
    state.contraband[0]!.pos.set(0, 3, 50);
    brain.think(0.1, self, state);
    const input = brain.input();
    expect(input.handbrake).toBe(true);
  });
});
