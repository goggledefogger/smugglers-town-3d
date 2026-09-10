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
  Group, Mesh, PlaneGeometry, MeshBasicMaterial, Sprite, SpriteMaterial, CanvasTexture, MathUtils,
  Quaternion, Euler, Vector3, Color, type Material, type Texture
} from 'three';
import type { VehicleActor } from '../app/Game.ts';
import type { Heightfield } from '../core/heightfield.ts';
import { buildVehicle, type VehicleMesh } from './vehicleMeshes.ts';

export const TEAM_COLORS = [0x44ff66, 0xff5544] as const;
const WHEELBASE = 2.6;
const TRACK = 1.9;
const MAX_TILT = 0.6;
/**
 * Shadow footprint: the body's outline, a little past the tyres. A round soft
 * blob centred under the body is the drop-shadow cue the eye reads as "this
 * is hovering over a circle"; contact is a flat, near-uniform patch the shape
 * of the car, darkest where the tyres meet the ground.
 */
const SHADOW_W = TRACK + 0.9;
const SHADOW_L = WHEELBASE + 1.9;
const SHADOW_ALPHA = 0.5;

let shadowTex: Texture | null = null;
/**
 * The contact shadow, painted once and shared. A photo tile already has its
 * sun baked in, so a real shadow map would fight it; this is the ambient
 * occlusion every car has under it in any light: a rounded rectangle of the
 * body with a short edge, plus a darker pad under each tyre.
 */
function contactShadowTexture(): Texture {
  if (shadowTex) return shadowTex;
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d')!;
  const inset = 14, r = 18;
  // texture x spans SHADOW_W, y spans SHADOW_L
  ctx.shadowColor = 'rgba(0,0,0,1)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = 'rgba(0,0,0,0.9)';
  ctx.beginPath();
  ctx.roundRect(inset, inset, n - 2 * inset, n - 2 * inset, r);
  ctx.fill();
  ctx.fill();
  ctx.shadowBlur = 8;
  ctx.fillStyle = 'rgba(0,0,0,1)';
  const px = (TRACK / 2 / SHADOW_W) * n, pz = (WHEELBASE / 2 / SHADOW_L) * n;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(n / 2 + sx * px, n / 2 + sz * pz, 9, 13, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  shadowTex = new CanvasTexture(c);
  return shadowTex;
}

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
  private readonly shadow: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly team: number;
  private lastDamage = -1;
  private pitch = 0;
  private roll = 0;
  private readonly _tilt = new Quaternion();
  private readonly _euler = new Euler();
  private readonly _fwd = new Vector3();
  private readonly _right = new Vector3();

  /** Body materials and their designed colours, scaled by the photo ground's brightness. */
  private readonly tinted: { m: Material & { color: Color }; base: Color }[] = [];
  private shade = 1;

  constructor(
    readonly actor: VehicleActor,
    private readonly ground: () => Heightfield,
    /** Brightness of the photo ground under (x, z), 1 where there is none; see GroundShade. */
    private readonly groundShade: (x: number, z: number) => number = () => 1
  ) {
    this.car = buildVehicle(actor.body.stats, actor.team === 0 ? TEAM_COLORS[0] : TEAM_COLORS[1]);
    this.car.root.traverse(obj => {
      if (!(obj instanceof Mesh)) return;
      for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        const c = (m as Material & { color?: Color; emissive?: Color }).color;
        const e = (m as Material & { emissive?: Color }).emissive;
        // lights keep their own glow; everything else takes the ground's light
        if (c && !(e && (e.r > 0.2 || e.g > 0.2 || e.b > 0.2)) && !this.tinted.some(t => t.m === m)) {
          this.tinted.push({ m: m as Material & { color: Color }, base: c.clone() });
        }
      }
    });
    // the model's origin is its ground contact; the body's is groundClearance
    // above the ground. Without this the whole car rode a metre in the air,
    // which nothing gave away until it had a shadow. carRoot itself sits at
    // the contact point so the cosmetic tilt rolls about the ground, not a
    // point above the roof
    this.carRoot.position.y = -actor.body.cfg.groundClearance;
    this.carRoot.add(this.car.root);
    this.group.add(this.carRoot);

    // contact shadow under the car: always on so the car sits on the ground
    // instead of floating over it, thinning with height so a gap between car
    // and shadow reads as "airborne". Lives in carRoot so it turns and tilts
    // with the body.
    this.shadow = new Mesh(
      new PlaneGeometry(SHADOW_W, SHADOW_L),
      new MeshBasicMaterial({
        map: contactShadowTexture(), color: 0x000000, transparent: true, opacity: SHADOW_ALPHA,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4
      })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.carRoot.add(this.shadow);

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

    // ease into the photographed shadow the car is driving through
    const target = this.groundShade(x, z);
    if (Math.abs(target - this.shade) > 0.005) {
      this.shade += (target - this.shade) * (1 - Math.exp(-dt * 6));
      for (const t of this.tinted) t.m.color.copy(t.base).multiplyScalar(this.shade);
    }

    // the suspension lets the body ride above its clearance while it settles
    // (that smoothing is what keeps the camera calm); the wheels reach down
    // to the ground it is settling toward, so the tyres stay planted
    const reach = MathUtils.clamp(this.group.position.y - body.groundY - body.cfg.groundClearance, 0, 0.6);
    for (const w of this.car.wheels) w.spin.parent!.position.y = w.r - reach;

    this.shadow.position.y = body.groundY - this.group.position.y + body.cfg.groundClearance + 0.06;
    this.shadow.material.opacity = SHADOW_ALPHA * MathUtils.clamp(1 - height * 0.12, 0.25, 1);
    // a gap opens between car and shadow as it lifts; the shadow also spreads,
    // which is what the eye uses to read height
    const s = MathUtils.clamp(1 + height * 0.08, 1, 1.6);
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
