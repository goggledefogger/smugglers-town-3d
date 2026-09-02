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
  if (rangeM < 80) return 2.2;
  if (rangeM < 300) return 1.5;
  if (rangeM < 1000) return 1.2;
  return 1.0;
}

export function buildRealTerrain(
  label: string,
  grid: ElevationGrid,
  mapHalf: number,
  satelliteCanvas: HTMLCanvasElement | null
): TerrainProvider {
  const seg = SEGS, size = mapHalf * 2;
  const data = new Float32Array((seg + 1) * (seg + 1));
  const gN = grid.gridN;
  const res = grid.samples;
  let minH = Infinity, maxH = -Infinity;
  for (const e of res) {
    if (e < minH) minH = e;
    if (e > maxH) maxH = e;
  }
  const boost = reliefBoostFor(maxH - minH);
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      const fx = (i / seg) * (gN - 1), fz = (j / seg) * (gN - 1);
      const i0 = Math.floor(fx), j0 = Math.floor(fz);
      const i1 = Math.min(i0 + 1, gN - 1), j1 = Math.min(j0 + 1, gN - 1);
      const tx = fx - i0, tz = fz - j0;
      const h00 = res[j0 * gN + i0] ?? 0;
      const h10 = res[j0 * gN + i1] ?? 0;
      const h01 = res[j1 * gN + i0] ?? 0;
      const h11 = res[j1 * gN + i1] ?? 0;
      const a = h00 + (h10 - h00) * tx;
      const b = h01 + (h11 - h01) * tx;
      const h = a + (b - a) * tz;
      data[j * (seg + 1) + i] = (h - minH) * WORLD_M_PER_M * boost + GROUND_LIFT;
    }
  }
  return {
    label,
    isReal: true,
    heightfield: new Heightfield(size, seg, data),
    satelliteCanvas,
    reliefBoost: boost,
    datumAltM: minH
  };
}
