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
 * Every patched material shares the same uniform objects: switching modes is
 * a value write, and both textures wrap the buffers physics owns, so a ground
 * refinement or collider rebuild is a re-upload, never a recompile.
 */
import {
  DataTexture, RedFormat, FloatType, UnsignedByteType, NearestFilter, LinearFilter,
  ClampToEdgeWrapping, Vector2,
  type Object3D, type Mesh, type Material, type WebGLProgramParametersWithUniforms
} from 'three';
import type { Heightfield } from '../core/heightfield.ts';
import { injectDetailGrain } from './DetailGrain.ts';

export type ClutterMode = 'off' | 'flatten' | 'hidden' | 'swept';
/** Index order is baked into the shader's mode comparisons: append, never reorder. */
export const CLUTTER_MODES: readonly ClutterMode[] = ['off', 'flatten', 'hidden', 'swept'];

/** Real metres above the ground estimate under which tile geometry is street clutter (a car is ~1.5 m). */
export const CLUTTER_RISE_M = 2.5;
/** Swept only: with no structure cell within bilinear reach, tall enough to take buses and RVs too. */
export const CLUTTER_TALL_M = 6;

const VERTEX_PARS = `
uniform sampler2D uClutterGround;
uniform sampler2D uClutterMask;
uniform float uClutterMode;
uniform vec2 uClutterField;
uniform float uClutterRise;
uniform float uClutterTall;
varying vec3 vClutterWorldPos;
varying float vClutterStructure;
varying float vClutterFlat;
varying float vClutterOpenFlat;
`;

/**
 * After begin_vertex: bilinear ground lookup matching Heightfield.sample,
 * then the world-Y drop to apply. The drop is applied in view space after
 * project_vertex so no inverse model matrix is needed.
 */
const VERTEX_BODY = `
float cClutterDy = 0.0;
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
  bool cStreet = cStructure < 0.5;
  bool cFlatten = uClutterMode < 1.5 || uClutterMode > 2.5;
  if (cFlatten && cStreet && abs(crise) < uClutterRise) cClutterDy = -crise;
  if (cStreet && abs(crise) < uClutterRise * (cStructure > 0.0 ? 1.0 : uClutterTall)) vClutterFlat = 1.0;
  // flattened with no structure in reach: a triangle from here up to a tree or
  // a sign is a dark tent over the road, not the base of a wall
  if (cFlatten && cStreet && cStructure <= 0.0 && abs(crise) < uClutterRise * uClutterTall) vClutterOpenFlat = 1.0;
}
`;

/** Lit materials only: a flattened vertex is lit as road, not as the car side it came from. */
const VERTEX_NORMAL = `
#ifndef FLAT_SHADED
if (cClutterDy != 0.0) vNormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
#endif
`;

const VERTEX_PROJECT = `
mvPosition.xyz += (viewMatrix * vec4(0.0, cClutterDy, 0.0, 0.0)).xyz;
gl_Position = projectionMatrix * mvPosition;
`;

const FRAGMENT_PARS = `
uniform sampler2D uClutterMask;
uniform vec2 uClutterField;
uniform float uClutterMode;
varying vec3 vClutterWorldPos;
varying float vClutterStructure;
varying float vClutterFlat;
varying float vClutterOpenFlat;
`;

/**
 * Hidden: sharp fragment-stage structure mask lookup so the cut follows building footprints exactly.
 * Swept: the flag interpolates to exactly 1 only when all three vertices flattened, a car, not a wall's base;
 * and any triangle with a vertex flattened in the open goes whole, so nothing tents up from the road.
 */
const FRAGMENT_CUT = `
if (uClutterMode > 2.5) {
  if (vClutterFlat > 0.999 || vClutterOpenFlat > 0.0) discard;
} else if (uClutterMode > 1.5) {
  vec2 fUv = clamp(vClutterWorldPos.xz / uClutterField.x + 0.5, 0.0, 1.0);
  float fStructure = texture2D(uClutterMask, fUv).r * 255.0;
  if (fStructure < 0.5) discard;
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

function maskTexture(cells: Uint8Array, n: number): DataTexture {
  const tex = new DataTexture(cells, n, n, RedFormat, UnsignedByteType);
  // linear so the flatten boundary sits between cell centres instead of stepping per 10 m cell
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
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
    const lit = shader.vertexShader.includes('#include <normal_pars_vertex>');
    shader.vertexShader = VERTEX_PARS + shader.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>' + VERTEX_BODY + (lit ? VERTEX_NORMAL : ''))
      .replace('#include <project_vertex>', '#include <project_vertex>' + VERTEX_PROJECT);
    shader.fragmentShader = FRAGMENT_PARS + shader.fragmentShader
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + FRAGMENT_CUT);
  }

  dispose(): void {
    this.uGround.value.dispose();
    this.uMask.value.dispose();
  }
}
