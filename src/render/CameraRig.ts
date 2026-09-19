/**
 * Camera rig: chase / far-chase / hood modes with zoom. Pulls the camera
 * back for tactical view and couples zoom to FOV so the wide view reads
 * naturally.
 */
import { Vector3, PerspectiveCamera } from 'three';
import type { Heightfield } from '../core/heightfield.ts';
import type { Pose } from './VehicleView.ts';

type CameraMode = 0 | 1 | 2;

/** The chase camera never comes closer than this fraction of its full distance... */
const MIN_CHASE_FRAC = 0.3;
/** ...and looks down from this high when even that is inside a building. */
const CLIMB_ABOVE = 12;
/** High oblique establishing shot height above spawn ground. */
const INTRO_START_HEIGHT = 80;
/** Horizontal distance for establishing shot. */
const INTRO_START_RADIUS = 85;
/** Mid-flight panoramic height (low/horizontal). */
const INTRO_MID_HEIGHT = 22;
/** Mid-flight panoramic radius. */
const INTRO_MID_RADIUS = 55;
/** Late sweep height before entering chase pocket. */
const INTRO_LATE_HEIGHT = 14;
/** Late sweep radius. */
const INTRO_LATE_RADIUS = 32;
/** Orbit swing around the vehicle (starts front-quarter, sweeps around to rear). */
const INTRO_SWING = Math.PI * 0.85;

const smoothstep = (t: number): number => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

function introAltitude(p: number, chaseH: number): number {
  if (p <= 0.35) {
    const s = smoothstep(p / 0.35);
    return INTRO_START_HEIGHT * (1 - s) + INTRO_MID_HEIGHT * s;
  }
  if (p <= 0.75) {
    const s = smoothstep((p - 0.35) / 0.40);
    return INTRO_MID_HEIGHT * (1 - s) + INTRO_LATE_HEIGHT * s;
  }
  const s = smoothstep((p - 0.75) / 0.25);
  return INTRO_LATE_HEIGHT * (1 - s) + chaseH * s;
}

function introRadius(p: number, chaseR: number): number {
  if (p <= 0.35) {
    const s = smoothstep(p / 0.35);
    return INTRO_START_RADIUS * (1 - s) + INTRO_MID_RADIUS * s;
  }
  if (p <= 0.75) {
    const s = smoothstep((p - 0.35) / 0.40);
    return INTRO_MID_RADIUS * (1 - s) + INTRO_LATE_RADIUS * s;
  }
  const s = smoothstep((p - 0.75) / 0.25);
  return INTRO_LATE_RADIUS * (1 - s) + chaseR * s;
}

export class CameraRig {
  mode: CameraMode = 0;
  zoom = 1;

  private readonly _back = new Vector3();
  private readonly _right = new Vector3();
  private readonly _desired = new Vector3();
  private readonly _look = new Vector3();
  private lookY: number | null = null;

