/**
 * Street-clutter filter for Google 3D Tiles.
 *
 * A tile is one photogrammetry mesh with no semantics, so parked cars, kerbs
 * and street furniture cannot be hidden by object. Instead every tile
 * material gets a shader patch (onBeforeCompile) that reads two textures the
 * physics already computes: the ground heightfield and the collider pass's
 * structure mask (building, deck or ramp cells, 10 m). Outside structure
 * cells:
 * - flatten: vertices less than CLUTTER_RISE_M above the ground drop onto the
 *   ground plane, so cars become decals on the road while facades keep their
 *   ground floors. The heightfield is the same one the car drives on, so
 *   flattened streets also line up with the physics surface.
 * - hidden: fragments are discarded, leaving the buildings, bridges and
 *   trees over the draped satellite terrain. The 10 m mask decides per
 *   fragment, so a facade whose footprint fell in a street cell goes too.
 * - swept: flatten, then discard every triangle whose three vertices all
 *   flattened. Cars, kerbs and the road surface vanish over the satellite
 *   ground like hidden, but anything reaching above the rise survives, so
 *   kerbside facades keep their walls. Street trees come back with them; no
 *   2D mask tells a tree at the kerb from the wall behind it.
 *
 * Facade snap (Best 3D) rides on the same patch: with `snap` on, a tile
 * vertex within reach of a collider box moves onto the box's nearest outer
 * face, so the photogrammetry wall the player sees is the wall the car hits,
 * and the texture, being on the vertices, never slides with the camera. The
 * cell -> box map and the box bounds are two more textures. Off structure
 * cells only snapped facades and flattened road decals survive, so nothing
 * tall is drawn that the car could drive through.
 *
 * Every patched material shares the same uniform objects: switching modes is
 * a value write, and both textures wrap the buffers physics owns, so a ground
 * refinement or collider rebuild is a re-upload, never a recompile.
 */
import {
  DataTexture, RedFormat, RGFormat, RGBAFormat, FloatType, UnsignedByteType, NearestFilter, LinearFilter,
  ClampToEdgeWrapping, Vector2,
  type Object3D, type Mesh, type Material, type WebGLProgramParametersWithUniforms
} from 'three';
import type { Heightfield } from '../core/heightfield.ts';
import type { BuildingCollider } from '../core/physics/VehicleBody.ts';
import type { Grid } from '../services/tiles/tileColliders.ts';
import { injectDetailGrain } from './DetailGrain.ts';

export type ClutterMode = 'off' | 'flatten' | 'hidden' | 'swept';
/** Index order is baked into the shader's mode comparisons: append, never reorder. */
export const CLUTTER_MODES: readonly ClutterMode[] = ['off', 'flatten', 'hidden', 'swept'];

/** Real metres above the ground estimate under which tile geometry is street clutter (a car is ~1.5 m). */
export const CLUTTER_RISE_M = 2.5;
/** Swept only: with no structure cell within bilinear reach, tall enough to take buses and RVs too. */
export const CLUTTER_TALL_M = 6;

/** Facade snap: roof geometry this far above a box top (m) still lands on it. */
export const SNAP_OUT_M = 4;
/** Facade snap: catch zone in front of a wall face, in grid cells; the walls are lenient on purpose. */
export const SNAP_REACH_OUT_CELLS = 2.5;
/** Facade snap: catch zone behind a wall face (inside the box), in grid cells. */
export const SNAP_REACH_IN_CELLS = 1.5;
/** Facade snap: cell -> box map is dilated by this many cells so the catch zone can find its box. */
export const SNAP_RING_CELLS = 2;
/** Box bounds texture: this many boxes per row, two texels (min, max) each. */
const BOXES_PER_ROW = 1024;

