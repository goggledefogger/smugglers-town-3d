/**
 * Contraband and the two team bases, driven by MatchRules state each frame.
 * The contraband is a golden toilet with smoke pouring upward from the bowl —
 * something is on fire in there — plus a tall additive beacon beam so a match
 * of four reads from across the map. A carried toilet hides its beacon and
 * rides the interpolated car; the smoke keeps rising either way.
 *
 * Both bases reuse the same beam/glow helpers. Crates are pooled: a wave brings
 * four, and the pool grows to whatever the state holds.
 */
import {
  Group, Mesh, BoxGeometry, CircleGeometry, RingGeometry, CylinderGeometry, TorusGeometry,
  SphereGeometry, Sprite, SpriteMaterial, CanvasTexture, Vector3,
  MeshBasicMaterial, MeshStandardMaterial, PointLight,
  DoubleSide, AdditiveBlending, type Material
} from 'three';
import type { MatchState } from '../core/gameplay/MatchRules.ts';
import type { VehicleBody } from '../core/physics/VehicleBody.ts';
import { TEAM_COLORS, type Pose } from './VehicleView.ts';
import { config } from '../app/config.ts';
import { vehicleEnvMap } from './vehicleMeshes.ts';

/** 1×64 white texture whose alpha fades from opaque at v=0 to clear at v=1. */
function fadeTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 64);
  return new CanvasTexture(c);
}

/** Soft round puff: white core fading to transparent at the edge, built once. */
function smokeTexture(): CanvasTexture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new CanvasTexture(c);
}

function glowMaterial(color: number, opacity: number, map: CanvasTexture | null = null): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, side: DoubleSide,
    ...(map ? { map } : {})
  });
}

/** Open-ended tapered column, fading out toward the top. */
function beam(color: number, rBottom: number, rTop: number, h: number, opacity: number, fade: CanvasTexture): Mesh {
  const m = new Mesh(new CylinderGeometry(rTop, rBottom, h, 24, 1, true), glowMaterial(color, opacity, fade));
  m.position.y = h / 2;
  return m;
}

/**
 * Rising smoke plume: a fixed pool of sprites cycled upward. Each puff spawns
 * at the bowl rim, swells and fades as it climbs, then recycles. The plume sits
 * as a child of the toilet group so it follows a carried toilet; the puff
 * sprites face the camera automatically (sprites always do). One shared smoke
 * texture across every plume keeps the draw cheap.
 */
class SmokePlume {
  private static readonly PUFFS = 14;
  private static readonly SPAWN_Y = 0.9;
  private static readonly RISE = 9;
  private static readonly LIFETIME = 2.4;
  private static readonly SWELL = 2.6;
  private readonly sprites: Sprite[] = [];
  private readonly born: number[] = [];
  private readonly seed: number;
  private readonly mat: SpriteMaterial;
  private now = 0;

  constructor(texture: CanvasTexture, seed: number) {
    this.seed = seed;
    this.mat = new SpriteMaterial({
      map: texture, transparent: true, opacity: 0, depthWrite: false,
      blending: AdditiveBlending, color: 0xfff2dc
    });
    for (let i = 0; i < SmokePlume.PUFFS; i++) {
      // stagger the first cycle so the plume starts mid-billow, not all at once
      const s = new Sprite(this.mat);
      s.visible = false;
      this.sprites.push(s);
      this.born.push(-Infinity);
    }
  }

  get objects(): Sprite[] { return this.sprites; }

  update(dt: number): void {
    this.now += dt;
    for (let i = 0; i < this.sprites.length; i++) {
      const s = this.sprites[i]!;
      const age = this.now - this.born[i]!;
      if (age >= SmokePlume.LIFETIME) {
        // respawn at the bowl rim with a per-puff jitter so the column isn't a
        // perfect stack — drift, scale and spawn time all vary by seed
        this.born[i] = this.now - (i / SmokePlume.PUFFS) * SmokePlume.LIFETIME;
        continue;
      }
      const t = age / SmokePlume.LIFETIME;
      const drift = Math.sin(this.seed * 3.1 + i * 1.7) * 0.6 * t;
      s.visible = true;
      s.position.set(
        drift,
        SmokePlume.SPAWN_Y + t * SmokePlume.RISE,
        drift * 0.5
      );
      const scale = 0.7 + t * SmokePlume.SWELL;
      s.scale.setScalar(scale);
      // fade in fast, hold, then taper out — a plume, not a blinking light
      this.mat.opacity = Math.sin(t * Math.PI) * 0.5;
    }
  }

