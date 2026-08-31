/**
 * Arcade vehicle physics — position, velocity, orientation quaternion, and a
 * step function. Deliberately renderer-agnostic: the view layer binds a mesh
 * to this body, never the reverse.
 *
 * Design notes (ported from the prototype, where these were hard-won):
 * - Floaty gravity (below earth) for hang time.
 * - Air control is damped and capped so a spin settles instead of growing.
 * - Ground auto-righting uses the axis upW × worldUp; the opposite order
 *   amplifies tilt toward a flip and wedges at perfect inversion.
 */
import { Quaternion, Vector3, MathUtils } from 'three';
import type { Heightfield } from '../heightfield.ts';
import type { VehicleInput, VehicleStats } from './vehicleStats.ts';

/** A single collidable building AABB in world space. */
export interface BuildingCollider {
  readonly min: Vector3;
  readonly max: Vector3;
}

export interface VehiclePhysicsConfig {
  readonly gravity: number;
  readonly driveForce: number;
  readonly maxSpeed: number;
  readonly brakeForce: number;
  readonly turnRate: number;
  readonly jumpBoost: number;
  readonly airControl: number;
  readonly rollRecover: number;
  readonly worldHalf: number;
  readonly groundClearance: number;
}

export const DEFAULT_PHYSICS: VehiclePhysicsConfig = {
  gravity: 22,
  driveForce: 62,
  maxSpeed: 78,
  brakeForce: 80,
  turnRate: 2.6,
  jumpBoost: 1.55,
  airControl: 2.1,
  rollRecover: 4.2,
  worldHalf: 420,
  groundClearance: 1.0
};

const WORLD_UP = new Vector3(0, 1, 0);

export class VehicleBody {
  private static nextId = 1;

  readonly id: number;
  readonly stats: VehicleStats;
  readonly cfg: VehiclePhysicsConfig;
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  readonly quat = new Quaternion();
  readonly angVel = new Vector3();
  speed = 0;
  damage = 0;
  onGround = false;
  jumpHeld = false;

  private readonly _fwd = new Vector3();
  private readonly _right = new Vector3();
  private readonly _up = new Vector3();
  private readonly _q = new Quaternion();
  private readonly _axis = new Vector3();

  constructor(stats: VehicleStats, cfg: VehiclePhysicsConfig = DEFAULT_PHYSICS) {
    this.id = VehicleBody.nextId++;
    this.stats = stats;
    this.cfg = cfg;
  }

