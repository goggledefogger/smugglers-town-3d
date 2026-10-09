/**
 * Contrast-adaptive sharpening (AMD FidelityFX CAS, per channel) of the Google
 * tile albedo near the camera. Photogrammetry textures are magnified many times
 * at street level and read as smear; CAS steepens the edges that are already in
 * the texture without inventing detail, and backs off where local contrast is
 * already high so it does not ring.
 *
 * Runs right after map_fragment, before the detail grain multiplies in. Reuses
 * the grain's world-position varying and its fade (uGrainFade), so it must be
 * injected after injectDetailGrain on the same shader. Four extra texture reads
 * (the axis neighbours; the centre is map_fragment's own sample), skipped
 * entirely when the strength or the fade is zero, so uSharpen = 0 leaves the
 * albedo bit-exact.
 */
import type { WebGLProgramParametersWithUniforms } from 'three';
import { TILE_SHARPEN_AT_START } from './lookConfig.ts';

/**
 * Negative-lobe weight at full strength: -1/5 is the strongest CAS allows (its
 * sharpness 1). The lobe scales linearly with strength * fade, so the output is
 * continuous down to 0 (CAS's own sharpness 0 is still -1/8, not off).
 */
const CAS_MAX_LOBE = 0.2;

const SHARPEN_PARS_FRAGMENT = `
uniform float uSharpen;
`;

/**
 * After map_fragment, where diffuseColor.rgb == diffuse * sampledDiffuseColor.rgb
 * (color_fragment comes later). The derivatives are taken outside the branch so
 * the neighbour reads stay well defined in non-uniform control flow.
 */
export const SHARPEN_FRAGMENT = `
#ifdef USE_MAP
{
  vec2 sdx = dFdx(vMapUv), sdy = dFdy(vMapUv);
  float sw = uSharpen * (1.0 - smoothstep(uGrainFade.x, uGrainFade.y, distance(vGrainWorld, cameraPosition)));
  if (sw > 0.0) {
    vec2 tx = 1.0 / vec2(textureSize(map, 0));
    vec3 c = sampledDiffuseColor.rgb;
    vec3 n = textureGrad(map, vMapUv + vec2(0.0, tx.y), sdx, sdy).rgb;
    vec3 s = textureGrad(map, vMapUv - vec2(0.0, tx.y), sdx, sdy).rgb;
    vec3 e = textureGrad(map, vMapUv + vec2(tx.x, 0.0), sdx, sdy).rgb;
    vec3 w = textureGrad(map, vMapUv - vec2(tx.x, 0.0), sdx, sdy).rgb;
    vec3 mn = min(c, min(min(n, s), min(e, w)));
    vec3 mx = max(c, max(max(n, s), max(e, w)));
    vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
    vec3 wt = amp * (-${CAS_MAX_LOBE.toFixed(4)} * sw);
    vec3 sharp = clamp((c + (n + s + e + w) * wt) / (1.0 + 4.0 * wt), 0.0, 1.0);
    diffuseColor.rgb = diffuse * sharp;
  }
}
#endif
`;

/** One uniform object shared by every tile program, so setting it retunes them all at once. */
const uSharpen = { value: TILE_SHARPEN_AT_START };

export function getTileSharpen(): number { return uSharpen.value; }
export function setTileSharpen(v: number): void { uSharpen.value = Math.max(0, Math.min(1, v)); }

/** Inject into a tile program that already has the detail grain (it reads vGrainWorld and uGrainFade). */
export function injectTileSharpen(shader: WebGLProgramParametersWithUniforms): void {
  if (!shader.fragmentShader.includes('#include <map_fragment>')) return;
  if (!shader.fragmentShader.includes('varying vec3 vGrainWorld')) return;
  shader.uniforms.uSharpen = uSharpen;
  shader.fragmentShader = SHARPEN_PARS_FRAGMENT + shader.fragmentShader
    .replace('#include <map_fragment>', '#include <map_fragment>' + SHARPEN_FRAGMENT);
}