  reset(): void {
    this.now = 0;
    for (let i = 0; i < this.born.length; i++) this.born[i] = -Infinity;
    for (const s of this.sprites) s.visible = false;
  }

  dispose(): void {
    this.mat.dispose();
  }
}

class Base {
  readonly group = new Group();
  private readonly beam: Mesh;
  private readonly dashes = new Group();
  private readonly beamOpacity: number;

  constructor(color: number, fade: CanvasTexture) {
    const r = config.scoring.deliveryRadius;
    const disc = new Mesh(new CircleGeometry(r, 48), glowMaterial(color, 0.16));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.35;
    const ring = new Mesh(new RingGeometry(r - 1.2, r, 64), glowMaterial(color, 0.75));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.4;
    for (let i = 0; i < 8; i++) {
      const dash = new Mesh(new RingGeometry(r + 2, r + 3.4, 8, 1, (i * Math.PI) / 4, Math.PI / 7), glowMaterial(color, 0.5));
      dash.rotation.x = -Math.PI / 2;
      this.dashes.add(dash);
    }
    this.dashes.position.y = 0.4;
    this.beamOpacity = 0.28;
    this.beam = beam(color, r * 0.35, r * 0.6, 70, this.beamOpacity, fade);
    const post = new MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.8 });
    const cap = new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2 });
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const pylon = new Group();
      pylon.position.set(Math.cos(a) * (r + 1), 0, Math.sin(a) * (r + 1));
      const p = new Mesh(new BoxGeometry(0.5, 5, 0.5), post);
      p.position.y = 2.5;
      const c = new Mesh(new BoxGeometry(0.75, 0.6, 0.75), cap);
      c.position.y = 5.3;
      pylon.add(p, c);
      this.group.add(pylon);
    }
    this.group.add(disc, ring, this.dashes, this.beam, new PointLight(color, 1.5, 80, 1.5));
  }

  animate(t: number): void {
    this.dashes.rotation.y = t * 0.3;
    (this.beam.material as MeshBasicMaterial).opacity = this.beamOpacity + 0.08 * Math.sin(t * 2);
  }
}

interface CrateView {
  readonly group: Group;
  readonly toilet: Group;
  readonly beacon: Mesh;
  readonly plume: SmokePlume;
}

export class Pickups {
  private readonly fade = fadeTexture();
  private readonly smokeTex = smokeTexture();
  private readonly crates: CrateView[] = [];
  private readonly bases: readonly [Base, Base];
  private readonly _back = new Vector3();
  private visible = true;

  constructor(private readonly scene: { add(o: Group): void }) {
    this.bases = [new Base(TEAM_COLORS[0], this.fade), new Base(TEAM_COLORS[1], this.fade)];
    for (const b of this.bases) scene.add(b.group);
  }

