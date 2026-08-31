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

  constructor(
    private readonly cfg: DriverConfig,
    private readonly teamOf: (v: VehicleBody) => number
  ) {}

  think(dt: number, self: VehicleBody, match: MatchState): void {
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
        // ally carries — support: head to the drop zone or re-seek
        this.state = Math.random() < 0.6 ? 'deliver' : 'seek';
      }
    }
    this.steerToward(self, match);
  }

  private steerToward(self: VehicleBody, match: MatchState): void {
    if (this.state === 'seek') {
      _target.copy(match.contrabandPos);
    } else if (this.state === 'chase') {
      _target.copy(match.carrier!.pos).addScaledVector(match.carrier!.vel, 0.3);
      _target.y = self.pos.y;
    } else {
      _target.copy(match.dropZonePos);
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