const VERTEX_PARS = `
uniform sampler2D uClutterGround;
uniform sampler2D uClutterMask;
uniform float uClutterMode;
uniform vec2 uClutterField;
uniform float uClutterRise;
uniform float uClutterTall;
uniform float uSnap;
uniform float uSnapIn;
uniform float uSnapTop;
uniform sampler2D uSnapIds;
uniform sampler2D uSnapBoxes;
varying vec3 vClutterWorldPos;
varying float vClutterRiseVal;
varying float vClutterStructure;
varying float vClutterFlat;
varying float vClutterOpenFlat;
varying float vSnapped;
flat varying float vSnapFace;
varying float vSnapFaceS;

// nearest snappable outer face of one box for point p: returns |distance| (1e9 = none)
float snapFace(vec3 p, vec3 bmin, vec3 bmax, float tolOut, float tolIn, out vec3 axis, out float plane, out int face) {
  // signed distance to each face plane, positive = outside the box
  float dW = bmin.x - p.x, dE = p.x - bmax.x;
  float dS = bmin.z - p.z, dN = p.z - bmax.z;
  float dT = p.y - bmax.y;
  bool inX = p.x > bmin.x - tolOut && p.x < bmax.x + tolOut;
  bool inZ = p.z > bmin.z - tolOut && p.z < bmax.z + tolOut;
  bool inY = p.y > bmin.y && p.y < bmax.y + 1.0;
  float best = 1e9;
  axis = vec3(0.0); plane = 0.0; face = 0;
  if (inZ && inY && dW > -tolIn && dW < tolOut && abs(dW) < best) { best = abs(dW); axis = vec3(-1.0, 0.0, 0.0); plane = bmin.x; face = 1; }
  if (inZ && inY && dE > -tolIn && dE < tolOut && abs(dE) < best) { best = abs(dE); axis = vec3(1.0, 0.0, 0.0); plane = bmax.x; face = 2; }
  if (inX && inY && dS > -tolIn && dS < tolOut && abs(dS) < best) { best = abs(dS); axis = vec3(0.0, 0.0, -1.0); plane = bmin.z; face = 3; }
  if (inX && inY && dN > -tolIn && dN < tolOut && abs(dN) < best) { best = abs(dN); axis = vec3(0.0, 0.0, 1.0); plane = bmax.z; face = 4; }
  // roofs keep a short reach: a merged box top can sit far above a real roof, and lifting
  // that roof up to it would hang a sheet of photogrammetry in the sky
  if (uSnapTop > 0.5 && inX && inZ && dT > -${SNAP_OUT_M}.0 && dT < ${SNAP_OUT_M}.0 && abs(dT) < best) { best = abs(dT); axis = vec3(0.0, 1.0, 0.0); plane = bmax.y; face = 5; }
  return best;
}
`;

/**
 * Facade snap (Best 3D): the vertex's cell and its eight neighbours name
 * candidate collider boxes (a wall can stand in the cell of the low plaza box
 * next to it); the vertex moves onto the nearest outer face among them when
 * it is within the catch zone: SNAP_REACH_IN_CELLS inside, since the box is
 * the cell-quantized hull and the real wall sits anywhere inside its face,
 * and SNAP_REACH_OUT_CELLS outside, since the road corridor carves a wall's
 * own cells off its box and a diagonal street leaves a stair of boxes behind
 * one straight facade. The zone is wide on purpose: whatever stands upright
 * in front of a wall is what the wall should look like. The one exclusion is
 * kerb-height geometry on an OSM road cell, which is parked cars. The
 * photogrammetry texture rides along on the vertex, so the wall the car hits
 * is the wall the player sees, and nothing slides as the camera moves.
 * Geometry that started nearest the face lands a hair further out, so the
 * real facade wins the depth test over anything deeper that snapped with it.
 * Snapped vertices skip flattening.
 */
