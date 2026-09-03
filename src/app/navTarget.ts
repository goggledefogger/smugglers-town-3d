/**
 * Where the player should be driving, and why.
 *
 * The question this answers is "am I carrying?", never "is anyone carrying?".
 * Those are the same only until somebody rams the crate off you: a rival
 * carrier has to swing the marker onto them, because a base you cannot deliver
 * to is the one place on the map with nothing for you.
 *
 * There is exactly one crate and so at most one carrier — the marker never has
 * a choice of targets to arbitrate between.
 *
 * Deliberately free of runtime imports so the HUD store, the local sim and the
 * network client can all share it without an import cycle.
 */
import type { Vector3 } from 'three';
import type { MatchState } from '../core/gameplay/MatchRules.ts';
import type { VehicleActor } from './Game.ts';

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

export interface NavTarget {
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
  const held = state.carrier;
  if (!held) return { goal: 'collect', pos: state.contrabandPos, carrier: null };
  if (held === player.body) return { goal: 'deliver', pos: state.bases[player.team], carrier: null };
  const carrier = vehicles.find(a => a.body === held) ?? null;
  // held by a body that is not in this view's roster: still chase the crate itself
  if (!carrier) return { goal: 'chase', pos: held.pos, carrier: null };
  return {
    goal: carrier.team === player.team ? 'escort' : 'chase',
    pos: carrier.body.pos,
    carrier
  };
}
