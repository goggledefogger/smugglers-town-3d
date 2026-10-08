/**
 * Cutout 3D stencil: Overture footprints rasterised at 1 m into a square,
 * world-fixed mask centred on the tileset origin (where the footprints were
 * fetched), then dilated so leaning facades and roof overhangs survive the
 * cut. The tile shader samples it per fragment and discards everything
 * outside a footprint, so the photogrammetry keeps its buildings and drops
 * its cars, trees and lumps over the satellite ground.
 *
 * Pure data, no DOM: the existing footprintRasterFromPolygons draws through a
 * canvas at Web Mercator zoom 17 for the collider pass, this one fills world
 * metres directly with a scanline so it can run (and be tested) anywhere.
 */
import type { Footprint } from './buildings.ts';
import type { Grid } from '../tiles/tileColliders.ts';

/** Texel value of a footprint cell: 255 so an R8 texture reads 1.0 in the shader. */
export const MASK_ON = 255;

export interface FootprintMask {
  /** side in texels; data[j * n + i], i along world x, j along world z */
  readonly n: number;
  /** metres per texel */
  readonly cell: number;
  /** world x,z of the mask centre */
  readonly cx: number;
  readonly cz: number;
  /** side in metres (n * cell) */
  readonly size: number;
  readonly data: Uint8Array;
}

type PolyLike = Pick<Footprint, 'ring' | 'holes'>;

/**
 * Even-odd scanline fill of one polygon (outer ring plus holes) into `data`,
 * OR-ing so polygons and their parts union. A texel is in when its centre is.
 */
function fillPolygon(data: Uint8Array, n: number, cell: number, x0: number, z0: number, rings: readonly number[][]): void {
  let zMin = Infinity, zMax = -Infinity;
  for (const r of rings) {
    for (let k = 1; k < r.length; k += 2) {
      zMin = Math.min(zMin, r[k]!);
      zMax = Math.max(zMax, r[k]!);
    }
  }
  const j0 = Math.max(0, Math.ceil((zMin - z0) / cell - 0.5));
  const j1 = Math.min(n - 1, Math.floor((zMax - z0) / cell - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const zc = z0 + (j + 0.5) * cell;
    xs.length = 0;
    for (const r of rings) {
      // closed or open ring: walk every edge including last -> first
      const m = r.length >> 1;
      for (let a = 0, b = m - 1; a < m; b = a, a++) {
        const za = r[a * 2 + 1]!, zb = r[b * 2 + 1]!;
        if ((za > zc) === (zb > zc)) continue;
        const xa = r[a * 2]!, xb = r[b * 2]!;
        xs.push(xa + ((zc - za) * (xb - xa)) / (zb - za));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const row = j * n;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k]! - x0) / cell - 0.5));
      const i1 = Math.min(n - 1, Math.ceil((xs[k + 1]! - x0) / cell - 0.5) - 1);
      for (let i = i0; i <= i1; i++) data[row + i] = MASK_ON;
    }
  }
}

/**
 * Grow every set texel by a Euclidean radius (metres): stamped from the
 * boundary texels only, so the cost is the outline length, not the area.
 */
export function dilateMask(data: Uint8Array, n: number, radiusTexels: number): Uint8Array {
  const r = Math.floor(radiusTexels);
  if (r < 1) return data;
  const r2 = radiusTexels * radiusTexels;
  const offs: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if ((dx !== 0 || dy !== 0) && dx * dx + dy * dy <= r2) offs.push(dx, dy);
    }
  }
  const out = data.slice();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = j * n + i;
      if (data[c] === 0) continue;
      // interior texels (all four neighbours set) cannot grow the mask
      if (i > 0 && i < n - 1 && j > 0 && j < n - 1
        && data[c - 1] !== 0 && data[c + 1] !== 0 && data[c - n] !== 0 && data[c + n] !== 0) continue;
      for (let k = 0; k < offs.length; k += 2) {
        const x = i + offs[k]!, y = j + offs[k + 1]!;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        out[y * n + x] = MASK_ON;
      }
    }
  }
  return out;
}

export interface FootprintMaskOptions {
  /** side in texels (default 4096: 16 MB R8, within every GPU's texture limit) */
  n?: number;
  /** metres per texel (default 1) */
  cell?: number;
  /** dilation radius in metres (default 2) */
  dilateM?: number;
  /** world x,z of the mask centre (default the tileset origin, 0,0) */
  cx?: number;
  cz?: number;
}