const VERTEX_SNAP = `
vec3 cSnapDelta = vec3(0.0);
vSnapped = 0.0;
vSnapFace = -1.0;
vSnapFaceS = -1.0;
// kerb-height geometry on an OSM road cell is a parked car: never a wall
if (uSnap > 0.5 && !(vClutterRiseVal < uClutterRise && texelFetch(uSnapIds, min(ivec2(clamp(cwp.xz / uClutterField.x + 0.5, 0.0, 1.0) * vec2(textureSize(uSnapIds, 0))), textureSize(uSnapIds, 0) - 1), 0).g > 0.5)) {
  vec2 suv = clamp(cwp.xz / uClutterField.x + 0.5, 0.0, 1.0);
  ivec2 sn = textureSize(uSnapIds, 0);
  ivec2 sc0 = min(ivec2(suv * vec2(sn)), sn - 1);
  float tolOut = uSnapIn * ${SNAP_REACH_OUT_CELLS};
  float tolIn = uSnapIn * ${SNAP_REACH_IN_CELLS};
  float best = 1e9;
  vec3 axis = vec3(0.0), bmin = vec3(0.0), bmax = vec3(0.0);
  float plane = 0.0;
  int bestId = -1, bestFace = 0;
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      ivec2 sci = clamp(sc0 + ivec2(ox, oy), ivec2(0), sn - 1);
      int sid = int(texelFetch(uSnapIds, sci, 0).r) - 1;
      if (sid < 0 || sid == bestId) continue;
      ivec2 bxy = ivec2((sid - (sid / ${BOXES_PER_ROW}) * ${BOXES_PER_ROW}) * 2, sid / ${BOXES_PER_ROW});
      vec3 cmin = texelFetch(uSnapBoxes, bxy, 0).xyz;
      vec3 cmax = texelFetch(uSnapBoxes, bxy + ivec2(1, 0), 0).xyz;
      vec3 cAxis; float cPlane; int cFace;
      float d = snapFace(cwp, cmin, cmax, tolOut, tolIn, cAxis, cPlane, cFace);
      // ponytail: the road carve leaves single-cell pillars along the kerb; a wall must not tear
      // between a pillar 2 m away and its own box 12 m back, so a pillar only wins with nothing else near
      if (min(cmax.x - cmin.x, cmax.z - cmin.z) < 6.0) d += uSnapIn;
      if (d < best) { best = d; axis = cAxis; plane = cPlane; bmin = cmin; bmax = cmax; bestId = sid; bestFace = cFace; }
    }
  }
  if (bestId >= 0) {
    float lift = 0.02 + 0.03 * max(0.0, 1.0 - best / uSnapIn);
    vec3 a = abs(axis);
    vec3 target = cwp * (1.0 - a) + a * plane + axis * lift;
    // nothing past the face's own edges: a vertex beyond the corner folds onto it
    target.xz = clamp(target.xz, bmin.xz - lift, bmax.xz + lift);
    cSnapDelta = target - cwp;
    vSnapped = 1.0;
    // the key is the plane, not the box: neighbouring boxes share flush faces, and a
    // facade running along them is one wall; same axis, planes a step apart, still one wall
    vSnapFace = float(bestFace) * 100000.0 + floor(plane * 4.0);
    vSnapFaceS = vSnapFace;
    cClutterDy = 0.0;
    vClutterFlat = 0.0;
  }
}
`;

/**
 * After begin_vertex: bilinear ground lookup matching Heightfield.sample,
 * then the world-Y drop to apply. The drop is applied in view space after
 * project_vertex so no inverse model matrix is needed.
 */
const VERTEX_BODY = `
float cClutterDy = 0.0;
vClutterRiseVal = 0.0;
vClutterStructure = 1.0;
vClutterFlat = 0.0;
vClutterOpenFlat = 0.0;
vec3 cwp = (modelMatrix * vec4(transformed, 1.0)).xyz;
vClutterWorldPos = cwp;
if (uClutterMode > 0.5) {
  vec2 cuv = clamp(cwp.xz / uClutterField.x + 0.5, 0.0, 1.0);
  // an R8 UNSIGNED_BYTE texture samples normalised, so the mask's 1 reads as 1/255:
  // scale back up before comparing, bilinear blends between cells still land in 0..1
  float cStructure = min(1.0, texture2D(uClutterMask, cuv).r * 255.0);
  vClutterStructure = cStructure;
  vec2 cf = cuv * uClutterField.y;
  vec2 c0 = min(floor(cf), uClutterField.y - 1.0);
  vec2 ct = cf - c0;
  ivec2 ci = ivec2(c0);
  float cg = mix(
    mix(texelFetch(uClutterGround, ci, 0).r, texelFetch(uClutterGround, ci + ivec2(1, 0), 0).r, ct.x),
    mix(texelFetch(uClutterGround, ci + ivec2(0, 1), 0).r, texelFetch(uClutterGround, ci + ivec2(1, 1), 0).r, ct.x),
    ct.y);
  float crise = cwp.y - cg;
  vClutterRiseVal = crise;
  bool cStreet = cStructure < 0.5;
  bool cFlatten = uClutterMode > 0.5;
  if (cFlatten && cStreet && abs(crise) < uClutterRise) cClutterDy = -crise;
  if (cStreet && abs(crise) < uClutterRise) vClutterFlat = 1.0;
}
`;

