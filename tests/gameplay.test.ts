import { describe, it, expect } from 'vitest';
import { MatchRules, DEFAULT_SCORING } from '../src/core/gameplay/MatchRules.ts';
import { VehicleBody } from '../src/core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../src/core/physics/vehicleStats.ts';
import { Heightfield } from '../src/core/heightfield.ts';

const FLAT = new Heightfield(840, 1, new Float32Array([0, 0, 0, 0]));

function makeMatch(bodies: VehicleBody[], teams: ReadonlyMap<number, 0 | 1>): MatchRules {
  const m = new MatchRules(DEFAULT_SCORING, bodies, teams, FLAT, 420);
  m.placeBases();
  m.spawnContraband();
  return m;
}

describe('MatchRules', () => {
  it('never spawns contraband or a base inside a building', () => {
    const m = new MatchRules(DEFAULT_SCORING, [], new Map(), FLAT, 420, (x) => x > 0);
    for (let i = 0; i < 25; i++) {
      m.placeBases();
      m.spawnContraband();
      expect(m.state.contrabandPos.x).toBeLessThanOrEqual(0);
      expect(m.state.bases[0].x).toBeLessThanOrEqual(0);
      expect(m.state.bases[1].x).toBeLessThanOrEqual(0);
    }
  });

  it('places the bases far apart and keeps them put across deliveries', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const m = makeMatch([a], new Map([[a.id, 0 as const]]));
    const b0 = m.state.bases[0].clone();
    const b1 = m.state.bases[1].clone();
    expect(b0.distanceTo(b1)).toBeGreaterThan(420);
    a.pos.copy(m.state.contrabandPos);
    m.checkPickup(1);
    a.pos.copy(m.state.bases[0]);
    m.checkDelivery(1);
    expect(m.state.scores[0]).toBe(1);
    expect(m.state.bases[0].equals(b0)).toBe(true);
    expect(m.state.bases[1].equals(b1)).toBe(true);
    // the fresh contraband is nowhere near either base
    expect(m.state.contrabandPos.distanceTo(b0)).toBeGreaterThan(DEFAULT_SCORING.spawnClearance);
    expect(m.state.contrabandPos.distanceTo(b1)).toBeGreaterThan(DEFAULT_SCORING.spawnClearance);
  });

  it('drops the crate where a wrecked carrier died and respawns near its base', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const m = makeMatch([a], new Map([[a.id, 0 as const]]));
    a.pos.copy(m.state.contrabandPos);
    m.checkPickup(1);
    a.pos.set(50, 1, 50);
    m.dropFrom(a);
    expect(m.state.carrier).toBeNull();
    expect(m.state.contrabandPos.x).toBeCloseTo(50, 6);
    expect(m.state.contrabandPos.z).toBeCloseTo(50, 6);
    expect(m.drainEvents().some(e => e.type === 'drop')).toBe(true);
    const p = m.respawnPoint(0);
    expect(Math.hypot(p.x - m.state.bases[0].x, p.z - m.state.bases[0].z)).toBeLessThan(80);
  });

  it('does not score at the enemy base', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const m = makeMatch([a], new Map([[a.id, 0 as const]]));
    a.pos.copy(m.state.contrabandPos);
    m.checkPickup(1);
    a.pos.copy(m.state.bases[1]);
    m.checkDelivery(1);
    expect(m.state.scores[0]).toBe(0);
    expect(m.state.carrier).toBe(a);
  });

  it('picks up contraband when a vehicle is inside the radius', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const]]);
    const m = makeMatch([a], teams);
    a.pos.copy(m.state.contrabandPos);
    m.checkPickup(1);
    expect(m.state.carrier).toBe(a);
    const evts = m.drainEvents();
    expect(evts[0]?.type).toBe('pickup');
  });

  it('does not pick up when already carried', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const b = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const], [b.id, 1 as const]]);
    const m = makeMatch([a, b], teams);
    a.pos.copy(m.state.contrabandPos);
    m.checkPickup(1);
    expect(m.state.carrier).toBe(a);
    b.pos.copy(m.state.contrabandPos);
    m.checkPickup(1);
    expect(m.state.carrier).toBe(a);
  });

  it('transfers contraband to the attacker on cross-team ram, blocked within cooldown', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const b = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const], [b.id, 1 as const]]);
    const m = makeMatch([a, b], teams);
    a.pos.copy(m.state.contrabandPos);
    m.checkPickup(1);
    expect(m.state.carrier).toBe(a);
    // enemy b rams carrier a — transfer to attacker
    m.onRam(a, b, 10);
    expect(m.state.carrier).toBe(b);
    // a rams back inside the cooldown — blocked
    m.onRam(b, a, 10.1);
    expect(m.state.carrier).toBe(b);
    // after cooldown — allowed
    m.onRam(b, a, 11);
    expect(m.state.carrier).toBe(a);
  });

  it('same-team ram transfers too', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const b = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const], [b.id, 0 as const]]);
    const m = makeMatch([a, b], teams);
    a.pos.copy(m.state.contrabandPos);
    m.checkPickup(1);
    m.onRam(a, b, 10);
    expect(m.state.carrier).toBe(b);
    expect(m.drainEvents().some(e => e.type === 'steal')).toBe(true);
  });

  it('delivers and scores for the carrying team', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const]]);
    const m = makeMatch([a], teams);
    a.pos.copy(m.state.contrabandPos);
    m.checkPickup(1);
    a.pos.copy(m.state.bases[0]);
    m.checkDelivery(1);
    expect(m.state.scores[0]).toBe(1);
    const evts = m.drainEvents();
    expect(evts.some(e => e.type === 'deliver')).toBe(true);
    expect(m.state.carrier).toBeNull();
  });

  it('wins at the score goal', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const]]);
    const m = makeMatch([a], teams);
    for (let i = 0; i < DEFAULT_SCORING.scoreGoal; i++) {
      a.pos.copy(m.state.contrabandPos);
      m.checkPickup(1);
      a.pos.copy(m.state.bases[0]);
      m.checkDelivery(1);
    }
    expect(m.state.winner).toBe(0);
    expect(m.state.scores[0]).toBe(DEFAULT_SCORING.scoreGoal);
  });
});
