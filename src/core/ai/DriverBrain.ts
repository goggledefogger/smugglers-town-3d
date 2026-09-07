/**
 * AI driver: tactical state machine (seek / chase / deliver / escort) plus
 * steering toward the target via routed waypoints, predictive interception,
 * defensive escort body-blocking, and high-speed cornering.
 */
import { Vector3, MathUtils } from 'three';
import type { VehicleInput } from '../physics/vehicleStats.ts';
import type { VehicleBody } from '../physics/VehicleBody.ts';
import { chooseCrate, type MatchState } from '../gameplay/MatchRules.ts';
import type { Rng } from '../rng.ts';

type AiState = 'seek' | 'chase' | 'deliver' | 'escort';

export interface DriverConfig {
  readonly reevaluateS: number;
  readonly steerGain: number;
  readonly slowTurnAngle: number;
  readonly slowTurnSpeed: number;
  readonly interceptLead?: number;
  readonly ramDist?: number;
}

export const DEFAULT_DRIVER: DriverConfig = {
  reevaluateS: 0.2,
  steerGain: 2.4,
  slowTurnAngle: 1.55,
  slowTurnSpeed: 45,
  interceptLead: 1.0,
  ramDist: 40
};

/**
 * Next point to steer toward on the way from `from` to `to`, or null to
 * drive straight. `kind` names the target ('contraband', 'carrier',
 * 'base0', 'base1') so routes can be shared and cached per target.
 */
export type RouteFn = (kind: string, from: Vector3, to: Vector3) => Vector3 | null;

/** Full throttle but crawling for this long means we are wedged against something. */
const STUCK_S = 0.8;
/** How long to back out before trying again. */
const UNSTICK_S = 0.9;

const _target = new Vector3();
const _toTarget = new Vector3();
const _fwd = new Vector3();
const _cross = new Vector3();
const _toBase = new Vector3();

export class DriverBrain {
  private state: AiState = 'seek';
  private timer = 0;
  private steer = 0;
  private throttle = 0;
  private brake = 0;
  private handbrake = false;
  private jump = false;
  private stuckS = 0;
  private unstickS = 0;
  private unstickSteer = 1;

  constructor(
    private readonly cfg: DriverConfig,
    private readonly teamOf: (v: VehicleBody) => number,
    private readonly rng: Rng = Math.random
  ) {}

  think(
    dt: number,
    self: VehicleBody,
    match: MatchState,
    route: RouteFn | null = null,
    allVehicles?: readonly VehicleBody[]
  ): void {
    if (this.unstickS > 0) {
      // reversing out of whatever we hit — the fallback when routing wasn't enough
      this.unstickS -= dt;
      this.throttle = 0;
      this.brake = 1;
      this.handbrake = false;
      this.steer = this.unstickSteer;
      return;
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.cfg.reevaluateS * (0.8 + 0.4 * this.rng());
      // the same rule the player's marker uses, so a bot never fights for a
      // crate the HUD is telling you to ignore
      const choice = chooseCrate(match, self, b => (this.teamOf(b) === 1 ? 1 : 0));
      this.state = choice.goal === 'deliver' ? 'deliver'
        : choice.goal === 'chase' ? 'chase'
        : choice.goal === 'escort' ? 'escort'
        : 'seek';
    }
    this.steerToward(self, match, route, allVehicles);
    if (this.throttle > 0.5 && self.speed < 3 && self.onGround) this.stuckS += dt;
    else this.stuckS = 0;
    if (this.stuckS > STUCK_S) {
      this.stuckS = 0;
      this.unstickS = UNSTICK_S;
      this.unstickSteer = this.rng() < 0.5 ? -1 : 1;
    }
  }

