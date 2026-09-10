/**
 * Detail texture for photo surfaces. Within a few car lengths of the camera a
 * satellite patch or a Google tile is magnified thirty times and turns to
 * smear; multiplying a tiling grey grain into the albedo gives the surface
 * back a texture at the scale the eye expects (the same trick every open-world
 * game uses for terrain up close). The grain is triplanar so facades get it
 * too, and fades to nothing past GRAIN_FADE_M so distant tiles are untouched.
 * One shared 256² texture, three cache-resident reads per fragment, no branch.
 */
import {
  DataTexture, RedFormat, UnsignedByteType, RepeatWrapping, LinearMipmapLinearFilter, LinearFilter,
  Vector2, type Material, type WebGLProgramParametersWithUniforms
} from 'three';

/** World metres one repeat of the grain covers. */
export const GRAIN_REPEAT_M = 6;
/** Albedo modulation at the camera, ± this fraction. */
export const GRAIN_STRENGTH = 0.28;
/** Fully on inside the first, gone past the second (metres from the camera). */
export const GRAIN_FADE_M: readonly [number, number] = [25, 110];

const GRAIN_PARS_VERTEX = `
varying vec3 vGrainWorld;
`;
const GRAIN_VERTEX = `
vGrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;
const GRAIN_PARS_FRAGMENT = `
uniform sampler2D uGrain;
uniform float uGrainScale;
uniform float uGrainStrength;
uniform vec2 uGrainFade;
varying vec3 vGrainWorld;
`;
/** After map_fragment, so diffuseColor already carries the photo. */
const GRAIN_FRAGMENT = `
{
  float gw = uGrainStrength * (1.0 - smoothstep(uGrainFade.x, uGrainFade.y, distance(vGrainWorld, cameraPosition)));
  vec3 gn = abs(normalize(cross(dFdx(vGrainWorld), dFdy(vGrainWorld))));
  vec3 gb = gn * gn * gn * gn;
  gb /= gb.x + gb.y + gb.z;
  vec3 gp = vGrainWorld * uGrainScale;
  float g = texture2D(uGrain, gp.yz).r * gb.x + texture2D(uGrain, gp.xz).r * gb.y + texture2D(uGrain, gp.xy).r * gb.z;
  diffuseColor.rgb *= 1.0 + (g - 0.5) * 2.0 * gw;
}
`;

let grainTex: DataTexture | null = null;

/** Deterministic value noise, two octaves, centred on 0.5. */
function grainTexture(): DataTexture {
  if (grainTex) return grainTex;
  const n = 256;
  const data = new Uint8Array(n * n);
  let s = 12345;
  const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  /** Value noise with `cells` lattice points across the texture, tiling. */
  const octave = (cells: number): Float32Array => {
    const lat = new Float32Array(cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    const out = new Float32Array(n * n);
    const step = n / cells;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const fx = x / step, fy = y / step;
        const x0 = Math.floor(fx) % cells, y0 = Math.floor(fy) % cells;
        const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
        const tx = smooth(fx - Math.floor(fx)), ty = smooth(fy - Math.floor(fy));
        out[y * n + x] = lerp(
          lerp(lat[y0 * cells + x0]!, lat[y0 * cells + x1]!, tx),
          lerp(lat[y1 * cells + x0]!, lat[y1 * cells + x1]!, tx), ty);
      }
    }
    return out;
  };
  // ~40 cm patches, ~10 cm pebbles, then per-texel grit: what asphalt and
  // dirt look like from a car window, at the scale the chase camera sees
  const o1 = octave(16), o2 = octave(64);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const k = y * n + x;
      const v = 0.5 + (o1[k]! - 0.5) * 0.9 + (o2[k]! - 0.5) * 0.6 + (rnd() - 0.5) * 0.35;
      data[y * n + x] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  grainTex = new DataTexture(data, n, n, RedFormat, UnsignedByteType);
  grainTex.wrapS = grainTex.wrapT = RepeatWrapping;
  grainTex.minFilter = LinearMipmapLinearFilter;
  grainTex.magFilter = LinearFilter;
  grainTex.generateMipmaps = true;
  grainTex.needsUpdate = true;
  return grainTex;
}

const uniforms = {
  uGrain: { get value() { return grainTexture(); } },
  uGrainScale: { value: 1 / GRAIN_REPEAT_M },
  uGrainStrength: { value: GRAIN_STRENGTH },
  uGrainFade: { value: new Vector2(GRAIN_FADE_M[0], GRAIN_FADE_M[1]) }
};

/** Inject into a compiling program; works for basic and standard materials alike. */
export function injectDetailGrain(shader: WebGLProgramParametersWithUniforms): void {
  if (!shader.fragmentShader.includes('#include <map_fragment>')) return;
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = GRAIN_PARS_VERTEX + shader.vertexShader
    .replace('#include <begin_vertex>', '#include <begin_vertex>' + GRAIN_VERTEX);
  shader.fragmentShader = GRAIN_PARS_FRAGMENT + shader.fragmentShader
    .replace('#include <map_fragment>', '#include <map_fragment>' + GRAIN_FRAGMENT);
}

/** Patch a material that owns its own onBeforeCompile slot (ground patches, terrain). */
export function patchDetailGrain<M extends Material>(m: M): M {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer);
    injectDetailGrain(shader);
  };
  m.customProgramCacheKey = () => 'grain';
  return m;
}
