/**
 * Contraband crate and the two team bases, driven by MatchRules state each
 * frame. Both use a tall additive light column with an alpha fade so they
 * read from across the map; the crate hides its beacon while carried.
 */
import {
  Group, Mesh, BoxGeometry, CircleGeometry, RingGeometry, CylinderGeometry, EdgesGeometry, LineSegments,
  LineBasicMaterial, MeshStandardMaterial, MeshBasicMaterial, PointLight, CanvasTexture, Vector3,
  DoubleSide, AdditiveBlending, type Material
} from 'three';
import type { MatchState } from '../core/gameplay/MatchRules.ts';
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

export class Pickups {
  private readonly fade = fadeTexture();
  private readonly crate = new Group();
  private readonly crateBox: Mesh;
  private readonly beacon: Mesh;
  private readonly bases: readonly [Base, Base];
  private readonly _back = new Vector3();

  constructor(scene: { add(o: Group): void }) {
    // strapped wooden crate
    const wood = new MeshStandardMaterial({ color: 0x9a6a36, roughness: 0.9 });
    const strap = new MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.7, metalness: 0.3 });
    this.crateBox = new Mesh(new BoxGeometry(1.6, 1.6, 1.6), wood);
    this.crateBox.add(new LineSegments(new EdgesGeometry(this.crateBox.geometry), new LineBasicMaterial({ color: 0x4a3016 })));
    for (const [w, d] of [[1.66, 0.3], [0.3, 1.66]] as const) {
      const s = new Mesh(new BoxGeometry(w, 1.66, d), strap);
      this.crateBox.add(s);
    }
    const seal = new Mesh(new BoxGeometry(0.5, 0.5, 0.06), new MeshStandardMaterial({ color: 0xffcc33, emissive: 0xff9900, emissiveIntensity: 1.2 }));
    seal.position.z = 0.82;
    this.crateBox.add(seal);
    this.beacon = beam(0xffc040, 0.5, 1.4, 50, 0.45, this.fade);
    this.crate.add(this.crateBox, this.beacon, new PointLight(0xffaa00, 2, 40, 1.5));
    scene.add(this.crate);
    this.bases = [new Base(TEAM_COLORS[0], this.fade), new Base(TEAM_COLORS[1], this.fade)];
    for (const b of this.bases) scene.add(b.group);
  }

  /** Hidden in the garage, where no match exists yet. */
  setVisible(v: boolean): void {
    this.crate.visible = v;
    for (const b of this.bases) b.group.visible = v;
  }

  /** carrier: the carrier's rendered pose, so the crate rides the interpolated car. */
  sync(state: MatchState, timeS: number, dt: number, carrier: Pose | null): void {
    this.beacon.visible = !carrier;
    if (carrier) {
      // ride in the bed behind the driver
      this._back.set(0, 1.4, 1.2).applyQuaternion(carrier.quat);
      this.crate.position.copy(carrier.pos).add(this._back);
      this.crateBox.quaternion.copy(carrier.quat);
      this.crateBox.position.y = 0;
    } else {
      this.crate.position.set(state.contrabandPos.x, state.contrabandPos.y - 1.6, state.contrabandPos.z);
      this.crateBox.position.y = 1.6 + Math.sin(timeS * 3.3) * 0.4;
      this.crateBox.rotation.y += dt * 1.2;
    }
    for (const team of [0, 1] as const) {
      const b = state.bases[team];
      this.bases[team].group.position.set(b.x, b.y, b.z);
      this.bases[team].animate(timeS + team * 1.7);
    }
  }

  dispose(): void {
    const groups = [this.crate, this.bases[0].group, this.bases[1].group];
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
