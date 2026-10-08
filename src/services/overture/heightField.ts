/**
 * The Cutout height field: one persistent byte per 1 m texel over the 3600 m stencil square, x,z from -1800,
 * fed by 900 m chunks that HeightCapture renders top-down on the GPU (docs/plans/2026-10-08-cutout-per-texel-heights.md).
 *
 * Byte layout:
 *   bits 0-5  rise above the 10 m tileset terrain: 0..31 is 0-15.5 m in 0.5 m steps, 32..62 is 16-61 m in 1.5 m
 *             steps (a coarse step stands for its centre; `riseTopAt` gives its top), 63 = unknown
 *   bit 6     "rough": not planar along both x and z (|y(i-1) + y(i+1) - 2y(i)| >= 1 m, an unkept neighbour
 *             counting as not planar). Flat and pitched roofs are planar both ways, a parapet or ridge one way,
 *             canopy neither. Only ever set on kept texels
 *   bit 7     "kept": the hysteresis flag. On at a rise of `keepRiseM` or more, off once the rise falls
 *             below half of it (3.0 m / 1.5 m at the default relief), and in between it stays as it was.
 * A texel that is measured as unknown (no fine tile drew there) keeps its previous byte, so a tile
 * streaming out never erases what it showed. A texel never measured is byte 63 (unknown, not kept).
 *
 * Pure data, no DOM, so the worker wraps it and the tests run it in node.
 */

export const HEIGHT_N = 3600;
export const HEIGHT_ORIGIN = -1800;
export const HEIGHT_CHUNK_M = 900;
export const HEIGHT_CHUNKS = 4;
/** The rise bits' value for "no measurement". */
export const RISE_UNKNOWN = 63;
export const RISE_MASK = 63;
export const ROUGH_BIT = 64;
export const KEPT_BIT = 128;
export const RISE_STEP_M = 0.5;
/** Steps 0..31 are fine (0.5 m); 32..62 are coarse. */
export const RISE_FINE_STEPS = 32;
export const RISE_COARSE_STEP_M = 1.5;
/** Largest stored step: 16 + 30 * 1.5 = 61 m. */
export const RISE_MAX_STEP = 62;
/** Second difference (m) at which a texel is not planar along an axis. */
export const ROUGH_SECOND_DIFF_M = 1;

/** A rise in metres as its 6-bit step: fine below 15.75 m, coarse above, clamped at 61 m. */
export function encodeRise(rise: number): number {
  const q = Math.round(rise / RISE_STEP_M);
  if (q < RISE_FINE_STEPS) return Math.max(0, q);
  return Math.min(RISE_MAX_STEP, RISE_FINE_STEPS + Math.max(0, Math.round((rise - 16) / RISE_COARSE_STEP_M)));
}

/** A step back to metres (a coarse step's centre). */
export function decodeRise(q: number): number {
  return q < RISE_FINE_STEPS ? q * RISE_STEP_M : 16 + (q - RISE_FINE_STEPS) * RISE_COARSE_STEP_M;
}

/** A step's top in metres: caps must not sit under the roof a coarse step stands for. */
export function decodeRiseTop(q: number): number {
  return q < RISE_FINE_STEPS ? q * RISE_STEP_M : decodeRise(q) + RISE_COARSE_STEP_M / 2;
}

/**
 * The 10 m tileset terrain the rise is measured from: the raw nodes of a `Heightfield` (segs+1 per side,
 * row-major, world [-size/2, size/2]^2), copied once per tileset.
 */
export interface HeightTerrain {
  readonly size: number;
  readonly segs: number;
  readonly data: Float32Array;
}

export interface HeightField {
  readonly data: Uint8Array;
  /** per chunk: how many measurements have landed (0 = never captured) */
  readonly chunkSeen: Uint32Array;
  /** bumped by every applied chunk */
  version: number;
}

export interface HeightChunkStats {
  /** texels of this chunk with any measurement (byte != unknown) */
  readonly known: number;
  /** texels of this chunk with the kept bit */
  readonly kept: number;
  /** texels of this chunk with the rough bit */
  readonly rough: number;
  /** texels whose kept or rough bit flipped in this application: the stencil must re-raster */
  readonly changed: number;
}

export function createHeightField(): HeightField {
  return {
    data: new Uint8Array(HEIGHT_N * HEIGHT_N).fill(RISE_UNKNOWN),
    chunkSeen: new Uint32Array(HEIGHT_CHUNKS * HEIGHT_CHUNKS),
    version: 0
  };
}

/** Bilinear terrain height at world (x, z), clamped to the edges, as Heightfield.sample. */
export function sampleTerrain(t: HeightTerrain, x: number, z: number): number {
  const seg = t.segs;
  const fx = Math.min(seg, Math.max(0, (x / t.size + 0.5) * seg));
  const fz = Math.min(seg, Math.max(0, (z / t.size + 0.5) * seg));
  const i0 = Math.floor(fx), j0 = Math.floor(fz);
  const i1 = Math.min(i0 + 1, seg), j1 = Math.min(j0 + 1, seg);
  const tx = fx - i0, tz = fz - j0;
  const w = seg + 1;
  const d = t.data;
  const a = d[j0 * w + i0]! + (d[j0 * w + i1]! - d[j0 * w + i0]!) * tx;
  const b = d[j1 * w + i0]! + (d[j1 * w + i1]! - d[j1 * w + i0]!) * tx;
  return a + (b - a) * tz;
}

