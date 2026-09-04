/**
 * AI driver: a small state machine (seek / chase / deliver / support) plus
 * steering toward the current target, via a routed waypoint when the game
 * supplies one. Produces a VehicleInput each tick.
 */
import { Vector3, MathUtils } from 'three';
import type { VehicleInput } from '../physics/vehicleStats.ts';
import type { VehicleBody } from '../physics/VehicleBody.ts';
import { chooseCrate, type MatchState } from '../gameplay/MatchRules.ts';
import type { Rng } from '../rng.ts';

type AiState = 'seek' | 'chase' | 'deliver';

export interface DriverConfig {
  readonly reevaluateS: number;
  readonly steerGain: number;
  readonly slowTurnAngle: number;
  readonly slowTurnSpeed: number;
}

export const DEFAULT_DRIVER: DriverConfig = {
  reevaluateS: 0.5,
  steerGain: 1.8,
  slowTurnAngle: 1.3,
  slowTurnSpeed: 20
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

export class DriverBrain {
  private state: AiState = 'seek';
  private timer = 0;
  private steer = 0;
  private throttle = 0;
  private brake = 0;
  private jump = false;
  private stuckS = 0;
  private unstickS = 0;
  private unstickSteer = 1;

  constructor(
    private readonly cfg: DriverConfig,
    private readonly teamOf: (v: VehicleBody) => number,
    private readonly rng: Rng = Math.random
  ) {}

  think(dt: number, self: VehicleBody, match: MatchState, route: RouteFn | null = null): void {
    if (this.unstickS > 0) {
      // reversing out of whatever we hit — the fallback when routing wasn't enough
      this.unstickS -= dt;
      this.throttle = 0;
      this.brake = 1;
      this.steer = this.unstickSteer;
      return;
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.cfg.reevaluateS * (1 + this.rng());
      // the same rule the player's marker uses, so a bot never fights for a
      // crate the HUD is telling you to ignore
      const choice = chooseCrate(match, self, b => (this.teamOf(b) === 1 ? 1 : 0));
      this.state = choice.goal === 'deliver' ? 'deliver'
        : choice.goal === 'chase' ? 'chase'
          // escorting an ally: split between shadowing them home and taking
          // one of the other three, so a team does not convoy behind one crate
          : choice.goal === 'escort' ? (this.rng() < 0.6 ? 'deliver' : 'seek')
            : 'seek';
    }
    this.steerToward(self, match, route);
    if (this.throttle > 0.5 && self.speed < 3 && self.onGround) this.stuckS += dt;
    else this.stuckS = 0;
    if (this.stuckS > STUCK_S) {
      this.stuckS = 0;
      this.unstickS = UNSTICK_S;
      this.unstickSteer = this.rng() < 0.5 ? -1 : 1;
    }
  }

  private steerToward(self: VehicleBody, match: MatchState, route: RouteFn | null): void {
    // the state is re-evaluated on a timer, so the crate may have been
    // delivered (or stolen) since: ask again rather than steer at a stale spot
    const choice = chooseCrate(match, self, b => (this.teamOf(b) === 1 ? 1 : 0));
    const holder = choice.crate?.carrier ?? null;
    let kind: string;
    if (this.state === 'chase' && holder && holder !== self) {
      // lead the target: driving at where they are means arriving behind them
      _target.copy(holder.pos).addScaledVector(holder.vel, 0.3);
      _target.y = self.pos.y;
      kind = 'carrier';
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
    const cross = _fwd.cross(_toTarget);
    const dot = _fwd.dot(_toTarget);
    const angle = Math.atan2(cross.y, dot);
    this.steer = MathUtils.clamp(angle * this.cfg.steerGain, -1, 1);
    if (Math.abs(angle) > this.cfg.slowTurnAngle && self.speed > this.cfg.slowTurnSpeed) {
      this.throttle = 0.1;
      this.brake = 0.5;
    } else {
      this.throttle = 1;
      this.brake = 0;
    }
    if (self.onGround && this.rng() < 0.003) this.jump = true;
  }

  input(): VehicleInput {
    const jump = this.jump;
    this.jump = false;
    return { throttle: this.throttle, brake: this.brake, steer: this.steer, jump };
  }
}
