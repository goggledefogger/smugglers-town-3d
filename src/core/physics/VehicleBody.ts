/**
 * Arcade vehicle physics — position, velocity, orientation quaternion, and a
 * step function. Deliberately renderer-agnostic: the view layer binds a mesh
 * to this body, never the reverse.
 *
 * Design notes (ported from the prototype, where these were hard-won):
 * - Heavy gravity (~2.5x earth at this scale) for snappy, weighty landings.
 * - Air control is damped and capped so a spin settles instead of growing.
 * - Ground auto-righting uses the axis upW × worldUp; the opposite order
 *   amplifies tilt toward a flip and wedges at perfect inversion.
 */
import { Quaternion, Vector3, MathUtils } from 'three';
import type { Heightfield } from '../heightfield.ts';
import type { VehicleInput, VehicleStats } from './vehicleStats.ts';
import type { Rng } from '../rng.ts';
import { sphereVsAabb, type Contact, type CollisionLayer } from './collision.ts';

/** A single collidable box in world space (a building, a prop). */
export interface BuildingCollider {
  readonly min: Vector3;
  readonly max: Vector3;
  /** What it is; the resolver treats every kind the same for now. */
  readonly kind?: CollisionLayer;
}

/** Query an elevated drivable surface (e.g. 3D bridge deck) above the base heightfield. */
export type SurfaceElevationFn = (x: number, z: number, currentY: number, groundY: number) => number | null;

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
  worldHalf: 2800,
  groundClearance: 1.0
};

const WORLD_UP = new Vector3(0, 1, 0);
/** Reverse tops out at this fraction of forward top speed. */
const REVERSE_FRACTION = 0.35;
/**
 * Within this many units above the ride height, a car that is not climbing
 * counts as grounded and is eased back down. The ground step applies no
 * gravity, so without it any downhill leaves the car riding a hair above the
 * terrain in the air state, where steering barely works
 */
const GROUND_SNAP = 2.5;
/** Closing speed onto the ground, relative to the ground's own motion, that counts as a fall. */
const HARD_LANDING_V = 4;
/**
 * Landings up to this closing speed cost nothing; only the excess hurts. A
 * jump that reliably wrecks you is a jump you stop taking, which would be a
 * shame given the whole map is hills. Measured on the procedural desert, a
 * hop lands at 0-4 and the worst run-of-play landing at ~12, so ordinary
 * jumping is free and only a genuine drop — off a building, off a butte —
 * costs integrity. Tune by driving, not by reading: this is a feel number.
 */
const SAFE_LANDING_V = 12;
/** Above this the landing is a crash, not a landing, and the car tumbles. */
const TUMBLE_V = 22;
/** Suspension: the ride height eases toward the ground at this rate (1/s)... */
const RIDE_RATE = 15;
/** ...within this much travel either side of it; beyond that it is clamped. */
const RIDE_TRAVEL = 0.6;
/** Ground steering keeps working this long after leaving the ground ("coyote time"). */
const STEER_GRACE_S = 0.2;
/**
 * How fast the tracked ground-climb rate follows the terrain (1/s). Fast
 * enough to catch a ramp in a few frames, slow enough that noise in the
 * heightfield does not read as a launch.
 */
const CLIMB_SMOOTH = 25;
/** Ceiling on the climb rate a ramp can impart, so a cliff edge cannot fling the car. */
const MAX_CLIMB = 34;
/** The car must have been climbing at least this fast for a crest to launch it. */
const LAUNCH_MIN_CLIMB = 1.5;
/** ...and be outrunning the ground by this much as the slope levels off. */
const LAUNCH_SEPARATION = 0.5;
/**
 * How fast the remembered climb fades (units/s per second). A launch uses the
 * climb the car had at the lip, not the one left a few frames later once the
 * ground has gone level and the smoothed rate has decayed.
 */