  /**
   * One golden toilet, beacon and all. A tank-and-bowl silhouette built from
   * primitives: a pedestal base, an open bowl (the toilet ring plus a dark
   * water surface inside), a tank behind, and a flusher knob. The gold shares
   * the vehicle studio envmap so polished gold actually reflects the room.
   */
  private makeToilet(): CrateView {
    const group = new Group();
    const env = vehicleEnvMap();
    // polished cast gold: metallic and fairly smooth so the envmap reads, with
    // enough roughness that it's a prop and not a mirror
    const gold = new MeshStandardMaterial({
      color: 0xffc14d, metalness: 0.95, roughness: 0.28,
      envMap: env ?? undefined, envMapIntensity: 1.1
    });
    const goldDark = new MeshStandardMaterial({
      color: 0xd99a33, metalness: 0.95, roughness: 0.4,
      envMap: env ?? undefined, envMapIntensity: 0.85
    });

    const toilet = new Group();

    // pedestal foot: a flared base the bowl stands on
    const foot = new Mesh(new CylinderGeometry(0.85, 1.05, 0.28, 28), gold);
    foot.position.y = 0.14;
    toilet.add(foot);

    // pedestal stem up to the bowl
    const stem = new Mesh(new CylinderGeometry(0.62, 0.85, 0.5, 28), gold);
    stem.position.y = 0.53;
    toilet.add(stem);

    // bowl: a squat open cylinder; its top edge is the toilet rim
    const bowl = new Mesh(new CylinderGeometry(0.85, 0.7, 0.55, 28, 1, true), gold);
    bowl.position.y = 1.05;
    toilet.add(bowl);

    // rim: a gold torus on the bowl's top opening, read as the seat lip
    const rim = new Mesh(new TorusGeometry(0.85, 0.14, 12, 28), gold);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 1.32;
    toilet.add(rim);

    // dark water surface inside the bowl — the smoke source sits just above it
    const water = new Mesh(
      new CylinderGeometry(0.72, 0.72, 0.04, 24),
      new MeshStandardMaterial({ color: 0x14100a, roughness: 0.35, metalness: 0.4 })
    );
    water.position.y = 1.08;
    toilet.add(water);

    // tank: a box behind the bowl, slightly taller than the rim
    const tank = new Mesh(new BoxGeometry(1.5, 0.85, 0.55), gold);
    tank.position.set(0, 1.45, -0.62);
    toilet.add(tank);
    // tank lid, a thinner cap on top so the tank reads as hollow
    const lid = new Mesh(new BoxGeometry(1.56, 0.12, 0.6), goldDark);
    lid.position.set(0, 1.93, -0.62);
    toilet.add(lid);

    // flusher knob on top of the tank lid
    const flusher = new Mesh(new SphereGeometry(0.12, 12, 10), goldDark);
    flusher.position.set(0, 2.02, -0.62);
    toilet.add(flusher);

    // a soft warm glow inside the bowl so the rising smoke reads as lit from
    // below, like embers — not a real fire mesh, just the suggestion of one
    const ember = new Mesh(
      new SphereGeometry(0.5, 14, 12),
      new MeshBasicMaterial({ color: 0xff7a22, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false })
    );
    ember.position.y = 1.12;
    toilet.add(ember);

    group.add(toilet);

    // smoke pouring upward from the bowl
    const plume = new SmokePlume(this.smokeTex, this.crates.length);
    for (const s of plume.objects) group.add(s);

    // beacon beam, as before: tall additive column marking it from afar
    const beacon = beam(0xffc040, 0.5, 1.4, 50, 0.45, this.fade);
    group.add(beacon, new PointLight(0xffaa00, 2, 40, 1.5));
    group.visible = this.visible;
    this.scene.add(group);
    const view: CrateView = { group, toilet, beacon, plume };
    this.crates.push(view);
    return view;
  }

  /** Hidden in the garage, where no match exists yet. */
  setVisible(v: boolean): void {
    this.visible = v;
    for (const c of this.crates) c.group.visible = v;
    for (const b of this.bases) b.group.visible = v;
  }

  /** poseOf: a carrier's rendered pose, so a carried crate rides the interpolated car. */
  sync(state: MatchState, timeS: number, dt: number, poseOf: (body: VehicleBody) => Pose | null): void {
    const live = state.contraband;
    while (this.crates.length < live.length) this.makeToilet();
    for (let i = 0; i < this.crates.length; i++) {
      const view = this.crates[i]!;
      const crate = live[i];
      // a delivered crate leaves the map until its wave resets
      if (!crate || crate.delivered) {
        view.group.visible = false;
        continue;
      }
      view.group.visible = this.visible;
      const pose = crate.carrier ? poseOf(crate.carrier) : null;
      view.beacon.visible = !crate.carrier;
      if (pose) {
        // ride in the bed behind the driver
        this._back.set(0, 1.4, 1.2).applyQuaternion(pose.quat);
        view.group.position.copy(pose.pos).add(this._back);
        view.toilet.quaternion.copy(pose.quat);
        view.toilet.position.y = 0;
      } else {
        // carried but its car has no rendered pose (a client mid-join): fall
        // back to the body's own position rather than dropping it at the origin
        const at = crate.carrier ? crate.carrier.pos : crate.pos;
        view.group.position.set(at.x, at.y - 1.6, at.z);
        // stagger the bob so four crates do not pulse in lockstep
        view.toilet.position.y = 1.6 + Math.sin(timeS * 3.3 + i * 1.7) * 0.4;
        view.toilet.rotation.y += dt * 1.2;
      }
      // smoke rises whether carried or loose — the bowl is always alight
      view.plume.update(dt);
    }
    for (const team of [0, 1] as const) {
      const b = state.bases[team];
      this.bases[team].group.position.set(b.x, b.y, b.z);
      this.bases[team].animate(timeS + team * 1.7);
    }
  }

  dispose(): void {
    const groups = [...this.crates.map(c => c.group), this.bases[0].group, this.bases[1].group];
    for (const g of groups) {
      g.traverse(obj => {
        const m = obj as Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (m.material as Material).dispose();
      });
    }
    for (const c of this.crates) c.plume.dispose();
    this.fade.dispose();
    this.smokeTex.dispose();
  }
}
