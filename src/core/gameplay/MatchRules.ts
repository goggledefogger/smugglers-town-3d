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

export interface ScoringConfig {
  readonly scoreGoal: number;
  readonly deliveryRadius: number;
  readonly contrabandRadius: number;
  readonly transferCooldownS: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  scoreGoal: 5,
  deliveryRadius: 22,
  contrabandRadius: 4.5,
  transferCooldownS: 0.6
};

export type MatchEvent =
  | { type: 'pickup'; vehicle: VehicleBody }
  | { type: 'steal'; attacker: VehicleBody; victim: VehicleBody }
  | { type: 'deliver'; team: TeamId; carrier: VehicleBody }
  | { type: 'drop'; vehicle: VehicleBody }
  | { type: 'win'; team: TeamId };

export interface MatchState {
  readonly scores: Readonly<Record<TeamId, number>>;
  readonly carrier: VehicleBody | null;
  readonly contrabandPos: Vector3;
  /** Each team's base — deliver there to score. Fixed for the whole match. */
  readonly bases: Readonly<Record<TeamId, Vector3>>;
  readonly winner: TeamId | null;
}

export class MatchRules {
  private scores: Record<TeamId, number> = { 0: 0, 1: 0 };
  private carrier: VehicleBody | null = null;
  private lastTransfer = -Infinity;
  private readonly contrabandPos = new Vector3();
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
      carrier: this.carrier,
      contrabandPos: this.contrabandPos,
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

  spawnContraband(): void {
    const avoid: Vec2[] = [
      ...this.vehicles.map(v => ({ x: v.pos.x, z: v.pos.z })),
      { x: this.bases[0].x, z: this.bases[0].z },
      { x: this.bases[1].x, z: this.bases[1].z }
    ];
    const p = this.spawn.item(avoid);
    this.contrabandPos.set(p.x, this.ground.sample(p.x, p.z) + 3, p.z);
    this.carrier = null;
  }

  /** A body was replaced in place (vehicle switch): the contraband stays with the driver. */
  swapVehicle(from: VehicleBody, to: VehicleBody): void {
    if (this.carrier === from) this.carrier = to;
  }

  /** The carrier wrecked: the crate falls where it was, free for anyone. */
  dropFrom(body: VehicleBody): void {
    if (this.carrier !== body) return;
    this.contrabandPos.set(body.pos.x, this.ground.sample(body.pos.x, body.pos.z) + 3, body.pos.z);
    this.carrier = null;
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
    if (!this.carrier) return;
    if (this.carrier !== a && this.carrier !== b) return;
    if (!this.teams.has(a.id) || !this.teams.has(b.id)) return;
    if (nowS - this.lastTransfer <= this.cfg.transferCooldownS) return;
    const attacker = this.carrier === a ? b : a;
    const victim = this.carrier;
    this.carrier = attacker;
    this.lastTransfer = nowS;
    this.events.push({ type: 'steal', attacker, victim });
  }

  checkPickup(): void {
    if (this.carrier) return;
    const R = this.cfg.contrabandRadius;
    for (const v of this.vehicles) {
      if (v.pos.distanceTo(this.contrabandPos) < R) {
        this.carrier = v;
        this.events.push({ type: 'pickup', vehicle: v });
        break;
      }
    }
  }

  /** Scores only at the carrier's own base; the enemy base is just scenery. */
  checkDelivery(): void {
    const carrier = this.carrier;
    if (!carrier) return;
    const team = this.teams.get(carrier.id);
    if (team === undefined) return;
    if (carrier.pos.distanceTo(this.bases[team]) >= this.cfg.deliveryRadius) return;
    this.scores[team] = (this.scores[team] ?? 0) + 1;
    this.carrier = null;
    this.events.push({ type: 'deliver', team, carrier });
    if ((this.scores[team] ?? 0) >= this.cfg.scoreGoal) {
      this.winner = team;
      this.events.push({ type: 'win', team });
    } else {
      this.spawnContraband();
    }
  }

  /** Drain accumulated events since the last call. */
  drainEvents(): MatchEvent[] {
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }
}
