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
import { traceStencil } from './stencilTrace.ts';

/** Texel value of a footprint cell: 255 so an R8 texture reads 1.0 in the shader. */
export const MASK_ON = 255;
/** Roof cap byte meaning "no cap": no roof sample, a gap cell, outside every footprint, or over 254 m. */
export const ROOF_NO_CAP = 255;

/**
 * A roof cap in metres above the footprint's ground as the G byte: whole
 * metres rounded up (never below the roof), 1..254, and ROOF_NO_CAP for no
 * cap or anything taller than 254 m. 0 is reserved for "unset" during a build.
 */
export function encodeRoofCap(h: number | null): number {
  if (h == null || !Number.isFinite(h)) return ROOF_NO_CAP;
  const v = Math.max(1, Math.ceil(h - 1e-6));
  return v > 254 ? ROOF_NO_CAP : v;
}

/** The G byte back to metres; Infinity for no cap. The shader reads it as g * 255. */
export function decodeRoofCap(v: number): number {
  return v >= ROOF_NO_CAP ? Infinity : v;
}

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
  /** 1: R8, the inside flag. 2: RG8, interleaved, G the roof cap (encodeRoofCap) */
  readonly channels: 1 | 2;
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
  data: Uint8Array, n: number, ch: number, cell: number, x0: number, z0: number, pk: PackedFootprints, p: number, xs: number[], cap: number
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
      if (ch === 1) {
        for (let i = i0; i <= i1; i++) data[row + i] = MASK_ON;
      } else {
        // overlapping polygons keep the highest cap: a part over its building never shaves it
        for (let i = i0; i <= i1; i++) {
          const o = (row + i) * 2;
          data[o] = MASK_ON;
          if (data[o + 1]! < cap) data[o + 1] = cap;
        }
      }
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
 * the mask, so the cost is the outline length, not the area. With two
 * channels the stamped texels carry the source texel's roof cap, keeping
 * the highest where bands overlap, so a leaning facade in the band is
 * capped by its own building's roof.
 */
function dilateBox(
  src: Uint8Array, out: Uint8Array, n: number, ch: number, offs: number[], i0: number, j0: number, i1: number, j1: number
): void {
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = j * n + i;
      if (src[c * ch] === 0) continue;
      const cap = ch === 2 ? src[c * 2 + 1]! : 0;
      // interior: all four neighbours set and, with caps, none lower than this one (a tower
      // beside a low block is a boundary too, so its cap spreads over the shared wall)
      if (i > 0 && i < n - 1 && j > 0 && j < n - 1
        && src[(c - 1) * ch] !== 0 && src[(c + 1) * ch] !== 0 && src[(c - n) * ch] !== 0 && src[(c + n) * ch] !== 0
        && (ch === 1 || (src[(c - 1) * 2 + 1]! >= cap && src[(c + 1) * 2 + 1]! >= cap
          && src[(c - n) * 2 + 1]! >= cap && src[(c + n) * 2 + 1]! >= cap))) continue;
      for (let k = 0; k < offs.length; k += 2) {
        const x = i + offs[k]!, y = j + offs[k + 1]!;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const o = (y * n + x) * ch;
        out[o] = MASK_ON;
        if (ch === 2 && out[o + 1]! < cap) out[o + 1] = cap;
      }
    }
  }
}

/** Grow every set texel by a Euclidean radius in texels (whole-mask form, for tests and small masks). */
export function dilateMask(data: Uint8Array, n: number, radiusTexels: number): Uint8Array {
  if (Math.floor(radiusTexels) < 1) return data;
  const out = data.slice();
  dilateBox(data, out, n, 1, discOffsets(radiusTexels), 0, 0, n - 1, n - 1);
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
  /** RG8 with a roof cap in G (default false: R8, the inside flag only) */
  roofCap?: boolean;
}

