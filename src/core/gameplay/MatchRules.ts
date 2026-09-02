/**
 * Match rules: contraband pickup, ram-transfer with cooldown, delivery to
 * the carrier's own team base, scoring, win condition, and respawn. Pure
 * logic over vehicles — no scene.
 */
import { Vector3 } from 'three';
import type { Heightfield } from '../heightfield.ts';
import type { VehicleBody } from '../physics/VehicleBody.ts';

export type TeamId = 0 | 1;

export interface ScoringConfig {
  readonly scoreGoal: number;
  readonly deliveryRadius: number;
  readonly contrabandRadius: number;
  readonly transferCooldownS: number;
  readonly spawnClearance: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  scoreGoal: 5,
  deliveryRadius: 22,
  contrabandRadius: 4.5,
  transferCooldownS: 0.6,
  spawnClearance: 40
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
    private readonly mapHalf: number,
    /** True when any building lies within r of (x, z) — no spawning there. */
    private readonly blocked: (x: number, z: number, r: number) => boolean = () => false
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
   * Random point at least minDist from every vehicle and both bases, with
   * clearR of open ground around it, for contraband placement.
   */
  private randomClearPoint(minDist: number, clearR: number, spread = 1.6): Vector3 {
    let x = 0, z = 0;
    for (let tries = 0; tries < 40; tries++) {
      x = (Math.random() - 0.5) * this.mapHalf * spread;
      z = (Math.random() - 0.5) * this.mapHalf * spread;
      const far = !this.blocked(x, z, clearR)
        && this.vehicles.every(v => Math.hypot(x - v.pos.x, z - v.pos.z) > minDist)
        && ([0, 1] as const).every(t => Math.hypot(x - this.bases[t].x, z - this.bases[t].z) > minDist);
      if (far) break;
    }
    return new Vector3(x, 0, z);
  }

  /** Nearest clear spot to (x, z) in a widening jitter, else anywhere clear. */
  private clearPointNear(x: number, z: number, clearR: number): { x: number; z: number } {
    for (let tries = 0; tries < 40; tries++) {
      const jitter = tries * 6;
      const px = x + (Math.random() - 0.5) * jitter;
      const pz = z + (Math.random() - 0.5) * jitter;
      if (!this.blocked(px, pz, clearR)) return { x: px, z: pz };
    }
    const p = this.randomClearPoint(0, clearR, 1.7);
    return { x: p.x, z: p.z };
  }

  /**
   * Put the two bases on opposite sides of the field, each on clear ground.
   * Called once per match; bases never move within it.
   */
  placeBases(): void {
    const ang = Math.random() * Math.PI * 2;
    const r = this.mapHalf * 0.65;
    for (const team of [0, 1] as const) {
      const a = ang + team * Math.PI;
      const p = this.clearPointNear(Math.cos(a) * r, Math.sin(a) * r, this.cfg.deliveryRadius * 0.6);
      this.bases[team].set(p.x, this.ground.sample(p.x, p.z), p.z);
    }
  }

  spawnContraband(): void {
    const p = this.randomClearPoint(this.cfg.spawnClearance, 5);
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
  respawnPoint(team: TeamId): { x: number; z: number } {
    const b = this.bases[team];
    const len = Math.hypot(b.x, b.z) || 1;
    return this.clearPointNear(b.x - (b.x / len) * 40, b.z - (b.z / len) * 40, 6);
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

  checkPickup(carScale: number): void {
    if (this.carrier) return;
    const R = this.cfg.contrabandRadius * carScale;
    for (const v of this.vehicles) {
      if (v.pos.distanceTo(this.contrabandPos) < R) {
        this.carrier = v;
        this.events.push({ type: 'pickup', vehicle: v });
        break;
      }
    }
  }

  /** Scores only at the carrier's own base; the enemy base is just scenery. */
  checkDelivery(carScale: number): void {
    const carrier = this.carrier;
    if (!carrier) return;
    const team = this.teams.get(carrier.id);
    if (team === undefined) return;
    if (carrier.pos.distanceTo(this.bases[team]) >= this.cfg.deliveryRadius * carScale) return;
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
