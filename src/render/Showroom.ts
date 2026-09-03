/**
 * Garage preview: the selected vehicle turning slowly at the field center
 * with the camera orbiting it, framed to the right so the garage panel on
 * the left doesn't cover it. Lives in the real scene, so the desert (or the
 * relocated city) is the backdrop.
 */
import { Vector3, type Scene, type PerspectiveCamera } from 'three';
import { VehicleBody } from '../core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../core/physics/vehicleStats.ts';
import type { Heightfield } from '../core/heightfield.ts';
import { VehicleView } from './VehicleView.ts';

const UP = new Vector3(0, 1, 0);

export class Showroom {
  private view: VehicleView | null = null;
  private body: VehicleBody | null = null;
  private angle = 0;

  constructor(
    private readonly scene: Scene,
    private readonly camera: PerspectiveCamera,
    private readonly ground: () => Heightfield
  ) {}

  setType(idx: number): void {
    this.clear();
    const stats = VEHICLE_TYPES[idx];
    if (!stats) return;
    const body = new VehicleBody(stats);
    const gh = this.ground().sample(0, 0);
    body.pos.set(0, gh + body.cfg.groundClearance, 0);
    body.groundY = gh;
    body.snapPrev();
    this.body = body;
    this.view = new VehicleView({ body, team: 0, isPlayer: true, label: 'YOU', control: 'local', brain: null }, this.ground);
    this.view.setHealthBarVisible(false);
    this.scene.add(this.view.group);
  }

  /** Call every frame while the garage is up; w/h are the viewport size. */
  update(dt: number, w: number, h: number): void {
    if (!this.body || !this.view) return;
    this.angle += dt * 0.5;
    this.body.quat.setFromAxisAngle(UP, this.angle);
    this.body.snapPrev();
    this.view.sync(dt, 1);
    const camAng = this.angle * 0.35 + 0.6;
    const y = this.body.pos.y;
    this.camera.position.set(Math.sin(camAng) * 8.5, y + 2.8, Math.cos(camAng) * 8.5);
    this.camera.lookAt(0, y + 0.8, 0);
    // shift the frustum so the car sits right of center, clear of the panel
    this.camera.setViewOffset(w, h, -w * 0.22, 0, w, h);
  }

  dispose(): void {
    this.clear();
    this.camera.clearViewOffset();
  }

  private clear(): void {
    if (!this.view) return;
    this.scene.remove(this.view.group);
    this.view.dispose();
    this.view = null;
    this.body = null;
  }
}