/**
 * Every footprint and building part as one stencil, dilated. Each polygon
 * fills on its own (ring and holes even-odd) inside its bounding box and the
 * results union, so a part over its building never cancels it out; the
 * dilation then walks only those boxes plus the radius. The outermost texel
 * ring is cleared so a clamped lookup beyond the extent reads "no footprint".
 */
export function footprintMaskPacked(pk: PackedFootprints, opts: FootprintMaskOptions = {}, caps: Uint8Array | null = null): FootprintMask {
  const cell = opts.cell ?? 1, dilateM = opts.dilateM ?? 2;
  const n = Math.ceil((opts.size ?? 3600) / cell);
  const size = n * cell;
  const cx = opts.cx ?? 0, cz = opts.cz ?? 0;
  const x0 = cx - size / 2, z0 = cz - size / 2;
  const ch: 1 | 2 = opts.roofCap ? 2 : 1;
  // two channels: G starts 0 ("unset") so overlapping polygons and bands can keep the max
  const filled = new Uint8Array(n * n * ch);
  const boxes: [number, number, number, number][] = [];
  const xs: number[] = [];
  const nPolys = pk.polyRings.length - 1;
  for (let p = 0; p < nPolys; p++) {
    // cap 0: the mesh never rises over this footprint (an empty lot, a shed): not stencilled
    if (caps && caps[p] === 0) continue;
    const b = fillPolygon(filled, n, ch, cell, x0, z0, pk, p, xs, caps?.[p] ?? ROOF_NO_CAP);
    if (b) boxes.push(b);
  }
  const rad = dilateM / cell;
  let data = filled;
  if (Math.floor(rad) >= 1) {
    data = filled.slice();
    const offs = discOffsets(rad);
    for (const [i0, j0, i1, j1] of boxes) dilateBox(filled, data, n, ch, offs, i0, j0, i1, j1);
  }
  for (let k = 0; k < n; k++) {
    data[k * ch] = 0;
    data[((n - 1) * n + k) * ch] = 0;
    data[k * n * ch] = 0;
    data[(k * n + n - 1) * ch] = 0;
  }
  // outside every footprint the cap is "none", so the linear filter only ever loosens a cap at an edge
  if (ch === 2) for (let o = 0; o < data.length; o += 2) if (data[o] === 0 || data[o + 1] === 0) data[o + 1] = ROOF_NO_CAP;
  return { n, cell, cx, cz, size, channels: ch, data };
}

export function footprintMask1m(polys: readonly PolyLike[], opts: FootprintMaskOptions = {}): FootprintMask {
  return footprintMaskPacked(packFootprints(polys), opts);
}

/** The mask at a world x,z: true inside a (dilated) footprint, false outside it or the extent. */
export function maskAt(m: FootprintMask, x: number, z: number): boolean {
  const i = Math.floor((x - (m.cx - m.size / 2)) / m.cell);
  const j = Math.floor((z - (m.cz - m.size / 2)) / m.cell);
  if (i < 0 || j < 0 || i >= m.n || j >= m.n) return false;
  return m.data[(j * m.n + i) * m.channels] !== 0;
}

/** The roof cap (m above the footprint's ground) at a world x,z; Infinity for none or an R8 mask. */
export function roofCapAt(m: FootprintMask, x: number, z: number): number {
  if (m.channels !== 2) return Infinity;
  const i = Math.floor((x - (m.cx - m.size / 2)) / m.cell);
  const j = Math.floor((z - (m.cz - m.size / 2)) / m.cell);
  if (i < 0 || j < 0 || i >= m.n || j >= m.n) return Infinity;
  return decodeRoofCap(m.data[(j * m.n + i) * 2 + 1]!);
}

export interface CoverageGap {
  /** connected groups of classifier structure cells inside the mask extent */
  classifierBuildings: number;
  /** of those, how many have no footprint texel within `reachM` of any of their cells */
  withoutFootprint: number;
}

/** The mask's world-x,z origin (its min corner). */
const maskOrigin = (m: FootprintMask): [number, number] => [m.cx - m.size / 2, m.cz - m.size / 2];

