/**
 * Builds the HUD snapshot from match state.
 *
 * The local sim and the network client both have to produce one, and they had
 * a copy each: 19 of 24 identical lines, differing only in where the phase,
 * label and winner came from. That is how the nav-target bug came to exist in
 * two places and get fixed in one, so the shared rule lives here and the two
 * callers pass in only what genuinely differs between them.
 */
import type { MatchState, TeamId } from '../core/gameplay/MatchRules.ts';
import type { VehicleActor } from './Game.ts';
import { navTarget, OBJECTIVE_TEXT } from './navTarget.ts';
import type { GamePhase, HudSnapshot } from './store.ts';
import { WORLD_M_PER_M } from '../core/geo/ecef.ts';

interface HudInputs {
  readonly state: MatchState;
  readonly player: VehicleActor;
  readonly vehicles: readonly VehicleActor[];
  readonly phase: GamePhase;
  readonly timeLeftS: number;
  readonly locationLabel: string;
  readonly winner: TeamId | null;
}

export function buildHudSnapshot(o: HudInputs): HudSnapshot {
  const { state: st, player, vehicles } = o;
  const nav = navTarget(st, player, vehicles);
  // with four crates live, "held by" means the one you are being sent after,
  // not some arbitrary other race across the map
  const carrying = st.contraband.some(c => c.carrier === player.body);
  const carrier = carrying ? player : nav.carrier;
  return {
    phase: o.phase,
    timeLeftS: o.timeLeftS,
    speed: player.body.speed,
    damage: player.body.damage,
    vehicleName: player.body.stats.name,
    scores: st.scores,
    carrierName: carrier ? (carrier.isPlayer ? 'YOU' : carrier.label) : null,
    carrierIsPlayer: carrier?.isPlayer ?? false,
    carrierIsAlly: carrier ? carrier.team === player.team : false,
    objective: OBJECTIVE_TEXT[nav.goal],
    distanceToTargetM: player.body.pos.distanceTo(nav.pos) / WORLD_M_PER_M,
    navGoal: nav.goal,
    locationLabel: o.locationLabel,
    winner: o.winner,
    teamPips: vehicles.map(a => ({ team: a.team, isPlayer: a.isPlayer }))
  };
}
