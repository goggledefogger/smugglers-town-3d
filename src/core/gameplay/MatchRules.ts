/**
 * Match rules: contraband pickup, ram-transfer with cooldown, delivery,
 * scoring, win condition, and respawn. Pure logic over vehicles — no scene.
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
  | { type: 'win'; team: TeamId };

export interface MatchState {
  readonly scores: Readonly<Record<TeamId, number>>;
  readonly carrier: VehicleBody | null;
  readonly contrabandPos: Vector3;
  readonly dropZonePos: Vector3;
  readonly winner: TeamId | null;
}

export class MatchRules {
  private scores: Record<TeamId, number> = { 0: 0, 1: 0 };
  private carrier: VehicleBody | null = null;
  private lastTransfer = -Infinity;
  private readonly contrabandPos = new Vector3();
  private readonly dropZonePos = new Vector3();
  private winner: TeamId | null = null;
  readonly events: MatchEvent[] = [];

  constructor(
    private readonly cfg: ScoringConfig,
    private readonly vehicles: readonly VehicleBody[],
    private readonly teams: ReadonlyMap<number, TeamId>,
    private readonly ground: Heightfield,
    private readonly mapHalf: number,
    /** True where a point sits inside a building — no spawning there. */
    private readonly blocked: (x: number, z: number) => boolean = () => false
  ) {}

  get state(): MatchState {
    return {
      scores: this.scores,
      carrier: this.carrier,
      contrabandPos: this.contrabandPos,
      dropZonePos: this.dropZonePos,
      winner: this.winner
    };
  }

  /** Random point clear of vehicles and buildings, for contraband / drop zone placement. */
  private randomClearPoint(minDist: number, spread = 1.6): Vector3 {
    let x = 0, z = 0;
    for (let tries = 0; tries < 40; tries++) {
      x = (Math.random() - 0.5) * this.mapHalf * spread;
      z = (Math.random() - 0.5) * this.mapHalf * spread;
      const far = !this.blocked(x, z) && this.vehicles.every(
        v => Math.hypot(x - v.pos.x, z - v.pos.z) > minDist
      );
      if (far) break;
    }
    return new Vector3(x, 0, z);
  }

  spawnContraband(): void {
    const p = this.randomClearPoint(this.cfg.spawnClearance);
    this.contrabandPos.set(p.x, this.ground.sample(p.x, p.z) + 3, p.z);
    this.carrier = null;
  }

  relocateDropZone(): void {
    const p = this.randomClearPoint(this.cfg.spawnClearance * 1.5, 1.7);
    this.dropZonePos.set(p.x, this.ground.sample(p.x, p.z), p.z);
  }

  /** Called for every ramming pair from the collision resolver. */
  onRam(a: VehicleBody, b: VehicleBody, nowS: number): void {
    if (!this.carrier) return;
    if (this.carrier !== a && this.carrier !== b) return;
    const ta = this.teams.get(a.id);
    const tb = this.teams.get(b.id);
    if (ta === undefined || tb === undefined || ta === tb) return;
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

  checkDelivery(carScale: number): void {
    const carrier = this.carrier;
    if (!carrier) return;
    if (carrier.pos.distanceTo(this.dropZonePos) >= this.cfg.deliveryRadius * carScale) return;
    const team = this.teams.get(carrier.id);
    if (team === undefined) return;
    this.scores[team] = (this.scores[team] ?? 0) + 1;
    this.carrier = null;
    this.events.push({ type: 'deliver', team, carrier });
    if ((this.scores[team] ?? 0) >= this.cfg.scoreGoal) {
      this.winner = team;
      this.events.push({ type: 'win', team });
    } else {
      this.spawnContraband();
      this.relocateDropZone();
    }
  }

  /** Drain accumulated events since the last call. */
  drainEvents(): MatchEvent[] {
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }
}
