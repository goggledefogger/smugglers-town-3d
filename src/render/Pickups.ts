/**
 * Contraband crates and the two team bases, driven by MatchRules state each
 * frame. Both use a tall additive light column with an alpha fade so they
 * read from across the map; a crate hides its beacon while carried. Crates are
 * pooled: a wave brings four, and the pool grows to whatever the state holds.
 */
import {
  Group, Mesh, BoxGeometry, CircleGeometry, RingGeometry, CylinderGeometry, EdgesGeometry, LineSegments,
  LineBasicMaterial, MeshStandardMaterial, MeshBasicMaterial, PointLight, CanvasTexture, Vector3,
  DoubleSide, AdditiveBlending, type Material
} from 'three';
import type { MatchState } from '../core/gameplay/MatchRules.ts';
import type { VehicleBody } from '../core/physics/VehicleBody.ts';
import { TEAM_COLORS, type Pose } from './VehicleView.ts';
import { config } from '../app/config.ts';

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
  readonly box: Mesh;
  readonly beacon: Mesh;
}

export class Pickups {
  private readonly fade = fadeTexture();
  private readonly crates: CrateView[] = [];
  private readonly bases: readonly [Base, Base];
  private readonly _back = new Vector3();
  private visible = true;

  constructor(private readonly scene: { add(o: Group): void }) {
    this.bases = [new Base(TEAM_COLORS[0], this.fade), new Base(TEAM_COLORS[1], this.fade)];
    for (const b of this.bases) scene.add(b.group);
  }

  /** One strapped wooden crate, beacon and all. */
  private makeCrate(): CrateView {
    const group = new Group();
    const wood = new MeshStandardMaterial({ color: 0x9a6a36, roughness: 0.9 });
    const strap = new MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.7, metalness: 0.3 });
    const box = new Mesh(new BoxGeometry(1.6, 1.6, 1.6), wood);
    box.add(new LineSegments(new EdgesGeometry(box.geometry), new LineBasicMaterial({ color: 0x4a3016 })));
    for (const [w, d] of [[1.66, 0.3], [0.3, 1.66]] as const) {
      box.add(new Mesh(new BoxGeometry(w, 1.66, d), strap));
    }
    const seal = new Mesh(new BoxGeometry(0.5, 0.5, 0.06), new MeshStandardMaterial({ color: 0xffcc33, emissive: 0xff9900, emissiveIntensity: 1.2 }));
    seal.position.z = 0.82;
    box.add(seal);
    const beacon = beam(0xffc040, 0.5, 1.4, 50, 0.45, this.fade);
    group.add(box, beacon, new PointLight(0xffaa00, 2, 40, 1.5));
    group.visible = this.visible;
    this.scene.add(group);
    const view: CrateView = { group, box, beacon };
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
    while (this.crates.length < live.length) this.makeCrate();
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
        view.box.quaternion.copy(pose.quat);
        view.box.position.y = 0;
      } else {
        // carried but its car has no rendered pose (a client mid-join): fall
        // back to the body's own position rather than dropping it at the origin
        const at = crate.carrier ? crate.carrier.pos : crate.pos;
        view.group.position.set(at.x, at.y - 1.6, at.z);
        // stagger the bob so four crates do not pulse in lockstep
        view.box.position.y = 1.6 + Math.sin(timeS * 3.3 + i * 1.7) * 0.4;
        view.box.rotation.y += dt * 1.2;
      }
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
    this.fade.dispose();
  }
}