/** `out[i]` = sampleTerrain at (x + i, z): one row of unit-spaced samples, the z weights worked out once. */
export function sampleTerrainRow(t: HeightTerrain, x: number, z: number, out: Float32Array): void {
  const seg = t.segs, w = seg + 1, d = t.data;
  const fz = Math.min(seg, Math.max(0, (z / t.size + 0.5) * seg));
  const j0 = Math.floor(fz), j1 = Math.min(j0 + 1, seg), tz = fz - j0;
  const r0 = j0 * w, r1 = j1 * w;
  for (let k = 0; k < out.length; k++) {
    const fx = Math.min(seg, Math.max(0, ((x + k) / t.size + 0.5) * seg));
    const i0 = Math.floor(fx), i1 = Math.min(i0 + 1, seg), tx = fx - i0;
    const a = d[r0 + i0]! + (d[r0 + i1]! - d[r0 + i0]!) * tx;
    const b = d[r1 + i0]! + (d[r1 + i1]! - d[r1 + i0]!) * tx;
    out[k] = a + (b - a) * tz;
  }
}

/** Chunk index (cj * 4 + ci) containing world (x, z), or -1 outside the square. */
export function chunkAt(x: number, z: number): number {
  const ci = Math.floor((x - HEIGHT_ORIGIN) / HEIGHT_CHUNK_M), cj = Math.floor((z - HEIGHT_ORIGIN) / HEIGHT_CHUNK_M);
  if (ci < 0 || cj < 0 || ci >= HEIGHT_CHUNKS || cj >= HEIGHT_CHUNKS) return -1;
  return cj * HEIGHT_CHUNKS + ci;
}

/**
 * Fold one measured chunk into the field. `worldY` is HEIGHT_CHUNK_M^2 floats, row = z ascending, column = x
 * ascending, texel (i, j) covering [x0+i, x0+i+1) x [z0+j, z0+j+1); NaN (or any non-finite value) is unknown.
 * `keepRiseM` is the rise at which a texel becomes kept (CUTOUT_MIN_RISE_M times the relief boost).
 * Two passes: rise and the kept hysteresis, then the rough bit from the floats (neighbours across a chunk seam,
 * or with no float this time, come from the field: their stored rise plus the terrain).
 */