/**
 * Every footprint and building part as one 1 m stencil, dilated. Each
 * polygon fills on its own (ring and holes even-odd) and the results union,
 * so a part over its building never cancels it out.
 */
export function footprintMask1m(polys: readonly PolyLike[], opts: FootprintMaskOptions = {}): FootprintMask {
  const n = opts.n ?? 4096, cell = opts.cell ?? 1, dilateM = opts.dilateM ?? 2;
  const cx = opts.cx ?? 0, cz = opts.cz ?? 0;
  const size = n * cell;
  const x0 = cx - size / 2, z0 = cz - size / 2;
  const data = new Uint8Array(n * n);
  for (const p of polys) fillPolygon(data, n, cell, x0, z0, [p.ring, ...p.holes]);
  return { n, cell, cx, cz, size, data: dilateMask(data, n, dilateM / cell) };
}

/** The mask at a world x,z: true inside a (dilated) footprint, false outside it or the extent. */
export function maskAt(m: FootprintMask, x: number, z: number): boolean {
  const i = Math.floor((x - (m.cx - m.size / 2)) / m.cell);
  const j = Math.floor((z - (m.cz - m.size / 2)) / m.cell);
  if (i < 0 || j < 0 || i >= m.n || j >= m.n) return false;
  return m.data[j * m.n + i] !== 0;
}

export interface CoverageGap {
  /** connected groups of classifier structure cells inside the mask extent */
  classifierBuildings: number;
  /** of those, how many have no footprint texel within `reachM` of any of their cells */
  withoutFootprint: number;
}

/**
 * How big the Overture gap is: the classifier's structure cells (1 =
 * building, deck or ramp) grouped 4-connected into buildings, each checked
 * for any footprint texel within `reachM` of its cells. Only groups wholly
 * inside the mask extent count, since no footprints were fetched beyond it.
 */
export function classifierGap(structure: Uint8Array, grid: Grid, m: FootprintMask, reachM = 3): CoverageGap {
  const { n, cell, half } = grid;
  const seen = new Uint8Array(n * n);
  const stack: number[] = [];
  const mx0 = m.cx - m.size / 2, mz0 = m.cz - m.size / 2;
  const inExtent = (c: number): boolean => {
    const x = -half + (c % n) * cell, z = -half + Math.floor(c / n) * cell;
    return x >= mx0 && z >= mz0 && x + cell <= mx0 + m.size && z + cell <= mz0 + m.size;
  };
  const touchesFootprint = (c: number): boolean => {
    const x = -half + (c % n) * cell, z = -half + Math.floor(c / n) * cell;
    const i0 = Math.max(0, Math.floor((x - reachM - mx0) / m.cell));
    const i1 = Math.min(m.n - 1, Math.floor((x + cell + reachM - mx0) / m.cell));
    const j0 = Math.max(0, Math.floor((z - reachM - mz0) / m.cell));
    const j1 = Math.min(m.n - 1, Math.floor((z + cell + reachM - mz0) / m.cell));
    for (let j = j0; j <= j1; j++) {
      const row = j * m.n;
      for (let i = i0; i <= i1; i++) if (m.data[row + i] !== 0) return true;
    }
    return false;
  };
  let classifierBuildings = 0, withoutFootprint = 0;
  for (let s = 0; s < n * n; s++) {
    if (structure[s] !== 1 || seen[s]) continue;
    seen[s] = 1;
    stack.push(s);
    let inside = true, covered = false;
    while (stack.length) {
      const c = stack.pop()!;
      if (!inExtent(c)) inside = false;
      if (!covered && inside && touchesFootprint(c)) covered = true;
      const i = c % n, j = Math.floor(c / n);
      const nb = [i > 0 ? c - 1 : -1, i < n - 1 ? c + 1 : -1, j > 0 ? c - n : -1, j < n - 1 ? c + n : -1];
      for (const d of nb) {
        if (d < 0 || seen[d] || structure[d] !== 1) continue;
        seen[d] = 1;
        stack.push(d);
      }
    }
    if (!inside) continue;
    classifierBuildings++;
    if (!covered) withoutFootprint++;
  }
  return { classifierBuildings, withoutFootprint };
}
