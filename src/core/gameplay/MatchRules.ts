/**
 * Match rules: contraband pickup, ram-transfer with cooldown, delivery to
 * the carrier's own team base, scoring, win condition, and respawn. Pure
 * logic over vehicles — no scene.
 */
import { Vector3 } from 'three';
import type { Heightfield } from '../heightfield.ts';
import type { VehicleBody } from '../physics/VehicleBody.ts';
import { SpawnPlanner, DEFAULT_SPAWN, type SpawnPoint } from '../spawn/SpawnPlanner.ts';
import type { Vec2 } from '../world/OpenSpace.ts';

export type TeamId = 0 | 1;

interface ScoringConfig {
  readonly scoreGoal: number;
  /** How many crates are in play at once; a fresh set lands when all are home. */
  readonly crateCount: number;
  readonly deliveryRadius: number;
  readonly contrabandRadius: number;
  readonly transferCooldownS: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  scoreGoal: 5,
  crateCount: 4,
  deliveryRadius: 22,
  contrabandRadius: 4.5,
  transferCooldownS: 0.6
};

type MatchEvent =
  | { type: 'pickup'; vehicle: VehicleBody }
  | { type: 'steal'; attacker: VehicleBody; victim: VehicleBody }
  | { type: 'deliver'; team: TeamId; carrier: VehicleBody }
  | { type: 'drop'; vehicle: VehicleBody }
  | { type: 'win'; team: TeamId };

/**
 * One crate. Four run at once and each is its own race: picked up, rammed
 * loose and delivered independently of the other three.
 */
export interface Crate {
  readonly id: number;
  /** Where it lies, or where its carrier is. */
  readonly pos: Vector3;
  readonly carrier: VehicleBody | null;
  /** Ram transfers are rate-limited per crate, not across the whole match. */
  lastTransfer: number;
  /** Home for good; the wave resets only when every crate is. */
  delivered: boolean;
}

export interface MatchState {
  readonly scores: Readonly<Record<TeamId, number>>;
  readonly contraband: readonly Crate[];
  /** Each team's base — deliver there to score. Fixed for the whole match. */
  readonly bases: Readonly<Record<TeamId, Vector3>>;
  readonly winner: TeamId | null;
}

export class MatchRules {
  private scores: Record<TeamId, number> = { 0: 0, 1: 0 };
  private crates: Crate[] = [];
  private nextCrateId = 0;
  private readonly bases: Record<TeamId, Vector3> = { 0: new Vector3(), 1: new Vector3() };
  private winner: TeamId | null = null;
  readonly events: MatchEvent[] = [];

  constructor(
    private readonly cfg: ScoringConfig,
    private readonly vehicles: readonly VehicleBody[],
    private readonly teams: ReadonlyMap<number, TeamId>,
    private readonly ground: Heightfield,
    /** Decides every position; see core/spawn/SpawnPlanner. */
    private readonly spawn: SpawnPlanner = new SpawnPlanner(DEFAULT_SPAWN)
  ) {}

  get state(): MatchState {
    return {
      scores: this.scores,
      contraband: this.crates,
      bases: this.bases,
      winner: this.winner
    };
  }

  /**
   * Put the two bases on opposite sides of the field, each on clear ground.
   * Called once per match; bases never move within it.
   */
  placeBases(): void {
    const placed = this.spawn.bases();
    for (const team of [0, 1] as const) {
      const p = placed[team];
      this.bases[team].set(p.x, this.ground.sample(p.x, p.z), p.z);
    }
  }

  /** A fresh wave: every crate loose, none near a car, a base or each other. */
  spawnContraband(): void {
    const avoid: Vec2[] = [
      ...this.vehicles.map(v => ({ x: v.pos.x, z: v.pos.z })),
      { x: this.bases[0].x, z: this.bases[0].z },
      { x: this.bases[1].x, z: this.bases[1].z }
    ];
    this.crates = [];
    for (let i = 0; i < this.cfg.crateCount; i++) {
      const p = this.spawn.item(avoid);
      // each placed crate joins the avoid list, so a wave spreads out instead
      // of dropping four crates on one spot
      avoid.push(p);
      this.crates.push({
        id: this.nextCrateId++,
        pos: new Vector3(p.x, this.ground.sample(p.x, p.z) + 3, p.z),
        carrier: null,
        lastTransfer: -Infinity,
        delivered: false
      });
    }
  }

  /** The crate this car is carrying, if any. A car holds at most one. */
  private heldBy(body: VehicleBody): Crate | undefined {
    return this.crates.find(c => c.carrier === body);
  }

  /** A body was replaced in place (vehicle switch): the contraband stays with the driver. */
  swapVehicle(from: VehicleBody, to: VehicleBody): void {
    const held = this.heldBy(from);
    if (held) (held as { carrier: VehicleBody | null }).carrier = to;
  }

  /** The carrier wrecked: their crate falls where it was, free for anyone. */
  dropFrom(body: VehicleBody): void {
    const held = this.heldBy(body);
    if (!held) return;
    held.pos.set(body.pos.x, this.ground.sample(body.pos.x, body.pos.z) + 3, body.pos.z);
    (held as { carrier: VehicleBody | null }).carrier = null;
    this.events.push({ type: 'drop', vehicle: body });
  }

