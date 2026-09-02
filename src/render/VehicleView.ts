/**
 * Vehicle mesh + binding to a physics body. One view per actor; the view
 * reads body state each frame and writes it to the mesh (never the reverse).
 *
 * `group` carries only the world position; the car body rotates inside it so
 * the health bar and the blob shadow stay upright when the car rolls. The
 * physics body stays level on slopes, so the view adds a cosmetic pitch/roll
 * from the terrain under the wheels to make hills read as hills.
 */
import {
  Group, Mesh, BoxGeometry, CylinderGeometry, CircleGeometry, MeshLambertMaterial,
  MeshStandardMaterial, MeshBasicMaterial, Sprite, SpriteMaterial, CanvasTexture, MathUtils,
  Quaternion, Euler, Vector3
} from 'three';
import type { VehicleActor } from '../app/Game.ts';
import type { Heightfield } from '../core/heightfield.ts';

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
  private readonly healthBar: Sprite;
  private readonly barCanvas: HTMLCanvasElement;
  private readonly barTexture: CanvasTexture;
  private readonly shadow: Mesh<CircleGeometry, MeshBasicMaterial>;
  private readonly team: number;
  private readonly wheels: Mesh[] = [];
  private readonly frontPivots: Group[] = [];
  private readonly wheelR: number;
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
    const teamColor = actor.team === 0 ? TEAM_COLORS[0] : TEAM_COLORS[1];
    const stats = actor.body.stats;
    // heavier types ride on bigger wheels; the roll bar carries the type's accent color
    this.wheelR = MathUtils.clamp(0.45 + 0.28 * (stats.mass - 0.9), 0.4, 0.8);
    const wheelR = this.wheelR;
    const g = new Group();
    // body
    const bodyMesh = new Mesh(
      new BoxGeometry(2.2, 1, 4),
      new MeshStandardMaterial({ color: teamColor, roughness: 0.6, metalness: 0.3 })
    );
    bodyMesh.position.y = wheelR + 0.4;
    g.add(bodyMesh);
    // cabin
    const cab = new Mesh(
      new BoxGeometry(1.8, 0.7, 2),
      new MeshLambertMaterial({ color: 0x222831 })
    );
    cab.position.set(0, wheelR + 1.0, -0.2);
    g.add(cab);
    // wheels: each in a pivot so the front pair can steer; the mesh spins on its axle
    const wheelGeo = new CylinderGeometry(wheelR, wheelR, 0.5, 12);
    const wheelMat = new MeshLambertMaterial({ color: 0x111111 });
    for (const [x, z] of [[0.95, 1.3], [-0.95, 1.3], [0.95, -1.3], [-0.95, -1.3]] as const) {
      const pivot = new Group();
      pivot.position.set(x, wheelR, z);
      const w = new Mesh(wheelGeo, wheelMat);
      w.rotation.z = Math.PI / 2;
      pivot.add(w);
      g.add(pivot);
      this.wheels.push(w);
      if (z < 0) this.frontPivots.push(pivot); // forward is -z
    }
    // roll bar
    const bar = new Mesh(
      new BoxGeometry(2.4, 0.2, 0.2),
      new MeshLambertMaterial({ color: stats.color })
    );
    bar.position.set(0, wheelR + 0.7, 2);
    g.add(bar);
    this.carRoot.add(g);
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
    this.healthBar.position.set(0, 3.2, 0);
    this.group.add(this.healthBar);
    this.team = actor.team;
    this.updateHealthBar();
    this.sync(1 / 60, 1);
  }

  private updateHealthBar(): void {
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
    const hF = hf.sample(x + f.x * WHEELBASE / 2, z + f.z * WHEELBASE / 2);
    const hB = hf.sample(x - f.x * WHEELBASE / 2, z - f.z * WHEELBASE / 2);
    const hR = hf.sample(x + r.x * TRACK / 2, z + r.z * TRACK / 2);
    const hL = hf.sample(x - r.x * TRACK / 2, z - r.z * TRACK / 2);
    const grounded = MathUtils.clamp(1 - height / 2, 0, 1);
    const k = 1 - Math.exp(-dt * 10);
    this.pitch += (MathUtils.clamp(Math.atan2(hF - hB, WHEELBASE), -MAX_TILT, MAX_TILT) * grounded - this.pitch) * k;
    this.roll += (MathUtils.clamp(Math.atan2(hR - hL, TRACK), -MAX_TILT, MAX_TILT) * grounded - this.roll) * k;
    this._tilt.setFromEuler(this._euler.set(this.pitch, 0, this.roll));
    this.carRoot.quaternion.copy(quat).multiply(this._tilt);

    // wheels roll with forward speed (the mesh's local Y is the axle after
    // its 90° tilt) and the front pair steer with the input
    const spin = (body.vel.dot(f) * dt) / this.wheelR;
    for (const w of this.wheels) w.rotateY(spin);
    for (const p of this.frontPivots) p.rotation.y = body.steer * 0.45;

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
        (obj.material as MeshLambertMaterial | MeshStandardMaterial).dispose();
      }
    });
    this.barTexture.dispose();
  }
}