export function applyHeightChunk(
  field: HeightField, chunk: number, worldY: Float32Array, terrain: HeightTerrain, keepRiseM: number
): HeightChunkStats {
  const m = HEIGHT_CHUNK_M;
  if (worldY.length !== m * m) throw new Error(`height chunk ${chunk}: ${worldY.length} texels, want ${m * m}`);
  const ci = chunk % HEIGHT_CHUNKS, cj = Math.floor(chunk / HEIGHT_CHUNKS);
  const x0 = HEIGHT_ORIGIN + ci * m, z0 = HEIGHT_ORIGIN + cj * m;
  const dropBelowM = keepRiseM / 2;
  const f = field.data;
  const before = new Uint8Array(m * m);
  const terrRow = new Float32Array(m);
  for (let j = 0; j < m; j++) {
    const row = (cj * m + j) * HEIGHT_N + ci * m;
    sampleTerrainRow(terrain, x0 + 0.5, z0 + j + 0.5, terrRow);
    for (let i = 0; i < m; i++) {
      const at = row + i;
      const old = f[at]!;
      before[j * m + i] = old & (KEPT_BIT | ROUGH_BIT);
      const y = worldY[j * m + i]!;
      const rise = Number.isFinite(y) ? y - terrRow[i]! : NaN;
      // a NaN terrain node makes the rise NaN: that is unknown, never a rise of 0
      if (!Number.isFinite(rise)) continue;
      let keep = old & KEPT_BIT;
      if (rise >= keepRiseM) keep = KEPT_BIT;
      else if (rise < dropBelowM) keep = 0;
      // rough is recomputed in the second pass; a texel that stopped being kept loses it now
      f[at] = encodeRise(rise) | keep | (keep ? old & ROUGH_BIT : 0);
    }
  }
  /** world Y at global texel (gi, gj): this chunk's float, else the field's stored rise over the terrain, else NaN */
  const yAt = (gi: number, gj: number): number => {
    const li = gi - ci * m, lj = gj - cj * m;
    if (li >= 0 && lj >= 0 && li < m && lj < m) {
      const y = worldY[lj * m + li]!;
      if (Number.isFinite(y)) return y;
    }
    const q = f[gj * HEIGHT_N + gi]! & RISE_MASK;
    return q === RISE_UNKNOWN ? NaN : decodeRise(q) + sampleTerrain(terrain, HEIGHT_ORIGIN + gi + 0.5, HEIGHT_ORIGIN + gj + 0.5);
  };
  const keptAt = (gi: number, gj: number): boolean =>
    gi >= 0 && gj >= 0 && gi < HEIGHT_N && gj < HEIGHT_N && (f[gj * HEIGHT_N + gi]! & KEPT_BIT) !== 0;
  const nonPlanar = (gi: number, gj: number, di: number, dj: number, y0: number): boolean => {
    if (!keptAt(gi - di, gj - dj) || !keptAt(gi + di, gj + dj)) return true;
    const d = yAt(gi - di, gj - dj) + yAt(gi + di, gj + dj) - 2 * y0;
    // a neighbour kept with no height to compare (NaN) is no evidence of planarity
    return !(Math.abs(d) < ROUGH_SECOND_DIFF_M);
  };
  const slowRough = (gi: number, gj: number): boolean => {
    const y0 = yAt(gi, gj);
    return Number.isFinite(y0) && nonPlanar(gi, gj, 1, 0, y0) && nonPlanar(gi, gj, 0, 1, y0);
  };
  let known = 0, kept = 0, rough = 0, changed = 0;
  for (let j = 0; j < m; j++) {
    const gj = cj * m + j;
    const row = gj * HEIGHT_N + ci * m;
    for (let i = 0; i < m; i++) {
      const at = row + i;
      let b = f[at]!;
      if (b & KEPT_BIT) {
        const gi = ci * m + i;
        let isRough: boolean;
        if (i > 0 && j > 0 && i < m - 1 && j < m - 1) {
          // inside the chunk, every neighbour kept with a float: straight from the arrays
          const k = j * m + i, y0 = worldY[k]!;
          const yl = worldY[k - 1]!, yr = worldY[k + 1]!, yu = worldY[k - m]!, yd = worldY[k + m]!;
          if ((f[at - 1]! & f[at + 1]! & f[at - HEIGHT_N]! & f[at + HEIGHT_N]! & KEPT_BIT)
            && Number.isFinite(y0 + yl + yr + yu + yd)) {
            isRough = !(Math.abs(yl + yr - 2 * y0) < ROUGH_SECOND_DIFF_M) && !(Math.abs(yu + yd - 2 * y0) < ROUGH_SECOND_DIFF_M);
          } else {
            isRough = slowRough(gi, gj);
          }
        } else {
          isRough = slowRough(gi, gj);
        }
        b = isRough ? b | ROUGH_BIT : b & ~ROUGH_BIT;
        f[at] = b;
      } else if (b & ROUGH_BIT) {
        b &= ~ROUGH_BIT;
        f[at] = b;
      }
      if ((b & RISE_MASK) !== RISE_UNKNOWN) known++;
      if (b & KEPT_BIT) kept++;
      if (b & ROUGH_BIT) rough++;
      if ((b & (KEPT_BIT | ROUGH_BIT)) !== before[j * m + i]!) changed++;
    }
  }
  field.chunkSeen[chunk]!++;
  field.version++;
  return { known, kept, rough, changed };
}

/** Rise above terrain (m) at texel (i, j) of the field, or NaN while unknown. A coarse step reads as its centre. */
export function riseAt(field: HeightField, i: number, j: number): number {
  if (i < 0 || j < 0 || i >= HEIGHT_N || j >= HEIGHT_N) return NaN;
  const q = field.data[j * HEIGHT_N + i]! & RISE_MASK;
  return q === RISE_UNKNOWN ? NaN : decodeRise(q);
}

/** True when texel (i, j) carries the rough bit (not planar along both axes: canopy, not a roof). */
export function roughAt(field: HeightField, i: number, j: number): boolean {
  if (i < 0 || j < 0 || i >= HEIGHT_N || j >= HEIGHT_N) return false;
  return (field.data[j * HEIGHT_N + i]! & ROUGH_BIT) !== 0;
}

export type HeightState = 'unknown' | 'kept' | 'clear' | 'never';

/**
 * What the field says at world (x, z): 'never' when its chunk was never captured (or the point is outside the
 * square), 'unknown' when the chunk was captured but nothing measured this texel, else 'kept' or 'clear'.
 */
export function heightAt(field: HeightField, x: number, z: number): { rise: number; state: HeightState; chunk: number } {
  const chunk = chunkAt(x, z);
  if (chunk < 0 || field.chunkSeen[chunk] === 0) return { rise: NaN, state: 'never', chunk };
  const i = Math.floor(x - HEIGHT_ORIGIN), j = Math.floor(z - HEIGHT_ORIGIN);
  const b = field.data[j * HEIGHT_N + i]!;
  const rise = riseAt(field, i, j);
  if (Number.isNaN(rise)) return { rise, state: 'unknown', chunk };
  return { rise, state: b & KEPT_BIT ? 'kept' : 'clear', chunk };
}