  /** Forward axis (-Z in body frame) in world space. */
  forward(out = new Vector3()): Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.quat);
  }

  step(
    dt: number,
    input: VehicleInput,
    ground: Heightfield,
    buildings: readonly BuildingCollider[],
    carScale = 1
  ): void {
    const fwd = this.forward(this._fwd);
    const right = this._right.set(1, 0, 0).applyQuaternion(this.quat);
    const up = this._up.set(0, 1, 0).applyQuaternion(this.quat);
    const gh = ground.sample(this.pos.x, this.pos.z);
    this.onGround = this.pos.y - gh < 1.2;

    if (this.onGround) {
      this.groundStep(dt, input, fwd, right, up);
    } else {
      this.airControlStep(dt, input, up);
    }
    this.jumpHeld = input.jump;

    this.integrateAngular(dt);
    this.integratePosition(dt, gh);
    this.resolveBuildings(buildings, carScale);
    this.damage = Math.max(0, this.damage - 0.02 * dt);
    this.speed = this.vel.length();
  }

  private groundStep(
    dt: number,
    input: VehicleInput,
    fwd: Vector3,
    right: Vector3,
    up: Vector3
  ): void {
    const stats = this.stats;
    const driveF = this.cfg.driveForce * stats.accel * input.throttle;
    this.vel.addScaledVector(fwd, driveF * dt);
    if (input.brake > 0) {
      const sp = this.vel.length();
      if (sp > 0.1) {
        const dec = this.cfg.brakeForce * dt * input.brake;
        this.vel.setLength(Math.max(0, sp - dec));
      }
    }
    // rolling resistance + lateral grip
    this.vel.multiplyScalar(1 - 0.9 * dt);
    const sideVel = this.vel.dot(right);
    this.vel.addScaledVector(right, -sideVel * (1 - Math.pow(0.001, dt * stats.grip)));
    const speedFactor = Math.min(1, this.vel.length() / 8);
    this._q.setFromAxisAngle(
      up, input.steer * this.cfg.turnRate * stats.steer * dt * speedFactor
    );
    this.quat.multiply(this._q);
    if (input.jump && !this.jumpHeld) {
      this.vel.y += this.cfg.jumpBoost * 14;
      this.onGround = false;
    }
  }

  private airControlStep(dt: number, input: VehicleInput, up: Vector3): void {
    // Air control adds yaw from steer and pitch from input; angular velocity
    // is damped and capped so a spin settles instead of growing — unbounded
    // steer-roll accumulation was a direct path to landing roof-down
    this.angVel.y += -input.steer * this.cfg.airControl * 0.5 * dt;
    this.angVel.x += (input.pitch ?? 0) * this.cfg.airControl * 0.4 * dt;
    this.angVel.multiplyScalar(1 - 1.6 * dt);
    const ANG_CAP = 3.2;
    if (this.angVel.length() > ANG_CAP) this.angVel.setLength(ANG_CAP);
    // gentle self-leveling toward wheels-down
    const tilt = up.dot(WORLD_UP);
    if (tilt < 0.9) {
      const axis = this._axis.crossVectors(up, WORLD_UP);
      if (axis.lengthSq() < 1e-4) {
        this.forward(axis);
        axis.y = 0;
        if (axis.lengthSq() < 1e-4) axis.set(1, 0, 0);
      }
      axis.normalize();
      const ang = Math.acos(MathUtils.clamp(tilt, -1, 1));
      this._q.setFromAxisAngle(axis, Math.min(ang, 1.4 * dt));
      this.quat.premultiply(this._q);
    }
    this.vel.y -= this.cfg.gravity * dt;
    this.vel.multiplyScalar(1 - 0.06 * dt);
  }

  private integrateAngular(dt: number): void {
    if (this.angVel.lengthSq() > 1e-6) {
      const w = this.angVel.clone().multiplyScalar(dt);
      this._q.setFromAxisAngle(w.clone().normalize(), w.length());
      this.quat.premultiply(this._q);
    }
    if (this.onGround) {
      this.autoRight(dt);
      this.angVel.multiplyScalar(1 - 5 * dt);
    }
  }

  /**
   * Auto-righting: roll the up vector back toward world-up. The axis is
   * upW × worldUp; the opposite order (worldUp × upW) rotates upW AWAY from
   * world-up, amplifying any tilt toward a full flip, and it collapses to
   * zero length when perfectly inverted — leaving the car stuck on its roof.
   * The forward-axis fallback covers that degenerate case.
   */
  private autoRight(dt: number): void {
    const upW = this._up.set(0, 1, 0).applyQuaternion(this.quat);
    const tilt = MathUtils.clamp(upW.dot(WORLD_UP), -1, 1);
    if (tilt >= 0.95) return;
    const axis = this._axis.crossVectors(upW, WORLD_UP);
    if (axis.lengthSq() < 1e-4) {
      if (tilt < 0) {
        // inverted: roll over around the car's forward, made horizontal
        this.forward(axis);
        axis.y = 0;
        if (axis.lengthSq() < 1e-4) axis.set(1, 0, 0);
      } else {
        axis.set(1, 0, 0);
      }
    }
    axis.normalize();
    const ang = Math.acos(tilt);
    const rate = MathUtils.lerp(
      this.cfg.rollRecover, this.cfg.rollRecover * 2.4, 1 - (tilt + 1) / 2
    );
    this._q.setFromAxisAngle(axis, Math.min(ang, rate * dt));
    this.quat.premultiply(this._q);
  }

  private integratePosition(dt: number, gh: number): void {
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y < gh + this.cfg.groundClearance) {
      this.pos.y = gh + this.cfg.groundClearance;
      if (this.vel.y < -4) {
        const impact = -this.vel.y;
        this.damage = Math.min(1, this.damage + impact * 0.004);
        this.vel.y = impact * 0.18;
        // tumble on very hard landings — biased to pitch (forward flip)
        if (impact > 18) {
          const dir = Math.random() < 0.5 ? 1 : -1;
          this.angVel.x += dir * Math.min(impact, 30) * 0.04;
          this.angVel.z += (Math.random() - 0.5) * Math.min(impact, 30) * 0.015;
        }
      } else if (this.vel.y < 0) {
        this.vel.y = 0;
      }
    }
    // world bounds — bounce back
    const B = this.cfg.worldHalf - 8;
    if (Math.abs(this.pos.x) > B) {
      this.pos.x = Math.sign(this.pos.x) * B;
      this.vel.x *= -0.3;
    }
    if (Math.abs(this.pos.z) > B) {
      this.pos.z = Math.sign(this.pos.z) * B;
      this.vel.z *= -0.3;
    }
  }

  private resolveBuildings(buildings: readonly BuildingCollider[], carScale: number): void {
    const r = 2.2 * carScale;
    for (const c of buildings) {
      const cx = MathUtils.clamp(this.pos.x, c.min.x, c.max.x);
      const cy = MathUtils.clamp(this.pos.y, c.min.y, c.max.y);
      const cz = MathUtils.clamp(this.pos.z, c.min.z, c.max.z);
      const dx = this.pos.x - cx;
      const dy = this.pos.y - cy;
      const dz = this.pos.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2);
      let nx: number;
      let ny: number;
      let nz: number;
      if (d > 1e-4) {
        nx = dx / d;
        ny = dy / d;
        nz = dz / d;
      } else {
        // center inside the box — push out along the smallest axis overlap
        const ox = r - Math.min(Math.abs(this.pos.x - c.min.x), Math.abs(this.pos.x - c.max.x));
        const oy = r - Math.min(Math.abs(this.pos.y - c.min.y), Math.abs(this.pos.y - c.max.y));
        const oz = r - Math.min(Math.abs(this.pos.z - c.min.z), Math.abs(this.pos.z - c.max.z));
        if (ox <= oy && ox <= oz) {
          nx = Math.sign(this.pos.x - (c.min.x + c.max.x) / 2) || 1;
          ny = 0;
          nz = 0;
        } else if (oy <= oz) {
          nx = 0;
          ny = Math.sign(this.pos.y - (c.min.y + c.max.y) / 2) || 1;
          nz = 0;
        } else {
          nx = 0;
          ny = 0;
          nz = Math.sign(this.pos.z - (c.min.z + c.max.z) / 2) || 1;
        }
      }
      const push = r - Math.max(d, 1e-4) + 0.05;
      this.pos.x += nx * push;
      this.pos.y += ny * push;
      this.pos.z += nz * push;
      const vn = this.vel.x * nx + this.vel.y * ny + this.vel.z * nz;
      if (vn < 0) {
        this.vel.x -= 1.3 * vn * nx;
        this.vel.y -= 1.3 * vn * ny;
        this.vel.z -= 1.3 * vn * nz;
        const impact = Math.abs(vn);
        if (impact > 6) {
          this.damage = Math.min(1, this.damage + impact * 0.01);
          this.angVel.y += (Math.random() - 0.5) * impact * 0.04;
        }
      }
    }
  }
}