/** Classifier cell c lies wholly inside the mask extent (no footprints were fetched beyond it). */
function cellInExtent(c: number, grid: Grid, m: FootprintMask): boolean {
  const { n, cell, half } = grid;
  const [mx0, mz0] = maskOrigin(m);
  const x = -half + (c % n) * cell, z = -half + Math.floor(c / n) * cell;
  return x >= mx0 && z >= mz0 && x + cell <= mx0 + m.size && z + cell <= mz0 + m.size;
}

/** Any set mask texel within `reachM` of classifier cell c's square. */
function cellNearMask(c: number, grid: Grid, m: FootprintMask, reachM: number): boolean {
  const { n, cell, half } = grid;
  const [mx0, mz0] = maskOrigin(m);
  const x = -half + (c % n) * cell, z = -half + Math.floor(c / n) * cell;
  const i0 = Math.max(0, Math.floor((x - reachM - mx0) / m.cell));
  const i1 = Math.min(m.n - 1, Math.floor((x + cell + reachM - mx0) / m.cell));
  const j0 = Math.max(0, Math.floor((z - reachM - mz0) / m.cell));
  const j1 = Math.min(m.n - 1, Math.floor((z + cell + reachM - mz0) / m.cell));
  for (let j = j0; j <= j1; j++) {
    const row = j * m.n;
    for (let i = i0; i <= i1; i++) if (m.data[(row + i) * m.channels] !== 0) return true;
  }
  return false;
}

/** Classifier cell states on the classifier grid: what the hybrid stencil did with each. */
export const CELL_NONE = 0;
/** A building cell Overture lacks: painted into the stencil whole, and its box collides. */
export const CELL_GAP = 1;
/** A building cell with an Overture footprint within reach: the polygon (and its prism) stands for it. */
export const CELL_COVERED = 2;

/**
 * Per classifier cell: a structure cell inside the mask extent is a gap
 * when no Overture texel (dilated) lies within `reachM` of its square,
 * covered otherwise. Per cell, not per group: a block the classifier
 * merges into one group can hold one building Overture has and one it
 * lacks, and the far cells of the second are still gaps, while the 10 m
 * fringe hugging an Overture polygon is not (that is clutter the 1 m
 * outline already decided about). An uncovered group (classifierGap's
 * withoutFootprint) is all gap cells.
 */
export function classifierCells(structure: Uint8Array, grid: Grid, m: FootprintMask, reachM = 3): Uint8Array {
  const out = new Uint8Array(grid.n * grid.n);
  for (let c = 0; c < out.length; c++) {
    if (structure[c] !== 1 || !cellInExtent(c, grid, m)) continue;
    out[c] = cellNearMask(c, grid, m, reachM) ? CELL_COVERED : CELL_GAP;
  }
  return out;
}

/**
 * How big the Overture gap is: the classifier's structure cells (1 =
 * building, deck or ramp) grouped 4-connected into buildings, a group
 * covered when any of its cells has a footprint texel within `reachM`.
 * Only groups wholly inside the mask extent count, since no footprints
 * were fetched beyond it.
 */
export function classifierGap(structure: Uint8Array, grid: Grid, m: FootprintMask, reachM = 3): CoverageGap {
  return classifierGapFromCells(structure, grid, classifierCells(structure, grid, m, reachM));
}

