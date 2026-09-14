/**
 * Footprint 3D: every Overture building footprint extruded to its height as
 * one merged mesh. Each wall is a quad the facade baker can photograph (a
 * `Wall` segment with an outward normal), and wears its atlas rectangle once
 * the photo lands; the roof is the satellite image, unpainted walls the same
 * satellite-toned fill the boxes use. Unlit, like the tiles and the ground.
 */
import {
  BufferGeometry, BufferAttribute, Group, Mesh, ShaderMaterial, ShapeUtils, Vector2, DataTexture,
  RGBAFormat, UnsignedByteType, DoubleSide, type Texture
} from 'three';
import type { Wall } from './FacadeBaker.ts';

export interface Prism {
  /** outer ring, world x,z pairs, closed */
  readonly ring: number[];
  readonly holes: number[][];
  /** world y of the wall bottom and the roof */
  readonly y0: number;
  readonly y1: number;
}

const VERT = `
attribute vec2 aWallUV;
attribute vec4 aRect;
attribute float aPhotoV0;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vAtlasUV;
varying float vHasRect;
varying float vV;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normal;
  vV = aWallUV.y;
  // the photo may start part way up the wall (a tower part on a podium)
  vAtlasUV = aRect.xy + vec2(aWallUV.x, (aWallUV.y - aPhotoV0) / max(0.001, 1.0 - aPhotoV0)) * aRect.zw;
  vHasRect = (aRect.z > 0.0 && abs(normal.y) < 0.5 && aWallUV.y >= aPhotoV0) ? 1.0 : 0.0;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = `
uniform sampler2D uSatelliteMap;
uniform sampler2D uAtlas;
uniform float uUseAtlas;
uniform float uMapSize;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vAtlasUV;
varying float vHasRect;
varying float vV;
void main() {
  vec2 satUV = vec2(vWorldPos.x / uMapSize + 0.5, 0.5 - vWorldPos.z / uMapSize);
  vec3 sat = texture2D(uSatelliteMap, clamp(satUV, 0.0, 1.0)).rgb;
  vec3 c;
  if (vNormal.y > 0.5) {
    c = sat;
  } else {
    float faceLight = 0.86 + 0.08 * abs(vNormal.z);
    float eave = smoothstep(0.92, 1.0, vV);
    float plinth = smoothstep(0.08, 0.0, vV);
    c = mix(vec3(0.21, 0.20, 0.19), sat, 0.35) * faceLight * (1.0 - 0.22 * eave) * (1.0 - 0.32 * plinth);
    if (uUseAtlas > 0.5 && vHasRect > 0.5) {
      vec4 photo = texture2D(uAtlas, vAtlasUV);
      if (photo.a > 0.5) c = photo.rgb;
    }
  }
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function ringArea(r: number[]): number {
  let a = 0;
  for (let i = 0; i + 3 < r.length; i += 2) a += r[i]! * r[i + 3]! - r[i + 2]! * r[i + 1]!;
  return a / 2;
}

/**
 * The walls of one prism: one per ring edge, normal pointing out of the
 * building (into a hole for a hole ring), edges shorter than half a metre
 * dropped. Pure, so the tests can check the normals.
 */
export function prismWalls(p: Prism): Wall[] {
  const out: Wall[] = [];
  const rings = [p.ring, ...p.holes];
  rings.forEach((r, k) => {
    const sign = (ringArea(r) > 0 ? 1 : -1) * (k === 0 ? 1 : -1);
    for (let i = 0; i + 3 < r.length; i += 2) {
      const ax = r[i]!, az = r[i + 1]!, bx = r[i + 2]!, bz = r[i + 3]!;
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      out.push({ ax, az, bx, bz, nx: (sign * dz) / len, nz: (-sign * dx) / len, y0: p.y0, y1: p.y1 });
    }
  });
  return out;
}

export class PrismMeshView {
  readonly group = new Group();
  /** every wall of every prism, in the order the baker and setWallRect index them */
  walls: Wall[] = [];
  private mesh: Mesh | null = null;
  private rect: BufferAttribute | null = null;
  private photoV0: BufferAttribute | null = null;
  private readonly dummyTex: DataTexture;
  private readonly material: ShaderMaterial;

  constructor() {
    this.group.visible = false;
    this.dummyTex = new DataTexture(new Uint8Array([100, 110, 120, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    this.dummyTex.needsUpdate = true;
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uSatelliteMap: { value: this.dummyTex },
        uAtlas: { value: this.dummyTex },
        uUseAtlas: { value: 0 },
        uMapSize: { value: 5600 }
      },
      side: DoubleSide
    });
  }

  get count(): number {
    return this.walls.length;
  }

  setTexture(tex: Texture | null, mapSize: number): void {
    this.material.uniforms.uSatelliteMap!.value = tex ?? this.dummyTex;
    this.material.uniforms.uMapSize!.value = mapSize;
  }

  setAtlas(tex: Texture | null): void {
    this.material.uniforms.uAtlas!.value = tex ?? this.dummyTex;
    this.material.uniforms.uUseAtlas!.value = tex ? 1 : 0;
  }

  /** Wall `i`'s photo landed: its rectangle (texels, atlas `size` square) and where up the wall it starts. */
  setWallRect(i: number, x: number, y: number, w: number, h: number, size: number, pv0 = 0): void {
    if (!this.rect || !this.photoV0 || i >= this.walls.length) return;
    for (let v = i * 4; v < i * 4 + 4; v++) {
      this.rect.setXYZW(v, x / size, y / size, w / size, h / size);
      this.photoV0.setX(v, pv0);
    }
    this.rect.needsUpdate = true;
    this.photoV0.needsUpdate = true;
  }

  build(prisms: readonly Prism[]): void {
    this.clear();
    const walls: Wall[] = [];
    const wallsOf = prisms.map(p => { const w = prismWalls(p); walls.push(...w); return w; });
    // walls first (4 vertices each, so a wall's vertices are i*4..i*4+3), then roofs
    const roofs: { verts: number[]; tris: number[]; y: number }[] = [];
    let roofVerts = 0;
    prisms.forEach(p => {
      const contour = [] as Vector2[];
      for (let i = 0; i + 3 < p.ring.length; i += 2) contour.push(new Vector2(p.ring[i]!, p.ring[i + 1]!));
      const holes = p.holes.map(h => {
        const hv = [] as Vector2[];
        for (let i = 0; i + 3 < h.length; i += 2) hv.push(new Vector2(h[i]!, h[i + 1]!));
        return hv;
      });
      let tris: number[][];
      try { tris = ShapeUtils.triangulateShape(contour, holes); } catch { return; }
      const verts: number[] = [];
      for (const v of [contour, ...holes].flat()) verts.push(v.x, v.y);
      roofs.push({ verts, tris: tris.flat(), y: p.y1 });
      roofVerts += verts.length / 2;
    });
    const nWallV = walls.length * 4;
    const nV = nWallV + roofVerts;
    const pos = new Float32Array(nV * 3), nrm = new Float32Array(nV * 3), uv = new Float32Array(nV * 2);
    const rect = new Float32Array(nV * 4).fill(-1), pv0 = new Float32Array(nV);
    const idx: number[] = [];
    walls.forEach((w, i) => {
      const width = Math.hypot(w.bx - w.ax, w.bz - w.az);
      const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
      // u runs the way the face camera's right vector runs: up x normal
      const rx = w.nz, rz = -w.nx;
      const ua = 0.5 + ((w.ax - mx) * rx + (w.az - mz) * rz) / width;
      const ub = 0.5 + ((w.bx - mx) * rx + (w.bz - mz) * rz) / width;
      const corners: [number, number, number, number, number][] = [
        [w.ax, w.y0, w.az, ua, 0], [w.bx, w.y0, w.bz, ub, 0], [w.bx, w.y1, w.bz, ub, 1], [w.ax, w.y1, w.az, ua, 1]
      ];
      corners.forEach(([x, y, z, u, v], k) => {
        const o = i * 4 + k;
        pos[o * 3] = x; pos[o * 3 + 1] = y; pos[o * 3 + 2] = z;
        nrm[o * 3] = w.nx; nrm[o * 3 + 1] = 0; nrm[o * 3 + 2] = w.nz;
        uv[o * 2] = u; uv[o * 2 + 1] = v;
      });
      const b = i * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    });
    let o = nWallV;
    for (const r of roofs) {
      const base = o;
      for (let i = 0; i < r.verts.length; i += 2) {
        pos[o * 3] = r.verts[i]!; pos[o * 3 + 1] = r.y; pos[o * 3 + 2] = r.verts[i + 1]!;
        nrm[o * 3 + 1] = 1;
        o++;
      }
      for (const t of r.tris) idx.push(base + t);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('normal', new BufferAttribute(nrm, 3));
    geo.setAttribute('aWallUV', new BufferAttribute(uv, 2));
    this.rect = new BufferAttribute(rect, 4);
    this.photoV0 = new BufferAttribute(pv0, 1);
    geo.setAttribute('aRect', this.rect);
    geo.setAttribute('aPhotoV0', this.photoV0);
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    this.mesh = new Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.walls = walls;
    void wallsOf;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  clear(): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.rect = null;
    this.photoV0 = null;
    this.walls = [];
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
    this.dummyTex.dispose();
  }
}