/** Lit materials only: a flattened vertex is lit as road, not as the car side it came from. */
const VERTEX_NORMAL = `
#ifndef FLAT_SHADED
if (cClutterDy != 0.0) vNormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
#endif
`;

const VERTEX_PROJECT = `
mvPosition.xyz += (viewMatrix * vec4(cSnapDelta.x, cClutterDy + cSnapDelta.y, cSnapDelta.z, 0.0)).xyz;
gl_Position = projectionMatrix * mvPosition;
`;

const FRAGMENT_PARS = `
uniform sampler2D uClutterMask;
uniform vec2 uClutterField;
uniform float uClutterMode;
uniform float uClutterRise;
uniform float uSnap;
varying vec3 vClutterWorldPos;
varying float vClutterRiseVal;
varying float vClutterStructure;
varying float vClutterFlat;
varying float vClutterOpenFlat;
varying float vSnapped;
flat varying float vSnapFace;
varying float vSnapFaceS;
`;

/**
 * Hidden: sharp fragment-stage structure mask lookup so the cut follows building footprints exactly.
 * Only ground-level road clutter (< uClutterRise) is discarded; building walls and roofs are preserved.
 * Swept: the flag interpolates to exactly 1 only when all three vertices flattened, a car, not a wall's base;
 * and any triangle with a vertex flattened in the open goes whole, so nothing tents up from the road.
 */
const FRAGMENT_CUT = `
if (uClutterMode > 2.5) {
  if (vClutterFlat > 0.999) discard;
} else if (uClutterMode > 1.5) {
  if (vClutterFlat > 0.999) discard;
}
// snap: a triangle with only some vertices snapped, or with vertices on planes more than
// 15 m apart (a trolley wire strung between two buildings), is a shard stretched across
// the street, so it goes; one bridging two steps of a stair of boxes behind a diagonal
// facade stays. Outside structure cells only snapped facades and flattened road decals
// survive, so nothing tall is drawn that the car could drive through
if (uSnap > 0.5) {
  if (vSnapped > 0.001 && vSnapped < 0.999) discard;
  if (vSnapped > 0.999 && abs(vSnapFaceS - vSnapFace) > 60.0) discard;
  if (vSnapped < 0.999 && vClutterStructure < 0.5 && vClutterFlat < 0.999) discard;
}
`;

type Patchable = Material & { _clutterPatched?: boolean };