  /** Clear ground a little in from a team's base, for respawning a wrecked car. */
  respawnPoint(team: TeamId): SpawnPoint {
    return this.spawn.respawn(this.bases[team]);
  }

  /**
   * Called for every ramming pair from the collision resolver. Any ram
   * transfers the crate — teammates included, as in the original — subject
   * to the cooldown.
   */
  onRam(a: VehicleBody, b: VehicleBody, nowS: number): void {
    if (!this.teams.has(a.id) || !this.teams.has(b.id)) return;
    // only the crate the rammed car was holding changes hands; the other three
    // races carry on regardless
    const held = this.heldBy(a) ?? this.heldBy(b);
    if (!held) return;
    if (nowS - held.lastTransfer <= this.cfg.transferCooldownS) return;
    const victim = held.carrier!;
    const attacker = victim === a ? b : a;
    // an attacker with its hands full cannot take another
    if (this.heldBy(attacker)) return;
    (held as { carrier: VehicleBody | null }).carrier = attacker;
    held.lastTransfer = nowS;
    this.events.push({ type: 'steal', attacker, victim });
  }

  checkPickup(): void {
    const R = this.cfg.contrabandRadius;
    for (const v of this.vehicles) {
      if (this.heldBy(v)) continue; // hands full: drive over the rest
      const crate = this.crates.find(c => c.carrier === null && v.pos.distanceTo(c.pos) < R);
      if (!crate) continue;
      (crate as { carrier: VehicleBody | null }).carrier = v;
      this.events.push({ type: 'pickup', vehicle: v });
    }
  }

  /** Scores only at the carrier's own base; the enemy base is just scenery. */
  checkDelivery(): void {
    for (const crate of this.crates) {
      const carrier = crate.carrier;
      if (!carrier) continue;
      const team = this.teams.get(carrier.id);
      if (team === undefined) continue;
      if (carrier.pos.distanceTo(this.bases[team]) >= this.cfg.deliveryRadius) continue;
      this.scores[team] = (this.scores[team] ?? 0) + 1;
      crate.delivered = true;
      (crate as { carrier: VehicleBody | null }).carrier = null;
      this.events.push({ type: 'deliver', team, carrier });
      if ((this.scores[team] ?? 0) >= this.cfg.scoreGoal) {
        this.winner = team;
        this.events.push({ type: 'win', team });
        return;
      }
    }
    // a fresh wave only once every crate of this one is home, so the last one
    // left on the map is worth fighting over
    if (this.crates.length > 0 && this.crates.every(c => c.delivered)) this.spawnContraband();
  }

  /** Drain accumulated events since the last call. */
  drainEvents(): MatchEvent[] {
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }
}

/** What a driver should do about the crates right now. */
type CrateGoal = 'collect' | 'chase' | 'escort' | 'deliver';

interface CrateChoice {
  readonly goal: CrateGoal;
  /** The crate this is about, or null when heading home or waiting on a wave. */
  readonly crate: Crate | null;
  /** Live position to drive at: a loose crate, a carrier, or your own base. */
  readonly pos: Vector3;
}

/** Loose crates first, then a rival to run down, then a teammate to shield. */
const GOAL_RANK: Record<CrateGoal, number> = { collect: 0, chase: 1, escort: 2, deliver: 3 };

/**
 * Which of the four crates this driver should be going for.
 *
 * Nearest first within a priority, because a car holds only one crate: acting
 * on any of them means ignoring the other three, so the useful answer is the
 * next thing you can reach, not the most valuable thing on the map.
 *
 * Lives here rather than in the HUD because the bots steer by it too, and a
 * marker that disagreed with the AI about what was worth chasing would be
 * worse than no marker.
 */
export function chooseCrate(
  state: MatchState,
  self: VehicleBody,
  teamOf: (body: VehicleBody) => TeamId | undefined
): CrateChoice {
  const myTeam = teamOf(self) ?? 0;
  const home = state.bases[myTeam];
  if (state.contraband.some(c => c.carrier === self)) {
    return { goal: 'deliver', crate: state.contraband.find(c => c.carrier === self) ?? null, pos: home };
  }
  let best: CrateChoice | null = null;
  let bestRank = Infinity;
  let bestDist = Infinity;
  for (const crate of state.contraband) {
    if (crate.delivered) continue;
    const goal: CrateGoal = !crate.carrier ? 'collect'
      : teamOf(crate.carrier) === myTeam ? 'escort'
        : 'chase';
    const rank = GOAL_RANK[goal];
    const pos = crate.carrier ? crate.carrier.pos : crate.pos;
    const dist = self.pos.distanceToSquared(pos);
    if (rank > bestRank || (rank === bestRank && dist >= bestDist)) continue;
    bestRank = rank;
    bestDist = dist;
    best = { goal, crate, pos };
  }
  // the whole wave is home and the next has not landed: regroup at base
  return best ?? { goal: 'deliver', crate: null, pos: home };
}
