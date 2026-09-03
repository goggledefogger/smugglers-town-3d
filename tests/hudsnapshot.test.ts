import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { buildHudSnapshot } from '../src/app/hudSnapshot.ts';
import { VehicleBody } from '../src/core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../src/core/physics/vehicleStats.ts';
import { WORLD_M_PER_M } from '../src/core/geo/ecef.ts';
import type { VehicleActor } from '../src/app/Game.ts';
import type { MatchState } from '../src/core/gameplay/MatchRules.ts';

function actor(team: 0 | 1, label: string, isPlayer = false): VehicleActor {
  return { body: new VehicleBody(VEHICLE_TYPES[2]!), team, isPlayer, label, control: 'bot', brain: null };
}

const BASES = { 0: new Vector3(-500, 0, 0), 1: new Vector3(500, 0, 0) } as const;
const state = (carrier: VehicleBody | null, crate = new Vector3(0, 0, 0)): MatchState =>
  ({ scores: { 0: 1, 1: 2 }, carrier, contrabandPos: crate, bases: BASES, winner: null });

const build = (st: MatchState, player: VehicleActor, vehicles: readonly VehicleActor[]) =>
  buildHudSnapshot({
    state: st, player, vehicles,
    phase: 'playing', timeLeftS: 120, locationLabel: 'Procedural Desert', winner: null
  });

describe('buildHudSnapshot', () => {
  it('reports no carrier, and the objective, when the crate is loose', () => {
    const you = actor(0, 'you', true);
    const s = build(state(null), you, [you]);
    expect(s.carrierName).toBeNull();
    expect(s.carrierIsPlayer).toBe(false);
    expect(s.carrierIsAlly).toBe(false);
    expect(s.objective).toBe('FIND CONTRABAND');
    expect(s.navGoal).toBe('collect');
  });

  it('names you YOU when you are the one carrying', () => {
    const you = actor(0, 'you', true);
    const s = build(state(you.body), you, [you]);
    expect(s.carrierName).toBe('YOU');
    expect(s.carrierIsPlayer).toBe(true);
    expect(s.navGoal).toBe('deliver');
  });

  it('tells an ally carrier from a rival one', () => {
    const you = actor(0, 'you', true);
    const mate = actor(0, 'Vance');
    const foe = actor(1, 'Rook');
    const ally = build(state(mate.body), you, [you, mate, foe]);
    expect(ally.carrierName).toBe('Vance');
    expect(ally.carrierIsAlly).toBe(true);
    expect(ally.navGoal).toBe('escort');
    const enemy = build(state(foe.body), you, [you, mate, foe]);
    expect(enemy.carrierIsAlly).toBe(false);
    expect(enemy.navGoal).toBe('chase');
    expect(enemy.objective).toBe('TAKE IT BACK');
  });

  it('reports distance to the target in real metres, not world units', () => {
    const you = actor(0, 'you', true);
    you.body.pos.set(0, 0, 0);
    const s = build(state(null, new Vector3(100, 0, 0)), you, [you]);
    expect(s.distanceToTargetM).toBeCloseTo(100 / WORLD_M_PER_M, 6);
  });

  it('carries one pip per car, flagging which is yours', () => {
    const you = actor(0, 'you', true);
    const others = [actor(0, 'a'), actor(1, 'b'), actor(1, 'c')];
    const s = build(state(null), you, [you, ...others]);
    expect(s.teamPips).toHaveLength(4);
    expect(s.teamPips.filter(p => p.isPlayer)).toHaveLength(1);
    expect(s.teamPips.filter(p => p.team === 1)).toHaveLength(2);
  });

  it('passes through what only the caller knows', () => {
    const you = actor(0, 'you', true);
    const s = buildHudSnapshot({
      state: state(null), player: you, vehicles: [you],
      phase: 'gameover', timeLeftS: 0, locationLabel: 'Portland, OR, USA', winner: 1
    });
    expect(s.phase).toBe('gameover');
    expect(s.locationLabel).toBe('Portland, OR, USA');
    expect(s.winner).toBe(1);
    expect(s.scores).toEqual({ 0: 1, 1: 2 });
  });
});
