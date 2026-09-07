/**
 * Camera rig: chase / far-chase / hood modes with zoom. Pulls the camera
 * back for tactical view and couples zoom to FOV so the wide view reads
 * naturally.
 */
import { Vector3, PerspectiveCamera } from 'three';
import type { Heightfield } from '../core/heightfield.ts';
import type { Pose } from './VehicleView.ts';

export type CameraMode = 0 | 1 | 2;

/** The chase camera never comes closer than this fraction of its full distance... */
const MIN_CHASE_FRAC = 0.3;
/** ...and looks down from this high when even that is inside a building. */
const CLIMB_ABOVE = 12;
/** The opening shot hangs this far above the spawn's ground, straight down, so the town reads as a map. */
const INTRO_HEIGHT = 150;
/** Fraction of the intro spent holding the overhead before the swoop starts. */
const INTRO_HOLD = 0.2;
/** How far around the car the camera swings on the way down (half a turn). */
const INTRO_SWING = Math.PI;

const smoothstep = (t: number): number => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

export class CameraRig {
  mode: CameraMode = 0;
  zoom = 1;

  private readonly _back = new Vector3();
  private readonly _desired = new Vector3();
  private readonly _look = new Vector3();
  private lookY: number | null = null;

  private introLeft = 0;
  private introTotal = 0;
  /** Where the chase logic thinks the camera is while the intro overrides the real position. */
  private readonly _chase = new Vector3();
  private readonly _overhead = new Vector3();
  private readonly _fwd = new Vector3();
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
    // the chase lerp runs on its own position; the intro blends from the overhead towards it
    this.camera.position.copy(this._chase);
    this.follow(dt, player);
    this._chase.copy(this.camera.position);
    this.introLeft -= dt;
    const t = 1 - Math.max(0, this.introLeft) / this.introTotal;
    const e = smoothstep((t - INTRO_HOLD) / (1 - INTRO_HOLD));
    this._fwd.set(0, 0, -1).applyQuaternion(player.quat);
    // a hair behind the car so lookAt has an up vector: the car points up the screen
    this._overhead.set(player.pos.x, this.ground().sample(player.pos.x, player.pos.z) + INTRO_HEIGHT, player.pos.z)
      .addScaledVector(this._fwd, -2);
    // swing the chase offset around the car as it settles, so the descent orbits instead of dropping straight
    const swing = (1 - e) * INTRO_SWING;
    this.camera.position.sub(player.pos);
    const cs = Math.cos(swing), sn = Math.sin(swing);
    const rx = this.camera.position.x * cs - this.camera.position.z * sn;
    const rz = this.camera.position.x * sn + this.camera.position.z * cs;
    this.camera.position.set(rx, this.camera.position.y, rz).add(player.pos);
    this.camera.position.lerp(this._overhead, 1 - e);
    this._introLook.copy(player.pos).lerp(this._look, e);
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
