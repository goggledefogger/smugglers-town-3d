/**
 * Vehicle mesh + binding to a physics body. One view per actor; the view
 * reads body state each frame and writes it to the mesh (never the reverse).
 *
 * `group` carries only the world position; the car body rotates inside it so
 * the health bar and the blob shadow stay upright. The physics body stays
 * level on slopes, so the view adds a cosmetic pitch/roll from the terrain
 * under the wheels to make hills read as hills.
 */
import {
  Group, Mesh, CircleGeometry, MeshBasicMaterial, Sprite, SpriteMaterial, CanvasTexture, MathUtils,
  Quaternion, Euler, Vector3, type Material
} from 'three';
import type { VehicleActor } from '../app/Game.ts';
import type { Heightfield } from '../core/heightfield.ts';
import { buildVehicle, type VehicleMesh } from './vehicleMeshes.ts';

export const TEAM_COLORS = [0x44ff66, 0xff5544] as const;
const WHEELBASE = 2.6;
const TRACK = 1.9;
const MAX_TILT = 0.6;

/** A rendered (interpolated) pose; what the camera and pickups follow. */
export interface Pose {
  readonly pos: Vector3;
  readonly quat: Quaternion;
}

export class VehicleView {
  readonly group = new Group();
  /** Interpolated pose this frame. */
  readonly pose: Pose = { pos: this.group.position, quat: new Quaternion() };
  private readonly carRoot = new Group();
  private readonly car: VehicleMesh;
  private readonly healthBar: Sprite;
  private readonly barCanvas: HTMLCanvasElement;
  private readonly barTexture: CanvasTexture;
  private readonly shadow: Mesh<CircleGeometry, MeshBasicMaterial>;
  private readonly team: number;
  private lastDamage = -1;
  private pitch = 0;
  private roll = 0;
  private readonly _tilt = new Quaternion();
  private readonly _euler = new Euler();
  private readonly _fwd = new Vector3();
  private readonly _right = new Vector3();

  constructor(
    readonly actor: VehicleActor,
    private readonly ground: () => Heightfield
  ) {
    this.car = buildVehicle(actor.body.stats, actor.team === 0 ? TEAM_COLORS[0] : TEAM_COLORS[1]);
    this.carRoot.add(this.car.root);
    this.group.add(this.carRoot);

    // blob shadow on the ground under the car: invisible while planted, fades
    // in with height so a gap between car and shadow reads as "airborne"
    this.shadow = new Mesh(
      new CircleGeometry(2.4, 20),
      new MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4
      })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.group.add(this.shadow);

    // health bar sprite above the vehicle
    this.barCanvas = document.createElement('canvas');
    this.barCanvas.width = 64;
    this.barCanvas.height = 8;
    this.barTexture = new CanvasTexture(this.barCanvas);
    this.healthBar = new Sprite(new SpriteMaterial({
      map: this.barTexture, depthTest: false, transparent: true
    }));
    this.healthBar.scale.set(4, 0.5, 1);
    this.healthBar.position.set(0, 3.4, 0);
    // not on your own car: the HUD's integrity meter already says this, and the
    // chase camera puts the bar dead centre of everything you are trying to see
    this.healthBar.visible = !actor.isPlayer;
    this.group.add(this.healthBar);
    this.team = actor.team;
    this.sync(1 / 60, 1);
  }

  /** The showroom has no integrity to show. */
  setHealthBarVisible(v: boolean): void {
    this.healthBar.visible = v;
  }

  /** Re-uploads the bar texture only when integrity actually changed. */
  private updateHealthBar(): void {
    const damage = this.actor.body.damage;
    if (damage === this.lastDamage) return;
    this.lastDamage = damage;
    const ctx = this.barCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, 64, 8);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 64, 8);
    const frac = 1 - this.actor.body.damage;
    ctx.fillStyle = this.team === 0 ? '#3f3' : '#f33';
    ctx.fillRect(1, 1, 62 * Math.max(0, frac), 6);
    this.barTexture.needsUpdate = true;
  }

  /** alpha: fraction of a sim step since the last one (see Game.alpha). */
  sync(dt: number, alpha: number): void {
    const body = this.actor.body;
    const quat = this.pose.quat;
    this.group.position.copy(body.prevPos).lerp(body.pos, alpha);
    quat.copy(body.prevQuat).slerp(body.quat, alpha);
    const height = Math.max(0, this.group.position.y - body.groundY - body.cfg.groundClearance);

    // terrain tilt from the wheel contact points, faded out as the car lifts
    // off and smoothed over ~0.1 s so bumps don't rattle the body
    const hf = this.ground();
    const { x, z } = this.group.position;
    const f = this._fwd.set(0, 0, -1).applyQuaternion(quat);
    const r = this._right.set(1, 0, 0).applyQuaternion(quat);
    const xF = x + f.x * WHEELBASE / 2, zF = z + f.z * WHEELBASE / 2;
    const xB = x - f.x * WHEELBASE / 2, zB = z - f.z * WHEELBASE / 2;
    const xR = x + r.x * TRACK / 2, zR = z + r.z * TRACK / 2;
    const xL = x - r.x * TRACK / 2, zL = z - r.z * TRACK / 2;

    const hF = hf.sample(xF, zF);
    const hB = hf.sample(xB, zB);
    const hR = hf.sample(xR, zR);
    const hL = hf.sample(xL, zL);

    const grounded = MathUtils.clamp(1 - height / 2, 0, 1);
    const k = 1 - Math.exp(-dt * 10);
    this.pitch += (MathUtils.clamp(Math.atan2(hF - hB, WHEELBASE), -MAX_TILT, MAX_TILT) * grounded - this.pitch) * k;
    this.roll += (MathUtils.clamp(Math.atan2(hR - hL, TRACK), -MAX_TILT, MAX_TILT) * grounded - this.roll) * k;
    this._tilt.setFromEuler(this._euler.set(this.pitch, 0, this.roll));
    this.carRoot.quaternion.copy(quat).multiply(this._tilt);

    // wheels roll with forward speed (a spin group's local Y is the axle
    // after its 90° tilt) and the front pair steer with the input
    const fwdSpeed = body.vel.dot(f);
    for (const w of this.car.wheels) w.spin.rotateY((fwdSpeed * dt) / w.r);
    for (const p of this.car.frontPivots) p.rotation.y = body.steer * 0.45;
    this.car.tail.emissiveIntensity = body.brake > 0 ? 3 : 0.6;

    this.shadow.position.y = body.groundY - this.group.position.y + 0.15;
    this.shadow.material.opacity = MathUtils.clamp(height * 0.15, 0, 0.45);
    const s = MathUtils.clamp(1 - height * 0.02, 0.5, 1);
    this.shadow.scale.set(s, s, 1);
    this.updateHealthBar();
  }

  dispose(): void {
    this.group.traverse(obj => {
      if (obj instanceof Mesh) {
        obj.geometry.dispose();
        // body boxes and tires carry per-face material arrays; textures are shared and stay
        const mats = obj.material as Material | Material[];
        for (const m of Array.isArray(mats) ? mats : [mats]) m.dispose();
      }
    });
    this.barTexture.dispose();
  }
}
