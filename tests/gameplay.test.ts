import { describe, it, expect } from 'vitest';
import { MatchRules, DEFAULT_SCORING } from '../src/core/gameplay/MatchRules.ts';
import { VehicleBody } from '../src/core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../src/core/physics/vehicleStats.ts';
import { Heightfield } from '../src/core/heightfield.ts';
import { SpawnPlanner, DEFAULT_SPAWN } from '../src/core/spawn/SpawnPlanner.ts';
import type { OpenSpace } from '../src/core/world/OpenSpace.ts';

const FLAT = new Heightfield(5600, 1, new Float32Array([0, 0, 0, 0]));

function makeMatch(bodies: VehicleBody[], teams: ReadonlyMap<number, 0 | 1>): MatchRules {
  const m = new MatchRules(DEFAULT_SCORING, bodies, teams, FLAT, new SpawnPlanner(DEFAULT_SPAWN));
  m.placeBases();
  m.spawnContraband();
  return m;
}

describe('MatchRules', () => {
  it('never spawns contraband or a base where there is no room', () => {
    // everything at x > 0 is solid; the planner must keep west of the line
    const westOnly: OpenSpace = {
      clearanceAt: (x) => (x > 0 ? 0 : 50),
      findOpen: (x, z) => (x > 0 ? { x: -x, z } : { x, z }),
      mostOpen: (x, z) => (x > 0 ? { x: -x, z } : { x, z })
    };
    const m = new MatchRules(
      DEFAULT_SCORING, [], new Map(), FLAT, new SpawnPlanner(DEFAULT_SPAWN, westOnly)
    );
    for (let i = 0; i < 25; i++) {
      m.placeBases();
      m.spawnContraband();
      for (const crate of m.state.contraband) expect(crate.pos.x).toBeLessThanOrEqual(0);
      expect(m.state.bases[0].x).toBeLessThanOrEqual(0);
      expect(m.state.bases[1].x).toBeLessThanOrEqual(0);
    }
  });

  it('places the bases far apart and keeps them put across deliveries', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const m = makeMatch([a], new Map([[a.id, 0 as const]]));
    const b0 = m.state.bases[0].clone();
    const b1 = m.state.bases[1].clone();
    expect(b0.distanceTo(b1)).toBeGreaterThan(2000);
    a.pos.copy(m.state.contraband[0]!.pos);
    m.checkPickup();
    a.pos.copy(m.state.bases[0]);
    m.checkDelivery();
    expect(m.state.scores[0]).toBe(1);
    expect(m.state.bases[0].equals(b0)).toBe(true);
    expect(m.state.bases[1].equals(b1)).toBe(true);
    // the fresh contraband is nowhere near either base
    expect(m.state.contraband[0]!.pos.distanceTo(b0)).toBeGreaterThan(DEFAULT_SPAWN.itemMinDist);
    expect(m.state.contraband[0]!.pos.distanceTo(b1)).toBeGreaterThan(DEFAULT_SPAWN.itemMinDist);
  });

  it('drops the crate where a wrecked carrier died and respawns near its base', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const m = makeMatch([a], new Map([[a.id, 0 as const]]));
    a.pos.copy(m.state.contraband[0]!.pos);
    m.checkPickup();
    a.pos.set(50, 1, 50);
    m.dropFrom(a);
    expect(m.state.contraband[0]!.carrier).toBeNull();
    expect(m.state.contraband[0]!.pos.x).toBeCloseTo(50, 6);
    expect(m.state.contraband[0]!.pos.z).toBeCloseTo(50, 6);
    expect(m.drainEvents().some(e => e.type === 'drop')).toBe(true);
    const p = m.respawnPoint(0);
    expect(Math.hypot(p.x - m.state.bases[0].x, p.z - m.state.bases[0].z)).toBeLessThan(80);
  });

  it('does not score at the enemy base', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const m = makeMatch([a], new Map([[a.id, 0 as const]]));
    a.pos.copy(m.state.contraband[0]!.pos);
    m.checkPickup();
    a.pos.copy(m.state.bases[1]);
    m.checkDelivery();
    expect(m.state.scores[0]).toBe(0);
    expect(m.state.contraband[0]!.carrier).toBe(a);
  });

  it('picks up contraband when a vehicle is inside the radius', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const]]);
    const m = makeMatch([a], teams);
    a.pos.copy(m.state.contraband[0]!.pos);
    m.checkPickup();
    expect(m.state.contraband[0]!.carrier).toBe(a);
    const evts = m.drainEvents();
    expect(evts[0]?.type).toBe('pickup');
  });

  it('does not pick up when already carried', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const b = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const], [b.id, 1 as const]]);
    const m = makeMatch([a, b], teams);
    a.pos.copy(m.state.contraband[0]!.pos);
    m.checkPickup();
    expect(m.state.contraband[0]!.carrier).toBe(a);
    b.pos.copy(m.state.contraband[0]!.pos);
    m.checkPickup();
    expect(m.state.contraband[0]!.carrier).toBe(a);
  });

  it('transfers contraband to the attacker on cross-team ram, blocked within cooldown', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const b = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const], [b.id, 1 as const]]);
    const m = makeMatch([a, b], teams);
    a.pos.copy(m.state.contraband[0]!.pos);
    m.checkPickup();
    expect(m.state.contraband[0]!.carrier).toBe(a);
    // enemy b rams carrier a — transfer to attacker
    m.onRam(a, b, 10);
    expect(m.state.contraband[0]!.carrier).toBe(b);
    // a rams back inside the cooldown — blocked
    m.onRam(b, a, 10.1);
    expect(m.state.contraband[0]!.carrier).toBe(b);
    // after cooldown — allowed
    m.onRam(b, a, 11);
    expect(m.state.contraband[0]!.carrier).toBe(a);
  });

  it('same-team ram transfers too', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const b = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const], [b.id, 0 as const]]);
    const m = makeMatch([a, b], teams);
    a.pos.copy(m.state.contraband[0]!.pos);
    m.checkPickup();
    m.onRam(a, b, 10);
    expect(m.state.contraband[0]!.carrier).toBe(b);
    expect(m.drainEvents().some(e => e.type === 'steal')).toBe(true);
  });

  it('delivers and scores for the carrying team', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const]]);
    const m = makeMatch([a], teams);
    a.pos.copy(m.state.contraband[0]!.pos);
    m.checkPickup();
    a.pos.copy(m.state.bases[0]);
    m.checkDelivery();
    expect(m.state.scores[0]).toBe(1);
    const evts = m.drainEvents();
    expect(evts.some(e => e.type === 'deliver')).toBe(true);
    expect(m.state.contraband[0]!.carrier).toBeNull();
  });

  it('wins at the score goal', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const]]);
    const m = makeMatch([a], teams);
    for (let i = 0; i < DEFAULT_SCORING.scoreGoal; i++) {
      a.pos.copy(m.state.contraband[0]!.pos);
      m.checkPickup();
      a.pos.copy(m.state.bases[0]);
      m.checkDelivery();
    }
    expect(m.state.winner).toBe(0);
    expect(m.state.scores[0]).toBe(DEFAULT_SCORING.scoreGoal);
  });
});

