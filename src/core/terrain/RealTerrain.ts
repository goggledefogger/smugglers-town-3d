/**
 * Real terrain built from a Google Elevation grid. Samples a 64×64 grid of
 * real elevations (meters), converts to world units with true-to-scale mapping
 * plus an adaptive relief boost so flat cities still get enough rise for jumps
 * (50m city → 2.2×, 500m hills → 1.3×, 2000m peak → ~1.0×).
 */
import { Heightfield } from '../heightfield.ts';
import { WORLD_M_PER_M } from '../geo/ecef.ts';
import type { TerrainProvider } from './TerrainProvider.ts';

const SEGS = 256;

/**
 * World-unit lift of the terrain mesh above the tile datum, so the satellite
 * drape covers the photogrammetry ground instead of z-fighting with it.
 * Buildings shorter than this (in boosted world units) stay hidden under it.
 */
export const GROUND_LIFT = 2;

export interface ElevationGrid {
  /** Row-major N×N elevation samples in meters (index = j*N + i). */
  readonly samples: readonly number[];
  readonly gridN: number;
}

/** Relief exaggeration for a real elevation range (meters). */
export function reliefBoostFor(rangeM: number): number {
  if (rangeM < 80) return 1.3;
  if (rangeM < 300) return 1.2;
  if (rangeM < 1000) return 1.1;
  return 1.0;
}

/** Catmull-Rom spline through p1..p2 with p0/p3 as neighbours, t in [0, 1]. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return 0.5 * (
    2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t
  );
}

/**
 * Bicubic (Catmull-Rom) sample of the elevation grid at fractional (fx, fz).
 * Bilinear would do for looks, but it is only C0: its slope kinks at every
 * 87 m grid edge reach the car as a jolt several times a second at speed
 */
export function sampleGridSmooth(grid: ElevationGrid, fx: number, fz: number): number {
  const gN = grid.gridN;
  const res = grid.samples;
  const at = (i: number, j: number): number =>
    res[Math.min(gN - 1, Math.max(0, j)) * gN + Math.min(gN - 1, Math.max(0, i))] ?? 0;
  const i0 = Math.min(gN - 2, Math.floor(fx)), j0 = Math.min(gN - 2, Math.floor(fz));
  const tx = fx - i0, tz = fz - j0;
  const rows: number[] = [];
  for (let dj = -1; dj <= 2; dj++) {
    const j = j0 + dj;
    rows.push(catmullRom(at(i0 - 1, j), at(i0, j), at(i0 + 1, j), at(i0 + 2, j), tx));
  }
  return catmullRom(rows[0]!, rows[1]!, rows[2]!, rows[3]!, tz);
}

export function buildRealTerrain(
  label: string,
  grid: ElevationGrid,
  mapHalf: number,
  satelliteCanvas: HTMLCanvasElement | null,
  center?: { lat: number; lon: number }
): TerrainProvider {
  const seg = SEGS, size = mapHalf * 2;
  const data = new Float32Array((seg + 1) * (seg + 1));
  const gN = grid.gridN;
  let minH = Infinity, maxH = -Infinity;
  for (const e of grid.samples) {
    if (e < minH) minH = e;
    if (e > maxH) maxH = e;
  }
  const boost = reliefBoostFor(maxH - minH);
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      const h = sampleGridSmooth(grid, (i / seg) * (gN - 1), (j / seg) * (gN - 1));
      data[j * (seg + 1) + i] = (h - minH) * WORLD_M_PER_M * boost + GROUND_LIFT;
    }
  }
  return {
    label,
    isReal: true,
    heightfield: new Heightfield(size, seg, data),
    satelliteCanvas,
    reliefBoost: boost,
    datumAltM: minH,
    ...(center ? { center } : {})
  };
}
