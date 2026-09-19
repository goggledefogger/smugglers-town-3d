/**
 * Where the player should be driving, and why.
 *
 * The question this answers is "am I carrying?", never "is anyone carrying?".
 * Those are the same only until somebody rams the crate off you: a rival
 * carrier has to swing the marker onto them, because a base you cannot deliver
 * to is the one place on the map with nothing for you.
 *
 * With four crates live there IS a choice to arbitrate, and the order is:
 * the nearest loose crate, else the nearest one a rival is running off with,
 * else the nearest teammate to escort. Nearest first because the marker's job
 * is the next thing you can act on, not the most valuable thing on the map —
 * and a car holds only one crate, so acting on one means ignoring the rest.
 *
 * Deliberately free of runtime imports so the HUD store, the local sim and the
 * network client can all share it without an import cycle.
 */
import { Vector3 } from 'three';
import { chooseCrate, type MatchState } from '../core/gameplay/MatchRules.ts';
import type { VehicleActor } from './Game.ts';
import type { VehicleBody } from '../core/physics/VehicleBody.ts';

export type NavGoal =
  /** Nobody has it: drive to the loose crate. */
  | 'collect'
  /** You have it: drive it home. */
  | 'deliver'
  /** A rival has it: run them down and take it back. */
  | 'chase'
  /** A teammate has it: stay with them and body-block the chasers. */
  | 'escort';

export const OBJECTIVE_TEXT = {
  collect: 'FIND CONTRABAND',
  deliver: 'DELIVER CONTRABAND',
  chase: 'TAKE IT BACK',
  escort: 'ESCORT YOUR CARRIER'
} as const satisfies Record<NavGoal, string>;

export type ObjectiveText = (typeof OBJECTIVE_TEXT)[NavGoal];

interface NavTarget {
  readonly goal: NavGoal;
  /** Live position — a carrier's own, so the marker tracks a moving car. */
  readonly pos: Vector3;
  /** The car being chased or escorted; null when the target does not move. */
  readonly carrier: VehicleActor | null;
}

export function navTarget(
  state: MatchState,
  player: VehicleActor,
  vehicles: readonly VehicleActor[]
): NavTarget {
  const teamOf = (body: VehicleBody): 0 | 1 | undefined =>
    vehicles.find(a => a.body === body)?.team;
  const choice = chooseCrate(state, player.body, teamOf);
  const holder = choice.crate?.carrier ?? null;
  return {
    goal: choice.goal,
    pos: choice.pos,
    carrier: holder && holder !== player.body ? vehicles.find(a => a.body === holder) ?? null : null
  };
}

const _toTarget = new Vector3();
const _fwd = new Vector3();

/**
 * Bearing, planar distance and target position for the nav chevron and the
 * radar. Both the local sim and the network client need it and had a copy
 * each, 15 of 17 lines identical.
 *
 * Null when there is no player, or when you are all but standing on the
 * target — a bearing from zero distance is noise, not information.
 */
export function navMarkerFor(
  state: MatchState,
  player: VehicleActor,
  vehicles: readonly VehicleActor[]
): { yaw: number; distance: number; target: Vector3 } | null {
  const target = navTarget(state, player, vehicles).pos;
  _toTarget.copy(target).sub(player.body.pos);
  _toTarget.y = 0;
  const planar = _toTarget.length();
  if (planar < 1) return null;
  _toTarget.normalize();
  const fwd = player.body.forward(_fwd);
  fwd.y = 0;
  fwd.normalize();
  // ahead first: cross() below overwrites _toTarget with the cross product
  const ahead = _toTarget.dot(fwd);
  const right = _toTarget.cross(fwd).y;
  return { yaw: Math.atan2(right, ahead), distance: planar, target };
}