/** classifierGap over cell states already computed (the stencil build has them). */
export function classifierGapFromCells(structure: Uint8Array, grid: Grid, cells: Uint8Array): CoverageGap {
  const { n } = grid;
  const seen = new Uint8Array(n * n);
  const stack: number[] = [];
  let classifierBuildings = 0, withoutFootprint = 0;
  for (let s = 0; s < n * n; s++) {
    if (structure[s] !== 1 || seen[s]) continue;
    seen[s] = 1;
    stack.push(s);
    let inside = true, covered = false;
    while (stack.length) {
      const c = stack.pop()!;
      if (cells[c] === CELL_NONE) inside = false;
      else if (cells[c] === CELL_COVERED) covered = true;
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

/**
 * Paint every gap cell into the mask whole, in place: the texels whose
 * centres fall in the cell. Not dilated: the cell is already the
 * classifier's coarse hull. The outer texel ring stays clear.
 */
export function paintGapCells(m: FootprintMask, cells: Uint8Array, grid: Grid): number {
  const [mx0, mz0] = maskOrigin(m);
  let painted = 0;
  for (let c = 0; c < cells.length; c++) {
    if (cells[c] !== CELL_GAP) continue;
    painted++;
    const x = -grid.half + (c % grid.n) * grid.cell, z = -grid.half + Math.floor(c / grid.n) * grid.cell;
    const i0 = Math.max(1, Math.ceil((x - mx0) / m.cell - 0.5)), i1 = Math.min(m.n - 2, Math.ceil((x + grid.cell - mx0) / m.cell - 0.5) - 1);
    const j0 = Math.max(1, Math.ceil((z - mz0) / m.cell - 0.5)), j1 = Math.min(m.n - 2, Math.ceil((z + grid.cell - mz0) / m.cell - 0.5) - 1);
    // G is already ROOF_NO_CAP here: a gap cell has no Overture texel, so no cap
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) m.data[(j * m.n + i) * m.channels] = MASK_ON;
  }
  return painted;
}

export interface ClassifierInput {
  /** the classifier's structure grid (1 = building, deck or ramp), a copy the build may keep */
  readonly structure: Uint8Array;
  readonly grid: Grid;
  /** a structure cell with an Overture texel this close (m) is covered (default 3) */
  readonly reachM?: number;
  /** photogrammetry top (world y) of every building cell, -Infinity elsewhere: the roof samples */
  readonly top?: Float32Array | null;
}

/** Per footprint, what its roof cap is measured from and against. */
export interface RoofInput {
  /** world y the cap is measured from: the lowest ground under the ring, the prism's own base */
  readonly base: Float32Array;
  /** Overture's roof in world y (ground + minHeight + height, as the prism), NaN when it has no height */
  readonly overtureTop: Float32Array;
  /** world units above the roof that survive the cut (parapets, rooftop units, the band's sloping edge) */
  readonly marginM: number;
  /**
   * a footprint whose photogrammetry roof stands less than this above its base (or with no
   * building cell under it at all) is dropped: the mesh does not rise there (default 3)
   */
  readonly minRiseM?: number;
}

/** Point in a packed ring (x,z pairs from s to e), even-odd. */
function inPackedRing(coords: Float32Array, s: number, e: number, x: number, z: number): boolean {
  let inside = false;
  for (let a = s, b = e - 2; a < e; b = a, a += 2) {
    const xa = coords[a]!, za = coords[a + 1]!, xb = coords[b]!, zb = coords[b + 1]!;
    if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
  }
  return inside;
}

/**
 * Each footprint's roof cap byte: the higher of Overture's roof and the
 * photogrammetry's, plus the margin, above the footprint's base. The
 * photogrammetry roof is the MAX over the classifier cells whose centres
 * fall inside the outer ring (the cell holding the ring's box centre when
 * none does), the same cells rebuildPrisms reads: a mean would shave a
 * tall wing off a low podium. With roof samples given, a footprint whose
 * photogrammetry roof is under minRiseM above its base, or that has no
 * building cell under it, gets 0: dropped from the stencil, since the mesh
 * does not rise there and a wall would be invisible. Without samples
 * (no classifier yet) every footprint stays, uncapped unless Overture
 * knows its height.
 */
export function polygonRoofCaps(pk: PackedFootprints, roof: RoofInput, top: Float32Array | null, grid: Grid | null): Uint8Array {
  const nPolys = pk.polyRings.length - 1;
  const caps = new Uint8Array(nPolys);
  const { coords, ringStarts, polyRings } = pk;
  for (let p = 0; p < nPolys; p++) {
    const s = ringStarts[polyRings[p]!]!, e = ringStarts[polyRings[p]! + 1]!;
    let roofY = Number.isFinite(roof.overtureTop[p]!) ? roof.overtureTop[p]! : -Infinity;
    if (top && grid && e > s) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = s; k < e; k += 2) {
        const x = coords[k]!, z = coords[k + 1]!;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      const { n, cell, half } = grid;
      const i0 = Math.max(0, Math.floor((x0 + half) / cell)), i1 = Math.min(n - 1, Math.floor((x1 + half) / cell));
      const j0 = Math.max(0, Math.floor((z0 + half) / cell)), j1 = Math.min(n - 1, Math.floor((z1 + half) / cell));
      let photo = -Infinity, sampled = false;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if (!inPackedRing(coords, s, e, -half + (i + 0.5) * cell, -half + (j + 0.5) * cell)) continue;
        sampled = true;
        const t = top[j * n + i]!;
        if (Number.isFinite(t) && t > photo) photo = t;
      }
      if (!sampled) {
        const i = Math.floor(((x0 + x1) / 2 + half) / cell), j = Math.floor(((z0 + z1) / 2 + half) / cell);
        if (i >= 0 && j >= 0 && i < n && j < n && Number.isFinite(top[j * n + i]!)) photo = top[j * n + i]!;
      }
      if (photo === -Infinity || photo - roof.base[p]! < (roof.minRiseM ?? 3)) {
        caps[p] = 0;
        continue;
      }
      if (photo > roofY) roofY = photo;
    }
    caps[p] = roofY > -Infinity ? encodeRoofCap(roofY + roof.marginM - roof.base[p]!) : ROOF_NO_CAP;
  }
  return caps;
}

