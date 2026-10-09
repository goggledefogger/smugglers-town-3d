/**
 * Look settings for the photo tiles that are not Cutout-specific (cutoutConfig.ts
 * is Cutout 3D's stencil tuning only).
 *
 * URL overrides, all read here and nowhere else:
 *   ?sharpen=<0..1>   tile albedo sharpening strength (TILE_SHARPEN_DEFAULT); 0 turns it off
 */

/** Contrast-adaptive sharpening of Google tile albedo near the camera, in [0, 1]. */
export const TILE_SHARPEN_DEFAULT = 0.5;

/** A strength from anywhere (URL, console) clamped to [0, 1]; null when it is not a number. */
export function clampSharpen(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

/** The strength at start: ?sharpen= if it parses, else the default. */
export const TILE_SHARPEN_AT_START = ((): number => {
  if (typeof window === 'undefined') return TILE_SHARPEN_DEFAULT;
  return clampSharpen(new URLSearchParams(window.location.search).get('sharpen')) ?? TILE_SHARPEN_DEFAULT;
})();
