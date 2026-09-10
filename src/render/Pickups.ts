/**
 * Contraband crates and the two team bases, driven by MatchRules state each
 * frame. Both use a tall additive light column with an alpha fade so they
 * read from across the map; a crate hides its beacon while carried. Crates are
 * pooled: a wave brings four, and the pool grows to whatever the state holds.
 */
import {
  Group, Mesh, BufferGeometry, BufferAttribute, CylinderGeometry, BoxGeometry,
  MeshBasicMaterial, MeshStandardMaterial, PointLight, CanvasTexture, Vector3,
  DoubleSide, AdditiveBlending, RepeatWrapping, ClampToEdgeWrapping,
  type Camera, type Material
} from 'three';
import type { MatchState } from '../core/gameplay/MatchRules.ts';
import type { VehicleBody } from '../core/physics/VehicleBody.ts';
import type { Heightfield } from '../core/heightfield.ts';
import { TEAM_COLORS, type Pose } from './VehicleView.ts';
import { config } from '../app/config.ts';
import { SmokingToilet } from './ToiletMesh.ts';

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

/** Repeating dash pattern texture: 8 bright dashed segments around the circle circumference. */
function dashTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(255, 255, 255, 0)';
  ctx.fillRect(0, 0, 512, 16);
  // 8 dashed ticks: each period 64px, 36px filled, 28px empty
  ctx.fillStyle = 'rgba(255, 255, 255, 1)';
  for (let i = 0; i < 8; i++) {
    ctx.fillRect(i * 64, 0, 36, 16);
  }
  const tex = new CanvasTexture(c);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  return tex;
}

/** Vertical gradient fading from bright at the bottom to transparent at the top. */
function curtainTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 128, 0, 0); // bottom to top
  g.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  g.addColorStop(0.25, 'rgba(255, 255, 255, 0.6)');
  g.addColorStop(0.65, 'rgba(255, 255, 255, 0.2)');
  g.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 128);
  const tex = new CanvasTexture(c);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  return tex;
}

function glowMaterial(
  color: number,
  opacity: number,
  map: CanvasTexture | null = null,
  polygonOffset = true
): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    polygonOffset,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    ...(map ? { map } : {})
  });
}

function xRayGlowMaterial(color: number, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false, // shows through occluding terrain so base boundary is never hidden
    side: DoubleSide
  });
}

/** Open-ended tapered column, fading out toward the top. */
function beam(color: number, rBottom: number, rTop: number, h: number, opacity: number, fade: CanvasTexture): Mesh {
  const m = new Mesh(new CylinderGeometry(rTop, rBottom, h, 24, 1, true), glowMaterial(color, opacity, fade, false));
  m.position.y = h / 2;
  return m;
}

/** Generates a radial strip geometry whose vertices can be dynamically draped onto the terrain. */
function buildTerrainRingGeometry(segments: number): BufferGeometry {
  const geom = new BufferGeometry();
  const vertexCount = (segments + 1) * 2;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint16Array(segments * 6);

  let ptrUv = 0;
  let ptrIdx = 0;

  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    uvs[ptrUv++] = u;
    uvs[ptrUv++] = 0;
    uvs[ptrUv++] = u;
    uvs[ptrUv++] = 1;

    if (i < segments) {
      const idx = i * 2;
      indices[ptrIdx++] = idx;
      indices[ptrIdx++] = idx + 1;
      indices[ptrIdx++] = idx + 2;

      indices[ptrIdx++] = idx + 1;
      indices[ptrIdx++] = idx + 3;
      indices[ptrIdx++] = idx + 2;
    }
  }

  geom.setAttribute('position', new BufferAttribute(positions, 3));
  geom.setAttribute('uv', new BufferAttribute(uvs, 2));
  geom.setIndex(new BufferAttribute(indices, 1));
  return geom;
}

function updateTerrainRingPositions(
  geom: BufferGeometry,
  centerX: number,
  centerY: number,
  centerZ: number,
  rInner: number,
  rOuter: number,
  segments: number,
  yOffset: number,
  hf?: Heightfield | null
): void {
  const pos = geom.attributes.position as BufferAttribute;
  const arr = pos.array as Float32Array;
  let ptr = 0;

  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Inner vertex
    const x1 = rInner * cos;
    const z1 = rInner * sin;
    const wy1 = hf ? hf.sample(centerX + x1, centerZ + z1) : centerY;
    arr[ptr++] = x1;
    arr[ptr++] = wy1 - centerY + yOffset;
    arr[ptr++] = z1;

    // Outer vertex
    const x2 = rOuter * cos;
    const z2 = rOuter * sin;
    const wy2 = hf ? hf.sample(centerX + x2, centerZ + z2) : centerY;
    arr[ptr++] = x2;
    arr[ptr++] = wy2 - centerY + yOffset;
    arr[ptr++] = z2;
  }

  pos.needsUpdate = true;
  geom.computeVertexNormals();
}