/** One stencil build request: footprints (and their roof input) ride along only with a new set id. */
export interface CutoutJob {
  readonly setId: number;
  readonly packed?: PackedFootprints | undefined;
  /** with `packed`, when opts.roofCap is on */
  readonly roof?: RoofInput | undefined;
  readonly opts: FootprintMaskOptions;
  readonly classifier: ClassifierInput | null;
}

export interface CutoutStats {
  coverage: CoverageGap | null;
  /** classifier cells painted into the stencil */
  gapCells: number;
  /** the Overture raster was rebuilt (not the cached one reused) */
  baseRebuilt: boolean;
}

/**
 * A 64-bit digest of byte arrays, as 16 hex digits: two independent
 * multiply-xor lanes over 32-bit words (bytes for the tail), each array's
 * length mixed in. Reads every byte, but a word at a time with two imuls,
 * about a tenth of what the raster that produced a stencil costs. Not
 * cryptographic: it only has to tell one stencil (or one set of inputs)
 * from the next.
 */
export function digestBytes(...parts: ArrayBufferView[]): string {
  let h1 = 0x811c9dc5 | 0, h2 = 0x9747b28c | 0;
  for (const part of parts) {
    const bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
    const words = bytes.byteOffset % 4 === 0 ? Math.floor(bytes.byteLength / 4) : 0;
    const w = new Uint32Array(bytes.buffer, bytes.byteOffset, words);
    for (let k = 0; k < words; k++) {
      const v = w[k]!;
      h1 = Math.imul(h1 ^ v, 0x01000193);
      h2 = Math.imul(h2 ^ v, 0x5bd1e995) ^ (h2 >>> 15);
    }
    for (let k = words * 4; k < bytes.byteLength; k++) {
      h1 = Math.imul(h1 ^ bytes[k]!, 0x01000193);
      h2 = Math.imul(h2 ^ bytes[k]!, 0x5bd1e995) ^ (h2 >>> 15);
    }
    h1 = Math.imul(h1 ^ bytes.byteLength, 0x01000193);
    h2 = Math.imul(h2 ^ bytes.byteLength, 0x5bd1e995) ^ (h2 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Everything a stencil build reads, digested before posting: the footprint
 * set (by id; a new set always posts), the options, and the classifier's
 * building cells and roof tops byte for byte. The same digest as the last
 * posted job means the build would come out the same, so it is not posted.
 */
export function cutoutInputDigest(setId: number, opts: FootprintMaskOptions, classifier: ClassifierInput | null): string {
  const head = new TextEncoder().encode(`${setId}|${JSON.stringify(opts)}|${classifier ? `${classifier.grid.n},${classifier.grid.cell},${classifier.grid.half},${classifier.reachM ?? 3}` : '-'}`);
  const parts: ArrayBufferView[] = [head];
  if (classifier) {
    parts.push(classifier.structure);
    if (classifier.top) parts.push(classifier.top);
  }
  return digestBytes(...parts);
}

export type CutoutBuild =
  | ({
    changed: true; mask: FootprintMask; cells: Uint8Array | null; /** digestBytes of mask.data */ digest: string;
    /** the mask's R traced into wall segments (stencilTrace.ts, SEG_STRIDE floats each): what the car hits */
    segments: Float32Array; traceMs: number;
  } & CutoutStats)
  | ({ changed: false } & CutoutStats);

/**
 * The hybrid stencil, Overture at 1 m UNION the classifier's gap cells.
 * Holds the footprints and their dilated raster per set, so a classifier
 * update (tiles streaming in) costs the gap scan and a copy, not a
 * re-raster; and when the painted cells come out the same as last time it
 * says so, and the caller skips the upload. Pure: the worker wraps one,
 * a worker-less runtime calls it directly.
 */
export class CutoutStencilBuilder {
  private setId = -1;
  private packed: PackedFootprints | null = null;
  private roof: RoofInput | null = null;
  private base: FootprintMask | null = null;
  private baseKey = '';
  private baseCaps: Uint8Array | null = null;
  private lastCells: Uint8Array | null = null;
  private lastSent = false;

  build(job: CutoutJob): CutoutBuild {
    if (job.packed) {
      this.setId = job.setId;
      this.packed = job.packed;
      this.roof = job.roof ?? null;
      this.base = null;
      this.lastSent = false;
    }
    if (!this.packed || this.setId !== job.setId) throw new Error(`cutout: footprint set ${job.setId} was never sent`);
    const key = JSON.stringify(job.opts);
    const cl = job.classifier;
    // the roof samples stream in with the tiles: a changed cap (or a footprint the mesh turns out
    // not to rise over) re-rasters, an unchanged one reuses the cached raster
    const caps = this.roof ? polygonRoofCaps(this.packed, this.roof, cl?.top ?? null, cl?.grid ?? null) : null;
    let baseRebuilt = false;
    if (!this.base || this.baseKey !== key || !sameCells(caps, this.baseCaps)) {
      this.base = footprintMaskPacked(this.packed, job.opts, caps);
      this.baseKey = key;
      this.baseCaps = caps;
      this.lastSent = false;
      baseRebuilt = true;
    }
    const base = this.base;
    const cells = cl ? classifierCells(cl.structure, cl.grid, base, cl.reachM ?? 3) : null;
    const coverage = cl && cells ? classifierGapFromCells(cl.structure, cl.grid, cells) : null;
    let gapCells = 0;
    if (cells) for (let c = 0; c < cells.length; c++) if (cells[c] === CELL_GAP) gapCells++;
    if (this.lastSent && sameCells(cells, this.lastCells)) return { changed: false, coverage, gapCells, baseRebuilt };
    const mask: FootprintMask = { ...base, data: base.data.slice() };
    if (cells && cl) paintGapCells(mask, cells, cl.grid);
    this.lastCells = cells;
    this.lastSent = true;
    const t0 = performance.now();
    const segments = traceStencil(mask);
    const traceMs = performance.now() - t0;
    return {
      changed: true, mask, cells: cells ? cells.slice() : null, digest: digestBytes(mask.data), segments, traceMs,
      coverage, gapCells, baseRebuilt
    };
  }
}

function sameCells(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}
