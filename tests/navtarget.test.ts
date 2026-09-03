import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { navTarget, OBJECTIVE_TEXT } from '../src/app/navTarget.ts';
import { VehicleBody } from '../src/core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../src/core/physics/vehicleStats.ts';
import type { VehicleActor } from '../src/app/Game.ts';
import type { MatchState } from '../src/core/gameplay/MatchRules.ts';

function actor(team: 0 | 1, label: string, at: [number, number, number]): VehicleActor {
  const body = new VehicleBody(VEHICLE_TYPES[2]!);
  body.pos.set(...at);
  return { body, team, isPlayer: label === 'you', label, control: 'bot', brain: null };
}

const BASES = { 0: new Vector3(-500, 0, 0), 1: new Vector3(500, 0, 0) } as const;

function state(carrier: VehicleBody | null, crateAt: [number, number, number] = [0, 0, 0]): MatchState {
  return {
    scores: { 0: 0, 1: 0 },
    carrier,
    contrabandPos: new Vector3(...crateAt),
    bases: BASES,
    winner: null
  };
}

describe('navTarget', () => {
  it('sends you to the loose crate when nobody has it', () => {
    const you = actor(0, 'you', [10, 0, 10]);
    const t = navTarget(state(null, [100, 0, 0]), you, [you]);
    expect(t.goal).toBe('collect');
    expect(t.pos.x).toBe(100);
    expect(t.carrier).toBeNull();
  });

  it('sends you to your own base while you are carrying', () => {
    const you = actor(0, 'you', [10, 0, 10]);
    const t = navTarget(state(you.body), you, [you]);
    expect(t.goal).toBe('deliver');
    expect(t.pos).toBe(BASES[0]);
  });

  it('swings onto the thief the moment a rival steals it off you', () => {
    // the reported bug: the marker stayed on your base after a steal, sending
    // you to guard a delivery that was never coming
    const you = actor(0, 'you', [10, 0, 10]);
    const thief = actor(1, 'Rook', [300, 0, -80]);
    const t = navTarget(state(thief.body), you, [you, thief]);
    expect(t.goal).toBe('chase');
    expect(t.carrier).toBe(thief);
    expect(t.pos).toBe(thief.body.pos);
    expect(OBJECTIVE_TEXT[t.goal]).toBe('TAKE IT BACK');
  });

  it('tracks the carrier as it drives, rather than a stale snapshot of it', () => {
    const you = actor(0, 'you', [0, 0, 0]);
    const thief = actor(1, 'Rook', [300, 0, 0]);
    const t = navTarget(state(thief.body), you, [you, thief]);
    thief.body.pos.set(-120, 0, 45);
    expect(t.pos.x).toBe(-120);
    expect(t.pos.z).toBe(45);
  });

  it('escorts a teammate who is carrying, instead of chasing them', () => {
    const you = actor(0, 'you', [0, 0, 0]);
    const mate = actor(0, 'Vance', [80, 0, 20]);
    const t = navTarget(state(mate.body), you, [you, mate]);
    expect(t.goal).toBe('escort');
    expect(t.carrier).toBe(mate);
  });

  it('never sends a non-carrier to a base', () => {
    const you = actor(0, 'you', [0, 0, 0]);
    for (const holder of [actor(0, 'Vance', [80, 0, 20]), actor(1, 'Rook', [300, 0, 0])]) {
      const t = navTarget(state(holder.body), you, [you, holder]);
      expect(t.pos).not.toBe(BASES[0]);
      expect(t.pos).not.toBe(BASES[1]);
    }
  });

  it('still chases a crate held by a body missing from the roster', () => {
    const you = actor(0, 'you', [0, 0, 0]);
    const ghost = actor(1, 'Ghost', [12, 0, 34]);
    const t = navTarget(state(ghost.body), you, [you]);
    expect(t.goal).toBe('chase');
    expect(t.pos).toBe(ghost.body.pos);
    expect(t.carrier).toBeNull();
  });
});