/** Generates a vertical cylindrical curtain geometry whose bottom and top follow the terrain. */
function buildCurtainGeometry(segments: number): BufferGeometry {
  const geom = new BufferGeometry();
  const vertexCount = (segments + 1) * 2;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint16Array(segments * 6);

  let ptrUv = 0;
  let ptrIdx = 0;

  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    uvs[ptrUv++] = u;
    uvs[ptrUv++] = 0;
    uvs[ptrUv++] = u;
    uvs[ptrUv++] = 1;

    if (i < segments) {
      const idx = i * 2;
      indices[ptrIdx++] = idx;
      indices[ptrIdx++] = idx + 1;
      indices[ptrIdx++] = idx + 2;

      indices[ptrIdx++] = idx + 1;
      indices[ptrIdx++] = idx + 3;
      indices[ptrIdx++] = idx + 2;
    }
  }

  geom.setAttribute('position', new BufferAttribute(positions, 3));
  geom.setAttribute('uv', new BufferAttribute(uvs, 2));
  geom.setIndex(new BufferAttribute(indices, 1));
  return geom;
}

function updateCurtainPositions(
  geom: BufferGeometry,
  centerX: number,
  centerY: number,
  centerZ: number,
  radius: number,
  segments: number,
  bottomDepth: number,
  topHeight: number,
  hf?: Heightfield | null
): void {
  const pos = geom.attributes.position as BufferAttribute;
  const arr = pos.array as Float32Array;
  let ptr = 0;

  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const x = radius * Math.cos(angle);
    const z = radius * Math.sin(angle);
    const wy = hf ? hf.sample(centerX + x, centerZ + z) : centerY;

    // Bottom vertex (slightly sub-surface)
    arr[ptr++] = x;
    arr[ptr++] = wy - centerY - bottomDepth;
    arr[ptr++] = z;

    // Top vertex (extends high into the air)
    arr[ptr++] = x;
    arr[ptr++] = wy - centerY + topHeight;
    arr[ptr++] = z;
  }

  pos.needsUpdate = true;
  geom.computeVertexNormals();
}

/** Generates concentric terrain-conforming disc geometry for soft ground fill. */
function buildTerrainDiscGeometry(rings: number, segments: number): BufferGeometry {
  const geom = new BufferGeometry();
  const vertexCount = 1 + rings * segments;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint16Array(segments * 3 + (rings - 1) * segments * 6);

  let ptrIdx = 0;

  // Center triangle fan
  for (let j = 0; j < segments; j++) {
    const next = (j + 1) % segments;
    indices[ptrIdx++] = 0;
    indices[ptrIdx++] = 1 + next;
    indices[ptrIdx++] = 1 + j;
  }

  // Outer concentric quads
  for (let r = 0; r < rings - 1; r++) {
    const rStart = 1 + r * segments;
    const nextRStart = 1 + (r + 1) * segments;
    for (let j = 0; j < segments; j++) {
      const next = (j + 1) % segments;
      const i0 = rStart + j;
      const i1 = rStart + next;
      const i2 = nextRStart + j;
      const i3 = nextRStart + next;

      indices[ptrIdx++] = i0;
      indices[ptrIdx++] = i1;
      indices[ptrIdx++] = i2;

      indices[ptrIdx++] = i1;
      indices[ptrIdx++] = i3;
      indices[ptrIdx++] = i2;
    }
  }

  geom.setAttribute('position', new BufferAttribute(positions, 3));
  geom.setAttribute('uv', new BufferAttribute(uvs, 2));
  geom.setIndex(new BufferAttribute(indices, 1));
  return geom;
}

function updateTerrainDiscPositions(
  geom: BufferGeometry,
  centerX: number,
  centerY: number,
  centerZ: number,
  radius: number,
  rings: number,
  segments: number,
  yOffset: number,
  hf?: Heightfield | null
): void {
  const pos = geom.attributes.position as BufferAttribute;
  const arr = pos.array as Float32Array;
  let ptr = 0;

  // Center vertex
  arr[ptr++] = 0;
  arr[ptr++] = yOffset;
  arr[ptr++] = 0;

  for (let r = 1; r <= rings; r++) {
    const ringR = radius * (r / rings);
    for (let j = 0; j < segments; j++) {
      const angle = (j / segments) * Math.PI * 2;
      const x = ringR * Math.cos(angle);
      const z = ringR * Math.sin(angle);
      const wy = hf ? hf.sample(centerX + x, centerZ + z) : centerY;
      arr[ptr++] = x;
      arr[ptr++] = wy - centerY + yOffset;
      arr[ptr++] = z;
    }
  }

  pos.needsUpdate = true;
  geom.computeVertexNormals();
}

