/**
 * Camera rig: chase / far-chase / hood modes with zoom. Pulls the camera
 * back for tactical view and couples zoom to FOV so the wide view reads
 * naturally.
 */
import { Vector3, PerspectiveCamera } from 'three';
import type { VehicleBody } from '../core/physics/VehicleBody.ts';
import type { Heightfield } from '../core/heightfield.ts';

export type CameraMode = 0 | 1 | 2;

export class CameraRig {
  mode: CameraMode = 0;
  zoom = 1;

  private readonly _back = new Vector3();
  private readonly _desired = new Vector3();
  private readonly _look = new Vector3();

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly ground: () => Heightfield
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

  update(dt: number, player: VehicleBody | null): void {
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
      const fwd = new Vector3(0, 0, -6).applyQuaternion(player.quat);
      this._desired.copy(player.pos).add(new Vector3(0, 2.5, 0)).add(fwd);
    }
    // tighter lerp at high zoom so the wider view stays settled
    const lerpK = 1 - Math.pow(0.001 / (1 + z * 0.15), dt);
    this.camera.position.lerp(this._desired, lerpK);
    this._look.copy(player.pos).add(new Vector3(0, 2, 0));
    this.camera.lookAt(this._look);
  }
}
