/**
 * Cutout 3D stencil: Overture footprints rasterised at 1 m (2 m on weak devices) into a square,
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
 * Footprints flattened into typed arrays so a worker can take them as
 * transferables instead of structured-cloning ten thousand objects.
 * Polygon p owns rings polyRings[p] .. polyRings[p + 1] - 1; ring r owns
 * coords ringStarts[r] .. ringStarts[r + 1] - 1 (x,z pairs).
 */
export interface PackedFootprints {
  readonly coords: Float32Array;
  readonly ringStarts: Uint32Array;
  readonly polyRings: Uint32Array;
}

export function packFootprints(polys: readonly PolyLike[]): PackedFootprints {
  let nCoords = 0, nRings = 0;
  for (const p of polys) {
    nCoords += p.ring.length;
    nRings += 1 + p.holes.length;
    for (const h of p.holes) nCoords += h.length;
  }
  const coords = new Float32Array(nCoords);
  const ringStarts = new Uint32Array(nRings + 1);
  const polyRings = new Uint32Array(polys.length + 1);
  let c = 0, r = 0;
  polys.forEach((p, k) => {
    polyRings[k] = r;
    for (const ring of [p.ring, ...p.holes]) {
      ringStarts[r++] = c;
      coords.set(ring, c);
      c += ring.length;
    }
  });
  ringStarts[r] = c;
  polyRings[polys.length] = r;
  return { coords, ringStarts, polyRings };
}

/**
 * Even-odd scanline fill of polygon p (outer ring plus holes) into `data`,
 * OR-ing so polygons and their parts union. A texel is in when its centre
 * is. Only the polygon's own rows and spans are touched; returns its texel
 * bounding box [i0, j0, i1, j1], or null when it misses the mask.
 */
function fillPolygon(
  data: Uint8Array, n: number, cell: number, x0: number, z0: number, pk: PackedFootprints, p: number, xs: number[]
): [number, number, number, number] | null {
  const { coords, ringStarts, polyRings } = pk;
  const r0 = polyRings[p]!, r1 = polyRings[p + 1]!;
  let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let k = ringStarts[r0]!; k < ringStarts[r1]!; k += 2) {
    const x = coords[k]!, z = coords[k + 1]!;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  const j0 = Math.max(0, Math.ceil((zMin - z0) / cell - 0.5));
  const j1 = Math.min(n - 1, Math.floor((zMax - z0) / cell - 0.5));
  const bi0 = Math.max(0, Math.floor((xMin - x0) / cell));
  const bi1 = Math.min(n - 1, Math.floor((xMax - x0) / cell));
  if (j0 > j1 || bi0 > bi1) return null;
  for (let j = j0; j <= j1; j++) {
    const zc = z0 + (j + 0.5) * cell;
    xs.length = 0;
    for (let r = r0; r < r1; r++) {
      // closed or open ring: walk every edge including last -> first
      const s = ringStarts[r]!, m = (ringStarts[r + 1]! - s) >> 1;
      for (let a = 0, b = m - 1; a < m; b = a, a++) {
        const za = coords[s + a * 2 + 1]!, zb = coords[s + b * 2 + 1]!;
        if ((za > zc) === (zb > zc)) continue;
        const xa = coords[s + a * 2]!, xb = coords[s + b * 2]!;
        xs.push(xa + ((zc - za) * (xb - xa)) / (zb - za));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((u, v) => u - v);
    const row = j * n;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k]! - x0) / cell - 0.5));
      const i1 = Math.min(n - 1, Math.ceil((xs[k + 1]! - x0) / cell - 0.5) - 1);
      for (let i = i0; i <= i1; i++) data[row + i] = MASK_ON;
    }
  }
  return [bi0, j0, bi1, j1];
}

function discOffsets(radiusTexels: number): number[] {
  const r = Math.floor(radiusTexels), r2 = radiusTexels * radiusTexels;
  const offs: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if ((dx !== 0 || dy !== 0) && dx * dx + dy * dy <= r2) offs.push(dx, dy);
    }
  }
  return offs;
}

/**
 * Stamp the disc from every boundary texel of `src` inside [i0..i1] x
 * [j0..j1] into `out`. Interior texels (all four neighbours set) cannot grow
 * the mask, so the cost is the outline length, not the area.
 */
function dilateBox(src: Uint8Array, out: Uint8Array, n: number, offs: number[], i0: number, j0: number, i1: number, j1: number): void {
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = j * n + i;
      if (src[c] === 0) continue;
      if (i > 0 && i < n - 1 && j > 0 && j < n - 1
        && src[c - 1] !== 0 && src[c + 1] !== 0 && src[c - n] !== 0 && src[c + n] !== 0) continue;
      for (let k = 0; k < offs.length; k += 2) {
        const x = i + offs[k]!, y = j + offs[k + 1]!;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        out[y * n + x] = MASK_ON;
      }
    }
  }
}

/** Grow every set texel by a Euclidean radius in texels (whole-mask form, for tests and small masks). */
export function dilateMask(data: Uint8Array, n: number, radiusTexels: number): Uint8Array {
  if (Math.floor(radiusTexels) < 1) return data;
  const out = data.slice();
  dilateBox(data, out, n, discOffsets(radiusTexels), 0, 0, n - 1, n - 1);
  return out;
}

export interface FootprintMaskOptions {
  /** side in metres (default 3600: the 1800 m footprint fetch radius, both ways) */
  size?: number;
  /** metres per texel (default 1; 2 on weak devices quarters the raster and the upload) */
  cell?: number;
  /** dilation radius in metres (default 2) */
  dilateM?: number;
  /** world x,z of the mask centre (default the tileset origin, 0,0) */
  cx?: number;
  cz?: number;
}

/**
 * Every footprint and building part as one stencil, dilated. Each polygon
 * fills on its own (ring and holes even-odd) inside its bounding box and the
 * results union, so a part over its building never cancels it out; the
 * dilation then walks only those boxes plus the radius. The outermost texel
 * ring is cleared so a clamped lookup beyond the extent reads "no footprint".
 */
export function footprintMaskPacked(pk: PackedFootprints, opts: FootprintMaskOptions = {}): FootprintMask {
  const cell = opts.cell ?? 1, dilateM = opts.dilateM ?? 2;
  const n = Math.ceil((opts.size ?? 3600) / cell);
  const size = n * cell;
  const cx = opts.cx ?? 0, cz = opts.cz ?? 0;
  const x0 = cx - size / 2, z0 = cz - size / 2;
  const filled = new Uint8Array(n * n);
  const boxes: [number, number, number, number][] = [];
  const xs: number[] = [];
  const nPolys = pk.polyRings.length - 1;
  for (let p = 0; p < nPolys; p++) {
    const b = fillPolygon(filled, n, cell, x0, z0, pk, p, xs);
    if (b) boxes.push(b);
  }
  const rad = dilateM / cell;
  let data = filled;
  if (Math.floor(rad) >= 1) {
    data = filled.slice();
    const offs = discOffsets(rad);
    for (const [i0, j0, i1, j1] of boxes) dilateBox(filled, data, n, offs, i0, j0, i1, j1);
  }
  for (let k = 0; k < n; k++) {
    data[k] = 0;
    data[(n - 1) * n + k] = 0;
    data[k * n] = 0;
    data[k * n + n - 1] = 0;
  }
  return { n, cell, cx, cz, size, data };
}

export function footprintMask1m(polys: readonly PolyLike[], opts: FootprintMaskOptions = {}): FootprintMask {
  return footprintMaskPacked(packFootprints(polys), opts);
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