  private steerToward(
    self: VehicleBody,
    match: MatchState,
    route: RouteFn | null,
    allVehicles?: readonly VehicleBody[]
  ): void {
    // the state is re-evaluated on a timer, so the crate may have been
    // delivered (or stolen) since: ask again rather than steer at a stale spot
    const choice = chooseCrate(match, self, b => (this.teamOf(b) === 1 ? 1 : 0));
    const holder = choice.crate?.carrier ?? null;
    let kind: string;

    if (this.state === 'chase' && holder && holder !== self) {
      // Dynamic lead time based on distance and relative approach speed
      const dist = self.pos.distanceTo(holder.pos);
      const mySpeed = Math.max(20, self.speed);
      const tArrival = Math.min(2.0, dist / mySpeed);
      const leadFactor = this.cfg.interceptLead ?? 1.0;
      _target.copy(holder.pos).addScaledVector(holder.vel, tArrival * leadFactor);

      // Cut off the carrier's line to their base
      const enemyTeam = this.teamOf(holder) === 1 ? 1 : 0;
      const enemyBase = match.bases[enemyTeam];
      if (enemyBase) {
        _toBase.copy(enemyBase).sub(holder.pos).normalize();
        const cutoffWeight = Math.min(25, dist * 0.35);
        _target.addScaledVector(_toBase, cutoffWeight);
      }
      _target.y = self.pos.y;
      kind = 'carrier';
    } else if (this.state === 'escort' && holder && holder !== self) {
      // Escort role: find closest threatening rival to ally and body-block/ram them
      let closestThreat: VehicleBody | null = null;
      let closestDist = Infinity;
      if (allVehicles) {
        const myTeam = this.teamOf(self);
        for (const v of allVehicles) {
          if (v === self || this.teamOf(v) === myTeam) continue;
          const d = v.pos.distanceTo(holder.pos);
          if (d < closestDist) {
            closestDist = d;
            closestThreat = v;
          }
        }
      }
      if (closestThreat && closestDist < 140) {
        // Intercept threatening rival
        _target.copy(closestThreat.pos).addScaledVector(closestThreat.vel, 0.4);
        _target.y = self.pos.y;
        kind = 'rival';
      } else {
        // Shadow ally carrier home
        const myTeam = this.teamOf(self) === 1 ? 1 : 0;
        const base = match.bases[myTeam];
        if (base) {
          _target.copy(holder.pos).lerp(base, 0.25);
        } else {
          _target.copy(holder.pos);
        }
        kind = 'escort';
      }
    } else if (this.state === 'deliver') {
      const team = this.teamOf(self) === 1 ? 1 : 0;
      _target.copy(match.bases[team]);
      kind = 'base' + team;
    } else {
      _target.copy(choice.pos);
      kind = 'contraband';
    }

    _toTarget.copy(_target).sub(self.pos);
    _toTarget.y = 0;
    if (_toTarget.length() < 1) {
      this.steer = 0;
      this.throttle = 0;
      this.brake = 0;
      this.handbrake = false;
      return;
    }
    const wp = route?.(kind, self.pos, _target);
    if (wp) {
      _toTarget.copy(wp).sub(self.pos);
      _toTarget.y = 0;
    }
    _toTarget.normalize();
    self.forward(_fwd);
    _fwd.y = 0;
    _fwd.normalize();
    const dot = _fwd.dot(_toTarget);
    _cross.crossVectors(_fwd, _toTarget);
    const angle = Math.atan2(_cross.y, dot);
    const absAngle = Math.abs(angle);
    this.steer = MathUtils.clamp(angle * this.cfg.steerGain, -1, 1);

    const isRamming = (this.state === 'chase' || this.state === 'escort')
      && self.pos.distanceTo(_target) < (this.cfg.ramDist ?? 40);

    if (isRamming) {
      // Maximum aggression: pin throttle, no braking when in strike range
      this.throttle = 1;
      this.brake = 0;
      this.handbrake = false;
      if (self.onGround && dot > 0.85 && self.pos.distanceTo(_target) < 18 && this.rng() < 0.05) {
        this.jump = true;
      }
    } else if (absAngle > this.cfg.slowTurnAngle && self.speed > this.cfg.slowTurnSpeed) {
      // Very sharp hairpin at extreme speed: throttle + light brake + drift
      this.throttle = 0.75;
      this.brake = 0.15;
      this.handbrake = true;
    } else if (absAngle > 1.2 && self.speed > 30) {
      // Sharp corner at speed: drift assist with power
      this.throttle = 0.85;
      this.brake = 0;
      this.handbrake = true;
    } else {
      // Full power drive
      this.throttle = 1;
      this.brake = 0;
      this.handbrake = false;
    }
    if (self.onGround && this.rng() < 0.003) this.jump = true;
  }

  input(): VehicleInput {
    const jump = this.jump;
    this.jump = false;
    return {
      throttle: this.throttle,
      brake: this.brake,
      steer: this.steer,
      jump,
      handbrake: this.handbrake
    };
  }
}