class Base {
  readonly group = new Group();
  private readonly beam: Mesh;
  private readonly curtain: Mesh;
  private readonly ringMesh: Mesh;
  private readonly xRayRingMesh: Mesh;
  private readonly dashedMesh: Mesh;
  private readonly discMesh: Mesh;
  private readonly pylons: Group[] = [];
  private readonly beamOpacity: number;
  private readonly radius = config.scoring.deliveryRadius;

  private lastX = NaN;
  private lastY = NaN;
  private lastZ = NaN;
  private lastHf: Heightfield | null = null;

  constructor(
    color: number,
    fade: CanvasTexture,
    private readonly dashTex: CanvasTexture,
    curtainTex: CanvasTexture
  ) {
    const r = this.radius;

    // 1. Concentric ground disc fill
    const discGeom = buildTerrainDiscGeometry(4, 48);
    this.discMesh = new Mesh(discGeom, glowMaterial(color, 0.18, null, true));
    this.discMesh.renderOrder = 2;

    // 2. Solid delivery perimeter ring
    const ringGeom = buildTerrainRingGeometry(96);
    this.ringMesh = new Mesh(ringGeom, glowMaterial(color, 0.85, null, true));
    this.ringMesh.renderOrder = 3;

    // 3. X-Ray pass: always shows through hills and obstacles so base boundary is never hidden
    this.xRayRingMesh = new Mesh(ringGeom, xRayGlowMaterial(color, 0.28));
    this.xRayRingMesh.renderOrder = 10;

    // 4. Outer dashed ring with animated flow along terrain contours
    const dashGeom = buildTerrainRingGeometry(96);
    this.dashedMesh = new Mesh(dashGeom, glowMaterial(color, 0.75, dashTex, true));
    this.dashedMesh.renderOrder = 3;

    // 5. Vertical holographic perimeter curtain: projects 5m above terrain
    const curtainGeom = buildCurtainGeometry(96);
    this.curtain = new Mesh(curtainGeom, glowMaterial(color, 0.42, curtainTex, false));
    this.curtain.renderOrder = 4;

    // 6. Central sky beam
    this.beamOpacity = 0.28;
    this.beam = beam(color, r * 0.35, r * 0.6, 70, this.beamOpacity, fade);

    // 7. Grounded perimeter pylons
    const post = new MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.8 });
    const cap = new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2 });
    for (let i = 0; i < 4; i++) {
      const pylon = new Group();
      const p = new Mesh(new BoxGeometry(0.5, 5, 0.5), post);
      p.position.y = 2.5;
      const c = new Mesh(new BoxGeometry(0.75, 0.6, 0.75), cap);
      c.position.y = 5.3;
      pylon.add(p, c);
      this.pylons.push(pylon);
      this.group.add(pylon);
    }

    this.group.add(
      this.discMesh,
      this.ringMesh,
      this.xRayRingMesh,
      this.dashedMesh,
      this.curtain,
      this.beam,
      new PointLight(color, 1.8, 90, 1.5)
    );
  }

  updatePose(x: number, y: number, z: number, hf?: Heightfield | null): void {
    const moved = x !== this.lastX || y !== this.lastY || z !== this.lastZ || hf !== this.lastHf;
    if (moved) {
      this.lastX = x;
      this.lastY = y;
      this.lastZ = z;
      this.lastHf = hf ?? null;
      this.group.position.set(x, y, z);
      this.rebuildGeometries(x, y, z, hf);
    }
  }

  private rebuildGeometries(x: number, y: number, z: number, hf?: Heightfield | null): void {
    const r = this.radius;

    // Update inner disc conforming to terrain
    updateTerrainDiscPositions(this.discMesh.geometry, x, y, z, r, 4, 48, 0.25, hf);

    // Update solid delivery ring conforming to terrain (+0.35m)
    updateTerrainRingPositions(this.ringMesh.geometry, x, y, z, r - 1.2, r, 96, 0.35, hf);

    // Update outer dashed ring conforming to terrain (+0.35m)
    updateTerrainRingPositions(this.dashedMesh.geometry, x, y, z, r + 1.8, r + 3.2, 96, 0.35, hf);

    // Update vertical holographic perimeter curtain (depth -0.5m, height +5.0m)
    updateCurtainPositions(this.curtain.geometry, x, y, z, r, 96, 0.5, 5.0, hf);

    // Plant pylons firmly on the terrain
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const px = Math.cos(a) * (r + 1);
      const pz = Math.sin(a) * (r + 1);
      const wy = hf ? hf.sample(x + px, z + pz) : y;
      this.pylons[i]!.position.set(px, wy - y, pz);
    }
  }

  animate(t: number): void {
    if (this.dashTex) {
      this.dashTex.offset.x = -t * 0.12;
    }
    (this.beam.material as MeshBasicMaterial).opacity = this.beamOpacity + 0.08 * Math.sin(t * 2);
    (this.curtain.material as MeshBasicMaterial).opacity = 0.36 + 0.09 * Math.sin(t * 2.4);
  }
}