function groundTexture(hf: Heightfield): DataTexture {
  const n = hf.segs + 1;
  const tex = new DataTexture(hf.raw, n, n, RedFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function idTexture(data: Float32Array, n: number): DataTexture {
  const tex = new DataTexture(data, n, n, RGFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function maskTexture(cells: Uint8Array, n: number): DataTexture {
  const tex = new DataTexture(cells, n, n, RedFormat, UnsignedByteType);
  // linear so the flatten boundary sits between cell centres instead of stepping per 10 m cell
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Cell -> collider index + 1 (0 = none), the box's footprint cells plus a
 * SNAP_RING_CELLS ring so a facade standing well outside its carved box still
 * finds it. Footprint cells win over a neighbour's ring, nearer rings over
 * farther ones.
 */
export function snapIdGrid(boxes: readonly BuildingCollider[], grid: Grid): Float32Array {
  const { n, cell, half } = grid;
  const ids = new Float32Array(n * n);
  const clampI = (v: number) => Math.min(n - 1, Math.max(0, v));
  const fill = (ring: number, overwrite: boolean) => {
    for (let k = 0; k < boxes.length; k++) {
      const b = boxes[k]!;
      const i0 = clampI(Math.floor((b.min.x + half) / cell) - ring);
      const i1 = clampI(Math.floor((b.max.x - 1e-3 + half) / cell) + ring);
      const j0 = clampI(Math.floor((b.min.z + half) / cell) - ring);
      const j1 = clampI(Math.floor((b.max.z - 1e-3 + half) / cell) + ring);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const c = j * n + i;
          if (overwrite || ids[c] === 0) ids[c] = k + 1;
        }
      }
    }
  };
  fill(0, true);
  for (let r = 1; r <= SNAP_RING_CELLS; r++) fill(r, false);
  return ids;
}

/** Interleave the id map with the OSM road mask (1 = road corridor) into RG texels. */
function snapIdData(ids: Float32Array, roads: Uint8Array | null): Float32Array {
  const data = new Float32Array(ids.length * 2);
  for (let c = 0; c < ids.length; c++) {
    data[c * 2] = ids[c]!;
    data[c * 2 + 1] = roads && roads[c] === 1 ? 1 : 0;
  }
  return data;
}

function snapBoxTexture(boxes: readonly BuildingCollider[]): DataTexture {
  const rows = Math.max(1, Math.ceil(boxes.length / BOXES_PER_ROW));
  const data = new Float32Array(BOXES_PER_ROW * 2 * rows * 4);
  for (let k = 0; k < boxes.length; k++) {
    const b = boxes[k]!;
    const o = ((k % BOXES_PER_ROW) * 2 + Math.floor(k / BOXES_PER_ROW) * BOXES_PER_ROW * 2) * 4;
    data[o] = b.min.x; data[o + 1] = b.min.y; data[o + 2] = b.min.z;
    data[o + 4] = b.max.x; data[o + 5] = b.max.y; data[o + 6] = b.max.z;
  }
  const tex = new DataTexture(data, BOXES_PER_ROW * 2, rows, RGBAFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export class TileClutterFilter {
  private readonly uMode = { value: 0 };
  private readonly uGround: { value: DataTexture };
  private readonly uMask: { value: DataTexture };
  private readonly uField: { value: Vector2 };
  private readonly uRise: { value: number };
  private readonly uTall = { value: CLUTTER_TALL_M / CLUTTER_RISE_M };
  private readonly uSnap = { value: 0 };
  private readonly uSnapIn = { value: 10 };
  private readonly uSnapTop = { value: 1 };
  private readonly uSnapIds: { value: DataTexture };
  private readonly uSnapBoxes: { value: DataTexture };

  /**
   * @param ground the physics heightfield; its buffer is wrapped, call groundChanged() after copyFrom
   * @param structure n*n cell mask, 1 = building/deck/ramp; wrapped, call maskChanged() after a rebuild
   * @param n mask side in cells (the collider Grid's n)
   * @param riseScale world units per real metre of height (reliefBoost)
   */
  constructor(ground: Heightfield, structure: Uint8Array, n: number, riseScale = 1) {
    if (structure.length !== n * n) throw new Error(`structure mask length ${structure.length} != n^2 ${n * n}`);
    this.uGround = { value: groundTexture(ground) };
    this.uMask = { value: maskTexture(structure, n) };
    this.uField = { value: new Vector2(ground.size, ground.segs) };
    this.uRise = { value: CLUTTER_RISE_M * riseScale };
    this.uSnapIds = { value: idTexture(new Float32Array(2), 1) };
    this.uSnapBoxes = { value: snapBoxTexture([]) };
  }

  /** Snap tile facades onto the collider boxes (Best 3D); off leaves the tiles where they are. */
  get snap(): boolean {
    return this.uSnap.value > 0.5;
  }

  set snap(on: boolean) {
    this.uSnap.value = on ? 1 : 0;
  }

  /**
   * Also pull roof geometry up onto the box top. Off when the boxes are drawn
   * at their per-cell roof heights: a merged box's top can be 80 m above a low
   * building's real roof, and a roof lifted there would float over the columns.
   */
  get snapRoofs(): boolean {
    return this.uSnapTop.value > 0.5;
  }

  set snapRoofs(on: boolean) {
    this.uSnapTop.value = on ? 1 : 0;
  }

  /**
   * The colliders were rebuilt: refresh the cell -> box map and box bounds the snap reads.
   * `roads` is the OSM corridor mask on the same grid (kerb-height geometry there is parked cars).
   */
  setSnapBoxes(boxes: readonly BuildingCollider[], grid: Grid, roads: Uint8Array | null = null): void {
    this.uSnapIn.value = grid.cell;
    this.uSnapIds.value.dispose();
    this.uSnapIds.value = idTexture(snapIdData(snapIdGrid(boxes, grid), roads), grid.n);
    this.uSnapBoxes.value.dispose();
    this.uSnapBoxes.value = snapBoxTexture(boxes);
  }

  get mode(): ClutterMode {
    return CLUTTER_MODES[this.uMode.value] ?? 'off';
  }

  set mode(m: ClutterMode) {
    this.uMode.value = CLUTTER_MODES.indexOf(m);
  }

  cycleMode(): ClutterMode {
    this.uMode.value = (this.uMode.value + 1) % CLUTTER_MODES.length;
    return this.mode;
  }

  /** The heightfield's buffer changed in place (ground refinement finished). */
  groundChanged(hf: Heightfield): void {
    if (hf.raw !== (this.uGround.value.image.data as unknown)) {
      this.uGround.value.dispose();
      this.uGround.value = groundTexture(hf);
      this.uField.value.set(hf.size, hf.segs);
    } else {
      this.uGround.value.needsUpdate = true;
    }
  }

  /** The structure mask buffer was refilled (colliders rebuilt). */
  maskChanged(): void {
    this.uMask.value.needsUpdate = true;
  }

  /** Update structure mask buffer and dimensions (e.g. when switching grid resolution). */
  updateStructureGrid(cells: Uint8Array, n: number): void {
    if (cells.length !== n * n) throw new Error(`structure mask length ${cells.length} != n^2 ${n * n}`);
    this.uMask.value.dispose();
    this.uMask.value = maskTexture(cells, n);
  }

  /** Patch every material under `root`; safe to call again, already-patched materials are skipped. */
  patch(root: Object3D): void {
    root.traverse(obj => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const m = mat as Patchable;
        if (m._clutterPatched) continue;
        m._clutterPatched = true;
        const prev = m.onBeforeCompile;
        m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
          prev?.call(m, shader, renderer);
          this.inject(shader);
          injectDetailGrain(shader);
        };
        m.needsUpdate = true;
      }
    });
  }

  private inject(shader: WebGLProgramParametersWithUniforms): void {
    shader.uniforms.uClutterGround = this.uGround;
    shader.uniforms.uClutterMask = this.uMask;
    shader.uniforms.uClutterMode = this.uMode;
    shader.uniforms.uClutterField = this.uField;
    shader.uniforms.uClutterRise = this.uRise;
    shader.uniforms.uClutterTall = this.uTall;
    shader.uniforms.uSnap = this.uSnap;
    shader.uniforms.uSnapIn = this.uSnapIn;
    shader.uniforms.uSnapTop = this.uSnapTop;
    shader.uniforms.uSnapIds = this.uSnapIds;
    shader.uniforms.uSnapBoxes = this.uSnapBoxes;
    const lit = shader.vertexShader.includes('#include <normal_pars_vertex>');
    shader.vertexShader = VERTEX_PARS + shader.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>' + VERTEX_BODY + VERTEX_SNAP + (lit ? VERTEX_NORMAL : ''))
      .replace('#include <project_vertex>', '#include <project_vertex>' + VERTEX_PROJECT);
    shader.fragmentShader = FRAGMENT_PARS + shader.fragmentShader
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + FRAGMENT_CUT);
  }

  dispose(): void {
    this.uGround.value.dispose();
    this.uMask.value.dispose();
    this.uSnapIds.value.dispose();
    this.uSnapBoxes.value.dispose();
  }
}
