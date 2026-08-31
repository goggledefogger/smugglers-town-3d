import { describe, it, expect } from 'vitest';
import { MatchRules, DEFAULT_SCORING } from '../src/core/gameplay/MatchRules.ts';
import { VehicleBody } from '../src/core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../src/core/physics/vehicleStats.ts';
import { Heightfield } from '../src/core/heightfield.ts';

const FLAT = new Heightfield(840, 1, new Float32Array([0, 0, 0, 0]));

function makeMatch(bodies: VehicleBody[], teams: ReadonlyMap<number, 0 | 1>): MatchRules {
  const m = new MatchRules(DEFAULT_SCORING, bodies, teams, FLAT, 420);
  m.spawnContraband();
  m.relocateDropZone();
  return m;
}

describe('MatchRules', () => {
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

  it('same-team ram does not transfer', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const b = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const], [b.id, 0 as const]]);
    const m = makeMatch([a, b], teams);
    a.pos.copy(m.state.contrabandPos);
    m.checkPickup(1);
    m.onRam(a, b, 10);
    expect(m.state.carrier).toBe(a);
  });

  it('delivers and scores for the carrying team', () => {
    const a = new VehicleBody(VEHICLE_TYPES[2]!);
    const teams = new Map([[a.id, 0 as const]]);
    const m = makeMatch([a], teams);
    a.pos.copy(m.state.contrabandPos);
    m.checkPickup(1);
    a.pos.copy(m.state.dropZonePos);
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
      a.pos.copy(m.state.dropZonePos);
      m.checkDelivery(1);
    }
    expect(m.state.winner).toBe(0);
    expect(m.state.scores[0]).toBe(DEFAULT_SCORING.scoreGoal);
  });
});