const CLIMB_PEAK_DECAY = 55;
/** Once launched, the suspension keeps its hands off for this long. */
const LAUNCH_LOCK_S = 0.18;

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
  /** Last steer / brake inputs, for the wheel and tail-light visuals. */
  steer = 0;
  brake = 0;
  /** Terrain height under the car after the last step (for the drop shadow). */
  groundY = 0;
  /** Pose before the last step; views interpolate between it and the current pose. */
  readonly prevPos = new Vector3();
  readonly prevQuat = new Quaternion();
  /**
   * Seconds of spawn grace left. Cars drop in from above, and that first
   * landing should not cost integrity or flip anyone; set by the spawner.
   */
  graceS = 0;
  /** Absolute lateral slip speed in m/s (side-skid), for tire screech audio and skid visuals. */
  lateralSlip = 0;
  /** Transient impact event from the latest physics step, consumed by audio/VFX. */
  lastImpact: { kind: 'landing' | 'building' | 'vehicle'; speed: number } | null = null;
  private airTime = 0;
  /** Rate the ground under the car is rising, smoothed; the car's own climb. */
  private climbRate = 0;
  /** Ride height last step, for that rate. NaN until the first step or a teleport. */
  private prevTarget = NaN;
  /** Suspension stays off this long after a launch so a crest cannot re-glue the car. */
  private launchLockS = 0;
  /** The climb rate to launch with, held briefly so a lip does not lose it. */
  private climbPeak = 0;

  private readonly _fwd = new Vector3();
  private readonly _right = new Vector3();
  private readonly _up = new Vector3();
  private readonly _q = new Quaternion();
  private readonly _axis = new Vector3();
  private readonly _sphere = new Vector3();
  private readonly _contact: Contact = { nx: 0, ny: 0, nz: 0, push: 0 };

  constructor(
    stats: VehicleStats,
    cfg: VehiclePhysicsConfig = DEFAULT_PHYSICS,
    private readonly rng: Rng = Math.random,
    id?: number
  ) {
    // a mirrored body keeps the host's id so events name the same car everywhere
    this.id = id ?? VehicleBody.nextId++;
    if (id !== undefined) VehicleBody.nextId = Math.max(VehicleBody.nextId, id + 1);
    this.stats = stats;
    this.cfg = cfg;
  }

  /** Forward axis (-Z in body frame) in world space. */
  forward(out = new Vector3()): Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.quat);
  }

  /** Call after teleporting so the next frame doesn't interpolate from the old spot. */
  snapPrev(): void {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
  }

  step(
    dt: number,
    input: VehicleInput,
    ground: Heightfield,
    buildings: readonly BuildingCollider[],
    surfaceProvider?: SurfaceElevationFn | undefined
  ): void {
    this.snapPrev();
    this.lastImpact = null;
    const fwd = this.forward(this._fwd);
    const right = this._right.set(1, 0, 0).applyQuaternion(this.quat);
    const up = this._up.set(0, 1, 0).applyQuaternion(this.quat);
    const gh = this.groundUnder(ground, surfaceProvider);
    if (this.launchLockS > 0) this.launchLockS = Math.max(0, this.launchLockS - dt);
    // Grounded = within the suspension's reach, not mid-launch, not falling
    // hard. Vertical speed is deliberately not part of this: climbing a ramp at
    // speed produces a large upward velocity, and that is the opposite of being
    // in the air.
    // "Falling hard" is measured against the ground the car is following, not
    // against the world. Descending a slope at 20 units/s is not a fall; the
    // car is simply keeping up with the hill.
    // Rising relative to the ground means the wheels have left it, however
    // close it still is. Measured against the ground's own motion: climbing a
    // ramp at 12 units/s is not rising away from anything.
    const rising = this.vel.y - this.climbRate;
    this.onGround = this.launchLockS === 0
      && this.pos.y < gh + this.cfg.groundClearance + GROUND_SNAP
      && (rising < LAUNCH_SEPARATION || this.pos.y <= gh + this.cfg.groundClearance + 0.1)
      && (rising >= -HARD_LANDING_V || this.vel.y >= -HARD_LANDING_V);
    this.airTime = this.onGround ? 0 : this.airTime + dt;

    if (this.onGround) {
      this.groundStep(dt, input, fwd, right, up);
    } else {
      this.airControlStep(dt, input, up);
      // a bounce must not flicker the turn on and off: keep ground steering
      // live for a moment after lift-off
      if (this.airTime < STEER_GRACE_S) this.applySteer(dt, input, up, this.vel.dot(fwd));
    }
    this.jumpHeld = input.jump;
    this.steer = input.steer;
    // a held handbrake flares the tail lights too — it's the rear wheels locking
    this.brake = input.handbrake ? Math.max(input.brake, 0.7) : input.brake;
    if (this.graceS > 0) this.graceS = Math.max(0, this.graceS - dt);

    this.integrateAngular(dt);
    this.integratePosition(dt, ground, surfaceProvider);
    this.resolveBuildings(buildings);
    // integrity heals slowly; a wreck (damage 1) stays a wreck until the game handles it
    if (this.damage < 1) this.damage = Math.max(0, this.damage - 0.02 * dt);
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
    const topSpeed = this.cfg.maxSpeed * stats.maxSpeed;
    const fwdSpeed = this.vel.dot(fwd);
    if (input.brake > 0) {
      if (fwdSpeed > 1) {
        const sp = this.vel.length();
        const dec = this.cfg.brakeForce * dt * input.brake;
        this.vel.setLength(Math.max(0, sp - dec));
      } else if (fwdSpeed > -topSpeed * REVERSE_FRACTION) {
        // stopped: brake becomes reverse, gentler than forward drive
        this.vel.addScaledVector(fwd, -this.cfg.driveForce * stats.accel * 0.6 * input.brake * dt);
      }
    }
    // rolling resistance scaled so full throttle's terminal velocity IS the
    // top-speed stat (a fixed coefficient left three of five types
    // drag-limited well under their stat). Lateral grip: velocity retained
    // per second is 19 % at grip 0.7 (rally slides), 4 % at 0.82 (buggy),
    // 0.1 % at 1.0 and up (planted); a linear exponent made every car planted
    const dragK = (this.cfg.driveForce * stats.accel) / topSpeed;
    this.vel.multiplyScalar(1 - dragK * dt);
    const sideVel = this.vel.dot(right);
    this.lateralSlip = Math.abs(sideVel);
    // handbrake drops lateral grip so the car slides: the grip bleed is the
    // only thing keeping the car on its heading, so skipping it lets momentum
    // carry the tail out. A small residual (0.05×) keeps a held slide from
    // locking into a permanent sideways drift — it still bleeds, just slowly.
    const gripScale = input.handbrake ? 0.05 : 1;
    this.vel.addScaledVector(right, -sideVel * gripScale * (1 - Math.pow(0.001, dt * stats.grip ** 4)));
    if (this.vel.length() > topSpeed) this.vel.setLength(topSpeed);
    this.applySteer(dt, input, up, fwdSpeed);
    if (input.jump && !this.jumpHeld) {
      this.vel.y += this.cfg.jumpBoost * 14;
      this.onGround = false;
      // without the lock the next frame finds the car still inside the
      // suspension band and snaps the jump straight back out of it
      this.launchLockS = LAUNCH_LOCK_S;
    }
  }

  /**
   * Ground height under the car: the mean of the four wheel contact points.
   * Bumps shorter than the wheelbase average out the way suspension would;
   * sampling the center alone had the car (and the camera on it) bobbing at
   * ~6 Hz over the terrain's finest noise.
   */
  private groundUnder(
    ground: Heightfield,
    surfaceProvider?: SurfaceElevationFn | undefined
  ): number {
    const { x, z } = this.pos;
    const f = this._fwd, r = this._right;
    const xF = x + f.x * 1.3, zF = z + f.z * 1.3;
    const xB = x - f.x * 1.3, zB = z - f.z * 1.3;
    const xR = x + r.x * 0.95, zR = z + r.z * 0.95;
    const xL = x - r.x * 0.95, zL = z - r.z * 0.95;

    const gF = ground.sample(xF, zF);
    const gB = ground.sample(xB, zB);
    const gR = ground.sample(xR, zR);
    const gL = ground.sample(xL, zL);

    if (surfaceProvider) {
      const cy = this.pos.y;
      const sF = surfaceProvider(xF, zF, cy, gF) ?? gF;
      const sB = surfaceProvider(xB, zB, cy, gB) ?? gB;
      const sR = surfaceProvider(xR, zR, cy, gR) ?? gR;
      const sL = surfaceProvider(xL, zL, cy, gL) ?? gL;
      return 0.25 * (sF + sB + sR + sL);
    }
    return 0.25 * (gF + gB + gR + gL);
  }

  /** Direct yaw about the body's up axis, scaled down at crawling speeds. */
  private applySteer(dt: number, input: VehicleInput, up: Vector3, fwdSpeed: number): void {
    const speedFactor = Math.min(1, this.vel.length() / 8);
    // backing up, the rear should swing the way you steer, so the nose goes the other way
    const steerDir = fwdSpeed < -0.5 ? -1 : 1;
    this._q.setFromAxisAngle(
      up, steerDir * input.steer * this.cfg.turnRate * this.stats.steer * dt * speedFactor
    );
    this.quat.multiply(this._q);
  }

  private airControlStep(dt: number, input: VehicleInput, up: Vector3): void {
    this.lateralSlip = 0;
    // Air control adds yaw from steer and pitch from input; angular velocity
    // is damped and capped so a spin settles instead of growing — unbounded
    // steer-roll accumulation was a direct path to landing roof-down.
    // Yaw sign matches ground steering (+steer = left = +Y): the ground check
    // flickers over bumps at speed, so an opposite-signed air yaw reads as the
    // car jerking the wrong way mid-turn
    this.angVel.y += input.steer * this.cfg.airControl * 0.5 * dt;
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
    const ang = Math.acos(tilt);
    if (ang < 1e-4) return;
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
    const rate = MathUtils.lerp(
      this.cfg.rollRecover, this.cfg.rollRecover * 2.4, 1 - (tilt + 1) / 2
    );
    this._q.setFromAxisAngle(axis, Math.min(ang, rate * dt));
    this.quat.premultiply(this._q);
  }

  private integratePosition(
    dt: number,
    ground: Heightfield,
    surfaceProvider?: SurfaceElevationFn | undefined
  ): void {
    this.pos.addScaledVector(this.vel, dt);
    // resample under the new position: at speed the ground moves a lot in a step
    const gh = this.groundUnder(ground, surfaceProvider);
    this.groundY = gh;
    const target = gh + this.cfg.groundClearance;

    // How fast the ground under the car is rising or falling, which for a car
    // following it IS the car's vertical speed. Tracked even while airborne so
    // a landing does not inherit a stale rate.
    const rawClimb = Number.isFinite(this.prevTarget) ? (target - this.prevTarget) / dt : 0;
    this.prevTarget = target;
    // Following a surface, the vertical component can never exceed the speed
    // along it, so a respawn across the map — which moves the ground under the
    // car instantly while it is barely moving — cannot read as a ramp.
    const reach = Math.min(MAX_CLIMB, Math.hypot(this.vel.x, this.vel.z));
    const follow = 1 - Math.exp(-dt * CLIMB_SMOOTH);
    this.climbRate += (MathUtils.clamp(rawClimb, -reach, reach) - this.climbRate) * follow;
    this.climbPeak = Math.max(this.climbRate, this.climbPeak - CLIMB_PEAK_DECAY * dt);

    // A car that was climbing and is now outrunning the ground has crested:
    // the slope levelled off under it and its momentum carries on upward. That
    // is the whole of a ramp jump, no button involved. The climb requirement is
    // what separates a real crest from the first frames of any descent, where
    // the tracked rate is still catching up with a slope the car is merely
    // driving down.
    if (this.onGround && this.climbPeak > LAUNCH_MIN_CLIMB
        && this.vel.y > this.climbRate + LAUNCH_SEPARATION) {
      this.onGround = false;
      this.launchLockS = LAUNCH_LOCK_S;
      this.vel.y = Math.max(this.vel.y, this.climbPeak);
    }
    const closing = this.vel.y - this.climbRate;
    const isFallingHard = this.vel.y < -HARD_LANDING_V && closing < -HARD_LANDING_V;
    if (isFallingHard && this.pos.y < target && (!this.onGround || this.airTime > 0.05)) {
      // hard landing: how fast the car met the ground, not how fast it fell
      this.pos.y = target;
      const impact = -closing;
      if (this.graceS > 0) {
        // the drop-in at spawn: settle, no damage, no tumble
        this.vel.y = 0;
        return this.keepInBounds();
      }
      this.lastImpact = { kind: 'landing', speed: impact };
      const excess = Math.max(0, impact - SAFE_LANDING_V);
      this.damage = Math.min(1, this.damage + excess * 0.004 / this.stats.durability);
      this.vel.y = impact * 0.18;
      // tumble on very hard landings — biased to pitch (forward flip)
      if (impact > TUMBLE_V) {
        const dir = this.rng() < 0.5 ? 1 : -1;
        this.angVel.x += dir * Math.min(impact, 30) * 0.04;
        this.angVel.z += (this.rng() - 0.5) * Math.min(impact, 30) * 0.015;
      }
    } else if (this.onGround && this.pos.y < target + GROUND_SNAP) {
      // grounded: suspension eases the body toward the ride height so bumps
      // and grid kinks don't jolt it. On uphill climbs, firm upward response
      // prevents chassis sag into the slope.
      const rate = this.pos.y < target ? RIDE_RATE * 2.5 : RIDE_RATE;
      this.pos.y += (target - this.pos.y) * (1 - Math.exp(-dt * rate));
      this.pos.y = MathUtils.clamp(this.pos.y, target - 0.25, target + RIDE_TRAVEL);
      // the car's vertical speed follows the climb rate of the slope
      this.vel.y = this.climbRate;
    } else if (this.pos.y <= target && (this.vel.y <= 0.5 || this.onGround)) {
      // Soft touchdown for airborne vehicles: touch down on surface without sinking underground
      this.pos.y = target;
      this.vel.y = Math.max(this.vel.y, this.climbRate);
      if (this.launchLockS === 0) {
        this.onGround = true;
        this.airTime = 0;
      }
    }
    this.keepInBounds();
  }

  /** World bounds — bounce back. */
  private keepInBounds(): void {
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

  /**
   * Each sphere of the body's collider against every box nearby. A contact
   * moves the whole body (and the sphere with it, so the next box sees where
   * it really is) and reflects the normal velocity with a little extra kick.
   */
  private resolveBuildings(buildings: readonly BuildingCollider[]): void {
    const hit = this._contact;
    for (const s of this.stats.collider.spheres) {
      const c = this._sphere.set(s.x, s.y, s.z).applyQuaternion(this.quat).add(this.pos);
      for (const b of buildings) {
        // If the obstacle does not rise above the driving surface under the vehicle,
        // it is the roadway/deck beneath the wheels, not a wall blocking travel.
        if (b.max.y <= this.groundY + 0.5) continue;
        if (!sphereVsAabb(c.x, c.y, c.z, s.r, b.min, b.max, hit)) continue;
        const push = hit.push + 0.05;
        this.pos.x += hit.nx * push;
        this.pos.y += hit.ny * push;
        this.pos.z += hit.nz * push;
        c.x += hit.nx * push;
        c.y += hit.ny * push;
        c.z += hit.nz * push;
        const vn = this.vel.x * hit.nx + this.vel.y * hit.ny + this.vel.z * hit.nz;
        if (vn >= 0) continue;
        this.vel.x -= 1.3 * vn * hit.nx;
        this.vel.y -= 1.3 * vn * hit.ny;
        this.vel.z -= 1.3 * vn * hit.nz;
        const impact = -vn;
        if (impact > 2.5) {
          this.lastImpact = { kind: 'building', speed: impact };
        }
        if (impact > 6) {
          this.damage = Math.min(1, this.damage + impact * 0.01 / this.stats.durability);
          this.angVel.y += (this.rng() - 0.5) * impact * 0.04;
        }
      }
    }
  }

}