interface CrateView {
  readonly group: Group;
  readonly toilet: SmokingToilet;
}

export class Pickups {
  private readonly fade = fadeTexture();
  private readonly dashTex = dashTexture();
  private readonly curtainTex = curtainTexture();
  private readonly crates: CrateView[] = [];
  private readonly bases: readonly [Base, Base];
  private readonly _back = new Vector3();
  private visible = true;

  constructor(
    private readonly scene: { add(o: Group): void },
    private readonly cameraSource?: Camera | (() => Camera | null) | null,
    private readonly ground?: () => Heightfield
  ) {
    this.bases = [
      new Base(TEAM_COLORS[0], this.fade, this.dashTex, this.curtainTex),
      new Base(TEAM_COLORS[1], this.fade, this.dashTex, this.curtainTex)
    ];
    for (const b of this.bases) scene.add(b.group);
  }

  private getCamera(): Camera | null {
    if (!this.cameraSource) return null;
    return typeof this.cameraSource === 'function' ? this.cameraSource() : this.cameraSource;
  }

  /** One Smoking Golden Toilet with billowing smoke plume and sky beacon. */
  private makeCrate(): CrateView {
    const toilet = new SmokingToilet(this.fade);
    toilet.setShown(this.visible);
    this.scene.add(toilet.group);
    const view: CrateView = { group: toilet.group, toilet };
    this.crates.push(view);
    return view;
  }

  /** Hidden in the garage, where no match exists yet. */
  setVisible(v: boolean): void {
    this.visible = v;
    for (const c of this.crates) c.toilet.setShown(v);
    for (const b of this.bases) b.group.visible = v;
  }

  /** poseOf: a carrier's rendered pose, so a carried toilet rides the interpolated car. */
  sync(state: MatchState, timeS: number, dt: number, poseOf: (body: VehicleBody) => Pose | null): void {
    const live = state.contraband;
    const camera = this.getCamera();
    while (this.crates.length < live.length) this.makeCrate();

    for (let i = 0; i < this.crates.length; i++) {
      const view = this.crates[i]!;
      const crate = live[i];
      // a delivered crate leaves the map until its wave resets
      // shown/hidden through the toilet, never the group: the group holds
      // point lights, and a change in the visible light count recompiles
      // every shader in the scene
      if (!crate || crate.delivered) {
        view.toilet.setShown(false);
        continue;
      }
      view.toilet.setShown(this.visible);
      const pose = crate.carrier ? poseOf(crate.carrier) : null;
      const isCarried = !!crate.carrier;
      view.toilet.beacon.visible = this.visible && !isCarried;

      // Update smoke plumes and fire flicker
      view.toilet.update(dt, timeS + i * 1.3, camera, isCarried);

      if (pose) {
        // ride in the bed behind the driver
        this._back.set(0, 1.3, 1.2).applyQuaternion(pose.quat);
        view.group.position.copy(pose.pos).add(this._back);
        view.toilet.model.quaternion.copy(pose.quat);
        view.toilet.model.position.y = 0;
      } else {
        // carried but its car has no rendered pose (a client mid-join): fall
        // back to the body's own position rather than dropping it at the origin
        const at = crate.carrier ? crate.carrier.pos : crate.pos;
        view.group.position.set(at.x, at.y - 1.6, at.z);
        // stagger the bob so four toilets do not pulse in lockstep
        view.toilet.model.position.y = 1.6 + Math.sin(timeS * 3.3 + i * 1.7) * 0.35;
        view.toilet.model.rotation.y += dt * 1.2;
      }
    }
    const hf = this.ground?.() ?? null;
    for (const team of [0, 1] as const) {
      const b = state.bases[team];
      this.bases[team].updatePose(b.x, b.y, b.z, hf);
      this.bases[team].animate(timeS + team * 1.7);
    }
  }

  dispose(): void {
    for (const c of this.crates) {
      c.toilet.dispose();
    }
    for (const b of this.bases) {
      b.group.traverse(obj => {
        const m = obj as Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (m.material as Material).dispose();
      });
    }
    this.fade.dispose();
    this.dashTex.dispose();
    this.curtainTex.dispose();
  }
}
