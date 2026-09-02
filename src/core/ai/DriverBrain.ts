/**
 * AI driver: a small state machine (seek / chase / deliver / support) plus
 * steering toward the current target. Produces a VehicleInput each tick.
 */
import { Vector3, MathUtils } from 'three';
import type { VehicleInput } from '../physics/vehicleStats.ts';
import type { VehicleBody } from '../physics/VehicleBody.ts';
import type { MatchState } from '../gameplay/MatchRules.ts';

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
    private readonly teamOf: (v: VehicleBody) => number
  ) {}

  think(dt: number, self: VehicleBody, match: MatchState): void {
    if (this.unstickS > 0) {
      // reversing out of whatever we hit; bots have no pathfinding, so this
      // is what gets them off building walls
      this.unstickS -= dt;
      this.throttle = 0;
      this.brake = 1;
      this.steer = this.unstickSteer;
      return;
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.cfg.reevaluateS * (1 + Math.random());
      if (!match.carrier) {
        this.state = 'seek';
      } else if (this.teamOf(match.carrier) !== this.teamOf(self)) {
        this.state = 'chase';
      } else if (match.carrier === self) {
        this.state = 'deliver';
      } else {
        // ally carries — support: head to our base or re-seek
        this.state = Math.random() < 0.6 ? 'deliver' : 'seek';
      }
    }
    this.steerToward(self, match);
    if (this.throttle > 0.5 && self.speed < 3 && self.onGround) this.stuckS += dt;
    else this.stuckS = 0;
    if (this.stuckS > STUCK_S) {
      this.stuckS = 0;
      this.unstickS = UNSTICK_S;
      this.unstickSteer = Math.random() < 0.5 ? -1 : 1;
    }
  }

  private steerToward(self: VehicleBody, match: MatchState): void {
    // the state is re-evaluated on a timer, so the carrier may have delivered
    // (or been stolen from) since: fall back to seeking rather than crash
    const carrier = match.carrier;
    if (this.state === 'chase' && carrier) {
      _target.copy(carrier.pos).addScaledVector(carrier.vel, 0.3);
      _target.y = self.pos.y;
    } else if (this.state === 'deliver' && carrier) {
      _target.copy(match.bases[this.teamOf(self) === 1 ? 1 : 0]);
    } else {
      _target.copy(match.contrabandPos);
    }
    _toTarget.copy(_target).sub(self.pos);
    _toTarget.y = 0;
    const dist = _toTarget.length();
    if (dist < 1) {
      this.steer = 0;
      this.throttle = 0;
      return;
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
    if (self.onGround && Math.random() < 0.003) this.jump = true;
  }

  input(): VehicleInput {
    const jump = this.jump;
    this.jump = false;
    return { throttle: this.throttle, brake: this.brake, steer: this.steer, jump };
  }
}
