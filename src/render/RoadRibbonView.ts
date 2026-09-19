/**
 * Vector City streets: the OSM road polylines the collider pass already
 * fetches, drawn as asphalt ribbons draped a hand's breadth over the ground,
 * with kerbs, edge lines and a dashed centre line on two-way widths. Crisp
 * at any distance where the satellite ground under the hood camera is a
 * blur, and honest: a ribbon is exactly a carved road corridor.
 */
import {
  BufferGeometry, BufferAttribute, Group, Mesh, ShaderMaterial, DoubleSide
} from 'three';

interface RoadPoint { east: number; north: number; widthM: number }

/** Longest ribbon segment (m) before it is split so the strip follows the hill. */
const STEP_M = 6;
/** How far above the ground the ribbon floats (m). */
const LIFT_M = 0.12;
/** Wider roads sit this much higher per metre of width, so a junction shows the bigger road on top. */
const WIDTH_LIFT = 0.004;

const VERT = `
attribute vec2 aRoadUV;
attribute float aWidth;
varying vec2 vUv;
varying float vWidth;
void main() {
  vUv = aRoadUV;
  vWidth = aWidth;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = `
varying vec2 vUv;
varying float vWidth;
void main() {
  float hw = vWidth * 0.5;
  float across = abs(vUv.x) * hw; // metres from the centre line
  float grain = fract(sin(dot(floor(vec2(vUv.y, vUv.x * hw) * 6.0), vec2(12.9898, 78.233))) * 43758.5453);
  vec3 c = vec3(0.13, 0.13, 0.14) * (0.96 + 0.08 * grain);
  float aa = fwidth(across) + 0.01;
  // kerb: the outer 0.4 m a shade lighter, like concrete
  c = mix(c, vec3(0.30, 0.29, 0.27), smoothstep(hw - 0.4 - aa, hw - 0.4 + aa, across));
  // edge line 0.7 m in, 0.15 m wide
  float edgeLine = smoothstep(hw - 0.85 - aa, hw - 0.85 + aa, across) - smoothstep(hw - 0.7 - aa, hw - 0.7 + aa, across);
  c = mix(c, vec3(0.75, 0.75, 0.72), edgeLine * step(6.0, vWidth));
  // dashed centre line on two-way widths: 3 m on, 3 m off
  float centre = 1.0 - smoothstep(0.08 - aa, 0.08 + aa, across);
  float dash = step(0.5, fract(vUv.y / 6.0));
  c = mix(c, vec3(0.80, 0.68, 0.30), centre * dash * step(9.0, vWidth));
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Points of one polyline in world x/z, resampled so no segment is longer
 * than STEP_M, with the arc length in metres at each point. Pure, for the test.
 */
export function resamplePolyline(pts: readonly RoadPoint[]): { x: number; z: number; s: number; w: number }[] {
  const out: { x: number; z: number; s: number; w: number }[] = [];
  let s = 0;
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k]!;
    const ax = a.east, az = -a.north;
    if (k === 0) { out.push({ x: ax, z: az, s, w: a.widthM }); continue; }
    const p = out[out.length - 1]!;
    const len = Math.hypot(ax - p.x, az - p.z);
    const n = Math.max(1, Math.ceil(len / STEP_M));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      s += len / n;
      out.push({ x: p.x + (ax - p.x) * t, z: p.z + (az - p.z) * t, s, w: a.widthM });
    }
  }
  return out;
}

export class RoadRibbonView {
  readonly group = new Group();
  private mesh: Mesh | null = null;
  private readonly material: ShaderMaterial;
  /** flat x/z of every vertex, so a ground refinement can re-drape without rebuilding */
  private flat: Float32Array | null = null;
  private lifts: Float32Array | null = null;

  constructor() {
    this.group.visible = false;
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
  }

  get vertexCount(): number {
    return this.flat ? this.flat.length / 2 : 0;
  }

  build(polylines: readonly (readonly RoadPoint[])[], sampleGround: (x: number, z: number) => number): void {
    this.clear();
    const pos: number[] = [], uv: number[] = [], width: number[] = [], idx: number[] = [];
    const flat: number[] = [], lifts: number[] = [];
    for (const pl of polylines) {
      if (pl.length < 2) continue;
      const pts = resamplePolyline(pl);
      const base = pos.length / 3;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k]!;
        const prev = pts[Math.max(0, k - 1)]!, next = pts[Math.min(pts.length - 1, k + 1)]!;
        let dx = next.x - prev.x, dz = next.z - prev.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        // ponytail: perpendicular of the averaged direction, no mitre; a 90° corner pinches a little
        const px = -dz, pz = dx, hw = p.w / 2;
        const lift = LIFT_M + p.w * WIDTH_LIFT;
        for (const side of [-1, 1]) {
          const x = p.x + px * hw * side, z = p.z + pz * hw * side;
          pos.push(x, sampleGround(x, z) + lift, z);
          uv.push(side, p.s);
          width.push(p.w);
          flat.push(x, z);
          lifts.push(lift);
        }
        if (k > 0) {
          const a = base + (k - 1) * 2, b = base + k * 2;
          idx.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    }
    if (idx.length === 0) return;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('aRoadUV', new BufferAttribute(new Float32Array(uv), 2));
    geo.setAttribute('aWidth', new BufferAttribute(new Float32Array(width), 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    this.mesh = new Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.flat = new Float32Array(flat);
    this.lifts = new Float32Array(lifts);
  }

  /** The ground refined under the ribbons: re-drape every vertex. */
  refreshHeights(sampleGround: (x: number, z: number) => number): void {
    if (!this.mesh || !this.flat || !this.lifts) return;
    const p = this.mesh.geometry.getAttribute('position') as BufferAttribute;
    for (let v = 0; v < this.flat.length / 2; v++) {
      const x = this.flat[v * 2]!, z = this.flat[v * 2 + 1]!;
      p.setY(v, sampleGround(x, z) + this.lifts[v]!);
    }
    p.needsUpdate = true;
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
    this.flat = null;
    this.lifts = null;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