  private introLeft = 0;
  private introTotal = 0;
  /** Where the chase logic thinks the camera is while the intro overrides the real position. */
  private readonly _chase = new Vector3();
  private readonly _introLook = new Vector3();

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly ground: () => Heightfield,
    /** Clear fraction of a segment through the buildings; see Game.lineOfSight. */
    private readonly lineOfSight: (from: Vector3, to: Vector3) => number = () => 1
  ) {}

  cycleMode(): void {
    this.mode = ((this.mode + 1) % 3) as CameraMode;
  }

  setZoom(z: number): void {
    this.zoom = z;
    // widen FOV slightly when zoomed out so the wider view feels natural
    this.camera.fov = 62 + (z - 1) * 2.4;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Match start: hold an overhead map view of the spawn, then swing down
   * behind the car over `seconds` (the countdown), arriving as the banner
   * says GO. The car drops from the sky meanwhile, so it falls away from the
   * fixed overhead before the camera follows it down.
   */
  intro(seconds: number, player: Pose | null): void {
    this.snap(player);
    if (!player || seconds <= 0) return;
    this._chase.copy(this.camera.position);
    this.introLeft = this.introTotal = seconds;
  }

  get introActive(): boolean {
    return this.introLeft > 0;
  }

  /** Immediately cancel the intro sweep and snap camera behind player. */
  skipIntro(player?: Pose | null): void {
    this.introLeft = 0;
    if (player) this.snap(player);
  }

  /** Snap immediately to the desired pose without lerping from an old spot. */
  snap(player: Pose | null): void {
    if (!player) return;
    const z = this.zoom;
    if (this.mode === 0) {
      this._back.set(0, 0, 14 * z).applyQuaternion(player.quat);
      this._desired.copy(player.pos).add(new Vector3(0, 6 * z, 0)).add(this._back);
      this._desired.y = Math.max(
        this._desired.y, this.ground().sample(this._desired.x, this._desired.z) + 4
      );
    } else if (this.mode === 1) {
      this._back.set(0, 0, 24 * z).applyQuaternion(player.quat);
      this._desired.copy(player.pos).add(new Vector3(0, 10 * z, 0)).add(this._back);
    } else {
      const fwd = this._back.set(0, 0, -1).applyQuaternion(player.quat);
      this.camera.position.copy(player.pos).addScaledVector(fwd, 1.2);
      this.camera.position.y += 1.9;
      this._look.copy(player.pos).addScaledVector(fwd, 30);
      this._look.y += 1.5;
      this.camera.lookAt(this._look);
      this.lookY = null;
      return;
    }
    this._look.copy(player.pos).add(new Vector3(0, 2, 0));
    const clear = this.lineOfSight(this._look, this._desired);
    if (clear < 1) {
      const frac = Math.max(clear, MIN_CHASE_FRAC);
      this._desired.sub(this._look).multiplyScalar(frac).add(this._look);
      if (clear < MIN_CHASE_FRAC) this._desired.y = this._look.y + CLIMB_ABOVE;
    }
    this.camera.position.copy(this._desired);
    this.lookY = this._look.y;
    this.camera.lookAt(this._look);
  }

  /** Follows the player's rendered (interpolated) pose, not the raw body. */
  update(dt: number, player: Pose | null): void {
    if (!player) return;
    if (this.introLeft <= 0) {
      this.follow(dt, player);
      return;
    }
    // the chase lerp runs on its own position; the intro overrides it
    this.camera.position.copy(this._chase);
    this.follow(dt, player);
    this._chase.copy(this.camera.position);
    this.introLeft -= dt;
    const p = Math.min(1, Math.max(0, 1 - this.introLeft / this.introTotal));

    const z = this.zoom;
    const chaseR = 14 * z;
    const chaseH = 6 * z;

    const alt = introAltitude(p, chaseH);
    const rad = introRadius(p, chaseR);
    const swing = (1 - smoothstep(p)) * INTRO_SWING;

    this._back.set(0, 0, 1).applyQuaternion(player.quat);
    this._right.set(1, 0, 0).applyQuaternion(player.quat);

    const groundY = this.ground().sample(player.pos.x, player.pos.z);
    // Anchor altitude to terrain ground level, smoothly blending to vehicle Y as we arrive in the chase pocket
    const blendToVehicle = p <= 0.75 ? 0 : smoothstep((p - 0.75) / 0.25);
    const baseGroundY = groundY * (1 - blendToVehicle) + player.pos.y * blendToVehicle;

    // Horizontal offset around the car
    const cs = Math.cos(swing);
    const sn = Math.sin(swing);
    const offsetX = (this._back.x * cs + this._right.x * sn) * rad;
    const offsetZ = (this._back.z * cs + this._right.z * sn) * rad;

    this.camera.position.set(
      player.pos.x + offsetX,
      baseGroundY + alt,
      player.pos.z + offsetZ
    );

    // Look target: slightly above player ground to frame the horizon/skyline during sweep
    const lookTargetY = (groundY + 3.5) * (1 - blendToVehicle) + (player.pos.y + 2) * blendToVehicle;
    this._introLook.set(player.pos.x, lookTargetY, player.pos.z);

    // Collision check: prevent camera from cutting into buildings during fly-in
    const clear = this.lineOfSight(this._introLook, this.camera.position);
    if (clear < 1) {
      const frac = Math.max(clear, MIN_CHASE_FRAC);
      this.camera.position.sub(this._introLook).multiplyScalar(frac).add(this._introLook);
      if (clear < MIN_CHASE_FRAC) {
        this.camera.position.y = Math.max(this.camera.position.y, this._introLook.y + CLIMB_ABOVE);
      }
    }
    // Prevent clipping into steep terrain/dunes
    const terrainFloor = this.ground().sample(this.camera.position.x, this.camera.position.z) + 3;
    if (this.camera.position.y < terrainFloor) {
      this.camera.position.y = terrainFloor;
    }

    this.camera.lookAt(this._introLook);
  }

  private follow(dt: number, player: Pose): void {
    const z = this.zoom;
    if (this.mode === 0) {
      this._back.set(0, 0, 14 * z).applyQuaternion(player.quat);
      this._desired.copy(player.pos).add(new Vector3(0, 6 * z, 0)).add(this._back);
      this._desired.y = Math.max(
        this._desired.y, this.ground().sample(this._desired.x, this._desired.z) + 4
      );
    } else if (this.mode === 1) {
      this._back.set(0, 0, 24 * z).applyQuaternion(player.quat);
      this._desired.copy(player.pos).add(new Vector3(0, 10 * z, 0)).add(this._back);
    } else {
      // hood: rigidly on the bonnet, looking down the road (the prototype's
      // version sat ahead of the car looking back at its own grille)
      const fwd = this._back.set(0, 0, -1).applyQuaternion(player.quat);
      this.camera.position.copy(player.pos).addScaledVector(fwd, 1.2);
      this.camera.position.y += 1.9;
      this._look.copy(player.pos).addScaledVector(fwd, 30);
      this._look.y += 1.5;
      this.camera.lookAt(this._look);
      this.lookY = null;
      return;
    }
    this._look.copy(player.pos).add(new Vector3(0, 2, 0));
    // a chase camera 14 units back is inside the block behind the car in
    // any downtown: pull it in along the line to the car until the view is
    // clear, and if even close in is blocked, climb instead
    const clear = this.lineOfSight(this._look, this._desired);
    if (clear < 1) {
      const frac = Math.max(clear, MIN_CHASE_FRAC);
      this._desired.sub(this._look).multiplyScalar(frac).add(this._look);
      if (clear < MIN_CHASE_FRAC) this._desired.y = this._look.y + CLIMB_ABOVE;
    }
    // tighter lerp at high zoom so the wider view stays settled
    const lerpK = 1 - Math.pow(0.001 / (1 + z * 0.15), dt);
    this.camera.position.lerp(this._desired, lerpK);
    // track the car tightly in the plane but low-pass its height (~0.12 s):
    // every terrain bump the car rides would otherwise shake the whole view
    this.lookY = this.lookY === null ? this._look.y : this.lookY + (this._look.y - this.lookY) * (1 - Math.exp(-dt * 8));
    this._look.y = this.lookY;
    this.camera.lookAt(this._look);
  }
}