describe('four crates at once', () => {
  const carry = (m: MatchRules, v: VehicleBody, i: number): void => {
    v.pos.copy(m.state.contraband[i]!.pos);
    m.checkPickup();
  };
  const deliver = (m: MatchRules, v: VehicleBody, team: 0 | 1): void => {
    v.pos.copy(m.state.bases[team]);
    m.checkDelivery();
  };

  it('starts a wave with four independent crates in different places', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const m = makeMatch([a], new Map([[a.id, 0 as const]]));
    const crates = m.state.contraband;
    expect(crates).toHaveLength(4);
    expect(crates.every(c => c.carrier === null)).toBe(true);
    expect(new Set(crates.map(c => c.id)).size).toBe(4);
    for (let i = 0; i < crates.length; i++) {
      for (let j = i + 1; j < crates.length; j++) {
        expect(crates[i]!.pos.distanceTo(crates[j]!.pos)).toBeGreaterThan(1);
      }
    }
  });

  it('carries and delivers each crate independently', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const b = new VehicleBody(VEHICLE_TYPES[2]!);
    const m = makeMatch([a, b], new Map([[a.id, 0 as const], [b.id, 1 as const]]));
    carry(m, a, 0);
    carry(m, b, 1);
    expect(m.state.contraband[0]!.carrier).toBe(a);
    expect(m.state.contraband[1]!.carrier).toBe(b);
    deliver(m, a, 0);
    expect(m.state.scores[0]).toBe(1);
    expect(m.state.scores[1]).toBe(0);
    // b still holds its own crate, untouched by a's delivery
    expect(m.state.contraband[1]!.carrier).toBe(b);
  });

  it('will not let one car hold two', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const m = makeMatch([a], new Map([[a.id, 0 as const]]));
    carry(m, a, 0);
    carry(m, a, 1);
    expect(m.state.contraband[0]!.carrier).toBe(a);
    expect(m.state.contraband[1]!.carrier).toBeNull();
  });

  it('transfers only the crate the rammed car was holding', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const b = new VehicleBody(VEHICLE_TYPES[2]!);
    const c = new VehicleBody(VEHICLE_TYPES[2]!);
    const m = makeMatch([a, b, c], new Map([[a.id, 0 as const], [b.id, 1 as const], [c.id, 1 as const]]));
    carry(m, a, 0);
    carry(m, b, 1);
    m.onRam(a, c, 10); // c rams a, taking a's crate only
    expect(m.state.contraband[0]!.carrier).toBe(c);
    expect(m.state.contraband[1]!.carrier).toBe(b);
  });

  it('holds the next wave until every crate of this one is home', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const m = makeMatch([a], new Map([[a.id, 0 as const]]));
    const before = m.state.contraband.map(c => c.pos.clone());
    for (let i = 0; i < 3; i++) {
      carry(m, a, i);
      deliver(m, a, 0);
      expect(m.state.contraband).toHaveLength(4);
      // the crates not yet delivered have not moved
      expect(m.state.contraband[3]!.pos.distanceTo(before[3]!)).toBe(0);
    }
    carry(m, a, 3);
    deliver(m, a, 0);
    // fourth one home: a fresh wave, in new places
    expect(m.state.contraband).toHaveLength(4);
    expect(m.state.contraband.every(c => c.carrier === null)).toBe(true);
    const moved = m.state.contraband.filter((c, i) => c.pos.distanceTo(before[i]!) > 1);
    expect(moved.length).toBeGreaterThan(0);
  });

  it('drops only the wrecked driver\'s crate, where they died', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const b = new VehicleBody(VEHICLE_TYPES[2]!);
    const m = makeMatch([a, b], new Map([[a.id, 0 as const], [b.id, 1 as const]]));
    carry(m, a, 0);
    carry(m, b, 1);
    a.pos.set(120, 0, -75);
    m.dropFrom(a);
    expect(m.state.contraband[0]!.carrier).toBeNull();
    expect(m.state.contraband[0]!.pos.x).toBeCloseTo(120, 6);
    expect(m.state.contraband[0]!.pos.z).toBeCloseTo(-75, 6);
    expect(m.state.contraband[1]!.carrier).toBe(b);
  });

  it('still ends the match at the score goal, mid-wave', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const m = makeMatch([a], new Map([[a.id, 0 as const]]));
    for (let n = 0; n < DEFAULT_SCORING.scoreGoal; n++) {
      const idx = m.state.contraband.findIndex(c => c.carrier === null);
      carry(m, a, idx);
      deliver(m, a, 0);
    }
    expect(m.state.scores[0]).toBe(DEFAULT_SCORING.scoreGoal);
    expect(m.state.winner).toBe(0);
  });
});
