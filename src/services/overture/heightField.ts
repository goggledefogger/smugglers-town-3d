/**
 * The Cutout height field (stage 1: measured, not yet consumed). One persistent byte per 1 m texel over the
 * 3600 m stencil square, x,z from -1800, fed by 900 m chunks that HeightCapture renders top-down on the GPU.
 *
 * Byte layout:
 *   bits 0-6  rise above the 10 m tileset terrain in 0.5 m steps, 0..126 (63 m cap); 127 = unknown
 *   bit 7     "kept": the hysteresis flag. On at a rise of `keepRiseM` or more, off once the rise falls
 *             below half of it (3.0 m / 1.5 m at the default relief), and in between it stays as it was.
 * A texel that is measured as unknown (no fine tile drew there) keeps its previous byte, so a tile
 * streaming out never erases what it showed. A texel never measured is byte 127 (unknown, not kept).
 *
 * Pure data, no DOM, so the worker wraps it and the tests run it in node.
 */

export const HEIGHT_N = 3600;
export const HEIGHT_ORIGIN = -1800;
export const HEIGHT_CHUNK_M = 900;
export const HEIGHT_CHUNKS = 4;
export const RISE_UNKNOWN = 127;
export const KEPT_BIT = 128;
export const RISE_STEP_M = 0.5;
/** Largest stored step: 126 * 0.5 = 63 m. */
export const RISE_MAX_STEP = 126;

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
  /** bumped by every applied chunk; the input digest will carry it (stage 2) */
  version: number;
}

export interface HeightChunkStats {
  /** texels of this chunk with any measurement (byte != unknown) */
  readonly known: number;
  /** texels of this chunk with the kept bit */
  readonly kept: number;
  /** texels whose kept bit flipped in this application */
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
  let known = 0, kept = 0, changed = 0;
  for (let j = 0; j < m; j++) {
    const row = (cj * m + j) * HEIGHT_N + ci * m;
    for (let i = 0; i < m; i++) {
      const at = row + i;
      const y = worldY[j * m + i]!;
      let b = f[at]!;
      if (Number.isFinite(y)) {
        const rise = y - sampleTerrain(terrain, x0 + i + 0.5, z0 + j + 0.5);
        const was = b & KEPT_BIT;
        let keep = was;
        if (rise >= keepRiseM) keep = KEPT_BIT;
        else if (rise < dropBelowM) keep = 0;
        const q = Math.min(RISE_MAX_STEP, Math.max(0, Math.round(rise / RISE_STEP_M)));
        b = q | keep;
        f[at] = b;
        if (keep !== was) changed++;
      }
      if ((b & 127) !== RISE_UNKNOWN) known++;
      if (b & KEPT_BIT) kept++;
    }
  }
  field.chunkSeen[chunk]!++;
  field.version++;
  return { known, kept, changed };
}

/** Rise above terrain (m) at texel (i, j) of the field, or NaN while unknown. */
export function riseAt(field: HeightField, i: number, j: number): number {
  if (i < 0 || j < 0 || i >= HEIGHT_N || j >= HEIGHT_N) return NaN;
  const q = field.data[j * HEIGHT_N + i]! & 127;
  return q === RISE_UNKNOWN ? NaN : q * RISE_STEP_M;
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
