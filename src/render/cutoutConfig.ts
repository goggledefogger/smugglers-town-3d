/**
 * Cutout 3D's tuning constants, moved out of main.ts unchanged. The mutable
 * stencil state (dirty flags, worker, last mask) stays in main.ts.
 *
 * URL overrides, all read here and nowhere else:
 *   ?cutoutRoofMin=<m>  roofed-over rule height (CUTOUT_ROOF_MIN_M)
 *   ?cutoutDebug=1      draw the walls the car can hit (CUTOUT_DEBUG_AT_START)
 *   ?cutoutDilate=<m>   stencil dilation (CUTOUT_DILATE_M)
 *   ?cutoutTexel=<m>    stencil texel (cutoutDeviceSettings)
 *   ?cutoutCap=1|0      roof cap on or off (cutoutDeviceSettings)
 */
import { ROOF_MIN_M } from '../services/overture/footprintMask.ts';

const params = new URLSearchParams(window.location.search);

/**
 * Cutout 3D's roofed-over rule (m): a classifier gap group fills the stencil, and a classifier box
 * collides before the stencil lands, only if some cell's lowest geometry stands this far above the
 * ground, so poles, trees and steps over open paving do not. ?cutoutRoofMin= overrides for tuning.
 */
export const CUTOUT_ROOF_MIN_M = ((): number => {
  const q = Number(params.get('cutoutRoofMin') ?? '');
  return Number.isFinite(q) && q > 0 ? q : ROOF_MIN_M;
})();
/** ?cutoutDebug=1 / window.__cutoutDebug(on): draw the walls the car can hit, coloured by source. */
export const CUTOUT_DEBUG_AT_START = params.get('cutoutDebug') === '1';
/**
 * Cutout 3D stencil dilation (m): grows each footprint so leaning facades and overhangs are not
 * shaved. 2, not 1.5: in SF (Market and Montgomery) tile geometry over 18 m up left outside the
 * stencil fell from 7.6% at 1.5 m to 3.9% at 2 m with no extra kerb clutter. ?cutoutDilate= overrides.
 */
export const CUTOUT_DILATE_M = Number(params.get('cutoutDilate') ?? '') || 2;

export interface CutoutDeviceSettings {
  /** 4 or fewer cores, 4 GB or less, or a max texture under 4096 */
  weakDevice: boolean;
  /**
   * Cutout 3D stencil texel (m). 1 m normally; 2 m on a device that looks weak, which
   * quarters the raster, the 13 MB upload and the texture memory. ?cutoutTexel= overrides.
   */
  texelM: number;
  /**
   * Cutout 3D roof cap: the stencil goes RG8, G the footprint's roof plus
   * CUTOUT_ROOF_MARGIN_M, and canopy above it is cut. Doubles the upload
   * (26 MB at 1 m), so a weak device keeps the R8 stencil (3.2 MB at 2 m)
   * uncapped. ?cutoutCap=1 / 0 overrides.
   */
  roofCap: boolean;
}

/** The settings that hang on the device; the max texture size comes from the live renderer. */
export function cutoutDeviceSettings(maxTextureSize: number): CutoutDeviceSettings {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const weakDevice = (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4
    || maxTextureSize < 4096;
  const texelQ = Number(params.get('cutoutTexel') ?? '');
  const texelM = texelQ > 0 ? texelQ : weakDevice ? 2 : 1;
  const capQ = params.get('cutoutCap');
  const roofCap = capQ === '1' ? true : capQ === '0' ? false : !weakDevice;
  return { weakDevice, texelM, roofCap };
}

/** Metres above the sampled roof that survive the cap: parapets, rooftop units, the dilation band's roof edge. */
export const CUTOUT_ROOF_MARGIN_M = 3;
/**
 * How far (m) a footprint grows into the connected mesh the height field calls a building: registration
 * (1-3 m) plus an unmapped bay or wing. Reasoned, not measured: `grownTruncated` in the stats says if it is
 * short. Off at a 2 m texel (a weak device keeps the polygon), where the field is not read 1:1.
 */
export const CUTOUT_GROW_M = 8;
/**
 * How far (m) the skirt runs out past the grown footprints into mesh that rises 1.5-3 m (the hysteresis floor up
 * to the keep rise) and is not kept: the strip at a wall's foot, a plinth, steps, an entrance canopy. Without it
 * that strip is cut and the satellite ground shows through a band at the base of the wall. Off with growth at a
 * 2 m texel. `skirted` in the stats counts it.
 */
export const CUTOUT_SKIRT_M = 3;
/** A classifier building cell with an Overture texel this close (m) is covered; farther, it is a gap. */
export const CUTOUT_GAP_REACH_M = 3;
/** Streaming tiles rewrite the classifier grid every collider pass: the stencil follows at most this often. */
export const CUTOUT_REBUILD_MS = 2000;
/** A footprint the mesh rises less than this over (m) is not stencilled: an empty lot or a shed. */
export const CUTOUT_MIN_RISE_M = 3;
