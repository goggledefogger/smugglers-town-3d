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

export class CameraRig {
  mode: CameraMode = 0;
  zoom = 1;

  private readonly _back = new Vector3();
  private readonly _desired = new Vector3();
  private readonly _look = new Vector3();
  private lookY: number | null = null;

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
