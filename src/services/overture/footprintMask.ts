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
import {
  HEIGHT_N, HEIGHT_ORIGIN, RISE_MASK, RISE_UNKNOWN, KEPT_BIT, ROUGH_BIT, decodeRise, decodeRiseTop, sampleTerrain,
  type HeightField, type HeightTerrain
} from './heightField.ts';

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

/** Polygon p's texel bounding box [i0, j0, i1, j1] on a raster (see scanPolygon), or null when it misses it. */
function polygonBox(n: number, cell: number, x0: number, z0: number, pk: PackedFootprints, p: number): [number, number, number, number] | null {
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
  return j0 > j1 || bi0 > bi1 ? null : [bi0, j0, bi1, j1];
}

/**
 * Even-odd scanline of polygon p (outer ring plus holes) over a raster of side `n` texels of `cell` metres whose
 * min corner is (x0, z0): calls `onSpan(j, i0, i1)` for every run of texels (centres inside the polygon) in row j,
 * i0..i1 inclusive. A texel is in when its centre is. Returns the polygon's texel bounding box [i0, j0, i1, j1],
 * or null when it misses the raster. The one scan fillPolygon (writes) and polygonRoofCaps (reads the height
 * field) share.
 */
function scanPolygon(
  n: number, cell: number, x0: number, z0: number, pk: PackedFootprints, p: number, xs: number[],
  onSpan: (j: number, i0: number, i1: number) => void
): [number, number, number, number] | null {
  const { coords, ringStarts, polyRings } = pk;
  const r0 = polyRings[p]!, r1 = polyRings[p + 1]!;
  const box = polygonBox(n, cell, x0, z0, pk, p);
  if (!box) return null;
  const [bi0, j0, bi1, j1] = box;
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
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k]! - x0) / cell - 0.5));
      const i1 = Math.min(n - 1, Math.ceil((xs[k + 1]! - x0) / cell - 0.5) - 1);
      if (i0 <= i1) onSpan(j, i0, i1);
    }
  }
  return [bi0, j0, bi1, j1];
}

/** What the stencil reads of the height field: its bytes and the 10 m terrain a rise is measured from. */
export interface HeightsView {
  readonly field: HeightField;
  readonly terrain: HeightTerrain;
}


/**
 * Where the mask's texel (i, j) sits in the field: the field texel under its centre, or -1 outside the 3600 m
 * square. At a 1 m texel on the field's lattice (the production case) this is a fixed offset.
 */
function fieldIndexer(cell: number, x0: number, z0: number): (i: number, j: number) => number {
  if (cell === 1) {
    const dx = Math.floor(x0 - HEIGHT_ORIGIN + 0.5), dz = Math.floor(z0 - HEIGHT_ORIGIN + 0.5);
    return (i, j) => {
      const gi = i + dx, gj = j + dz;
      return gi < 0 || gj < 0 || gi >= HEIGHT_N || gj >= HEIGHT_N ? -1 : gj * HEIGHT_N + gi;
    };
  }
  return (i, j) => {
    const gi = Math.floor(x0 + (i + 0.5) * cell - HEIGHT_ORIGIN), gj = Math.floor(z0 + (j + 0.5) * cell - HEIGHT_ORIGIN);
    return gi < 0 || gj < 0 || gi >= HEIGHT_N || gj >= HEIGHT_N ? -1 : gj * HEIGHT_N + gi;
  };
}

/**
 * 3x3 erode (`erode`) or dilate of a w x h binary image, as a horizontal then a vertical 3-wide pass through
 * `tmp`; outside the image counts as set when eroding, clear when dilating (the border never erodes).
 */
function morph3(src: Uint8Array, tmp: Uint8Array, dst: Uint8Array, w: number, h: number, erode: boolean): void {
  const hit = erode ? 0 : 1; // the value that decides the output: one clear neighbour erodes, one set neighbour dilates
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      tmp[r + x] = (x > 0 && src[r + x - 1] === hit) || src[r + x] === hit || (x < w - 1 && src[r + x + 1] === hit) ? hit : 1 - hit;
    }
  }
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      dst[r + x] = (y > 0 && tmp[r - w + x] === hit) || tmp[r + x] === hit || (y < h - 1 && tmp[r + w + x] === hit) ? hit : 1 - hit;
    }
  }
}

/**
 * The keep test fillPolygon applies: a texel fills when the field has not measured it (defer: as before the
 * field existed) or measured it kept. Per polygon, over its box plus a 2 texel margin, a 3x3 open then close on
 * that "fills" image: the open drops a stand of kept texels under 3 wide (a street tree, a pole), the close
 * fills a 1 texel hole (a stair-step in a roof). The rough bit is not read: inside a polygon, rooftop plant
 * must not drill holes.
 */
class KeepFilter {
  private readonly at: (i: number, j: number) => number;
  private ei0 = 0; private ej0 = 0; private ew = 0;
  private img: Uint8Array = new Uint8Array(0);
  private tmp: Uint8Array = new Uint8Array(0);
  private tmp2: Uint8Array = new Uint8Array(0);
  private readonly f: Uint8Array;
  constructor(f: Uint8Array, cell: number, x0: number, z0: number) {
    this.f = f;
    this.at = fieldIndexer(cell, x0, z0);
  }

  /** Prepare for a polygon whose texel box is [i0..i1] x [j0..j1]. False when every texel there fills (no test needed). */
  prepare(i0: number, j0: number, i1: number, j1: number): boolean {
    const M = 2;
    this.ei0 = i0 - M; this.ej0 = j0 - M;
    const w = i1 - i0 + 1 + 2 * M, h = j1 - j0 + 1 + 2 * M;
    this.ew = w;
    if (this.img.length < w * h) { this.img = new Uint8Array(w * h); this.tmp = new Uint8Array(w * h); this.tmp2 = new Uint8Array(w * h); }
    const img = this.img, f = this.f;
    let blocked = false;
    for (let y = 0; y < h; y++) {
      const g0 = this.at(this.ei0, this.ej0 + y);
      // a mask row is a field row: contiguous when both ends are in the square and a texel apart
      const run = g0 >= 0 && this.at(this.ei0 + w - 1, this.ej0 + y) === g0 + w - 1;
      const r = y * w;
      if (run) {
        for (let x = 0; x < w; x++) {
          const b = f[g0 + x]!;
          if ((b & RISE_MASK) === RISE_UNKNOWN || (b & KEPT_BIT) !== 0) img[r + x] = 1;
          else { img[r + x] = 0; blocked = true; }
        }
        continue;
      }
      for (let x = 0; x < w; x++) {
        const g = this.at(this.ei0 + x, this.ej0 + y);
        const b = g < 0 ? RISE_UNKNOWN : f[g]!;
        const fills = (b & RISE_MASK) === RISE_UNKNOWN || (b & KEPT_BIT) !== 0;
        img[r + x] = fills ? 1 : 0;
        if (!fills) blocked = true;
      }
    }
    if (!blocked) return false;
    const a = this.tmp, b = this.tmp2;
    morph3(img, a, b, w, h, true);
    morph3(b, a, img, w, h, false);
    morph3(img, a, b, w, h, false);
    morph3(b, a, img, w, h, true);
    return true;
  }

  fills(i: number, j: number): boolean {
    return this.img[(j - this.ej0) * this.ew + (i - this.ei0)]! !== 0;
  }
}

/**
 * Even-odd scanline fill of polygon p (outer ring plus holes) into `data`,
 * OR-ing so polygons and their parts union. A texel is in when its centre
 * is. Only the polygon's own rows and spans are touched; returns its texel
 * bounding box [i0, j0, i1, j1], or null when it misses the mask. With a
 * `keep` filter, texels the height field has measured as not kept are
 * skipped.
 */
function fillPolygon(
  data: Uint8Array, n: number, ch: number, cell: number, x0: number, z0: number, pk: PackedFootprints, p: number, xs: number[], cap: number,
  keep: KeepFilter | null = null
): [number, number, number, number] | null {
  let filter = false;
  if (keep) {
    const box = polygonBox(n, cell, x0, z0, pk, p);
    if (!box) return null;
    filter = keep.prepare(box[0], box[1], box[2], box[3]);
  }
  return scanPolygon(n, cell, x0, z0, pk, p, xs, (j, i0, i1) => {
    const row = j * n;
    if (ch === 1) {
      for (let i = i0; i <= i1; i++) if (!filter || keep!.fills(i, j)) data[row + i] = MASK_ON;
    } else {
      // overlapping polygons keep the highest cap: a part over its building never shaves it
      for (let i = i0; i <= i1; i++) {
        if (filter && !keep!.fills(i, j)) continue;
        const o = (row + i) * 2;
        data[o] = MASK_ON;
        if (data[o + 1]! < cap) data[o + 1] = cap;
      }
    }
  });
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
    for (let i = i0; i <= i1; i++) dilateTexel(src, out, n, ch, offs, j * n + i);
  }
}

/** dilateBox for the one texel `c`: stamps the disc unless the texel is interior. */
function dilateTexel(src: Uint8Array, out: Uint8Array, n: number, ch: number, offs: number[], c: number): void {
  if (src[c * ch] === 0) return;
  const i = c % n, j = (c - i) / n;
  const cap = ch === 2 ? src[c * 2 + 1]! : 0;
  // interior: all four neighbours set and, with caps, none lower than this one (a tower
  // beside a low block is a boundary too, so its cap spreads over the shared wall)
  if (i > 0 && i < n - 1 && j > 0 && j < n - 1
    && src[(c - 1) * ch] !== 0 && src[(c + 1) * ch] !== 0 && src[(c - n) * ch] !== 0 && src[(c + n) * ch] !== 0
    && (ch === 1 || (src[(c - 1) * 2 + 1]! >= cap && src[(c + 1) * 2 + 1]! >= cap
      && src[(c - n) * 2 + 1]! >= cap && src[(c + n) * 2 + 1]! >= cap))) return;
  for (let k = 0; k < offs.length; k += 2) {
    const x = i + offs[k]!, y = j + offs[k + 1]!;
    if (x < 0 || y < 0 || x >= n || y >= n) continue;
    const o = (y * n + x) * ch;
    out[o] = MASK_ON;
    if (ch === 2 && out[o + 1]! < cap) out[o + 1] = cap;
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
  /**
   * how far (m, whole texels) a footprint grows into the connected mesh the height field says is a building
   * (default 0: off; main sets CUTOUT_GROW_M). Ignored unless the texel is 1 m: a weak device keeps the polygon.
   */
  growM?: number;
}

/** What growFootprints did: texels added, and fronts that stopped at the bound while the mesh still rose. */
export interface GrowStats {
  grown: number;
  grownTruncated: number;
}

/**
 * Every footprint and building part as one stencil, dilated. Each polygon
 * fills on its own (ring and holes even-odd) inside its bounding box and the
 * results union, so a part over its building never cancels it out; the
 * dilation then walks only those boxes plus the radius. The outermost texel
 * ring is cleared so a clamped lookup beyond the extent reads "no footprint".
 */
export function footprintMaskPacked(
  pk: PackedFootprints, opts: FootprintMaskOptions = {}, caps: Uint8Array | null = null, heights: HeightsView | null = null
): FootprintMask {
  return footprintMaskLayers(pk, opts, caps, heights).mask;
}

/**
 * Grow the filled footprints into the connected mesh the height field calls a building (design 4b). One
 * multi-source breadth-first flood on `filled`, run before dilation. Seeds are filled texels with a 4-neighbour
 * that is unfilled, measured, kept and not rough; a step enters such a neighbour when its rise is at most the
 * parent's cap (a taller one is another building, left to the gap rule), for at most `layers` layers. A grown
 * texel takes its parent's cap byte, and where two fronts meet in a layer the higher cap wins. Neighbours'
 * kept texels are already filled, so a front stops at their edge and the texels between go to the nearer one.
 * Returns the texel indices it added (for the dilation to stamp) and the counts.
 */
function growFootprints(
  filled: Uint8Array, n: number, ch: number, boxes: readonly [number, number, number, number][],
  field: Uint8Array, dx: number, dz: number, layers: number
): GrowStats & { texels: number[] } {
  const texels: number[] = [];
  /** the field byte under mask texel (i, j) (the 1 m lattice offset by dx, dz) */
  const byteAt = (i: number, j: number): number => {
    const gi = i + dx, gj = j + dz;
    return gi < 0 || gj < 0 || gi >= HEIGHT_N || gj >= HEIGHT_N ? RISE_UNKNOWN : field[gj * HEIGHT_N + gi]!;
  };
  /** the byte of an unfilled, measured, kept, not rough texel inside the cleared ring; -1 for any other */
  const open = (i: number, j: number): number => {
    if (i < 1 || j < 1 || i > n - 2 || j > n - 2) return -1;
    if (filled[(j * n + i) * ch] !== 0) return -1;
    const b = byteAt(i, j);
    return (b & RISE_MASK) !== RISE_UNKNOWN && (b & KEPT_BIT) !== 0 && !(b & ROUGH_BIT) ? b : -1;
  };
  let frontier: number[] = [];
  for (const [i0, j0, i1, j1] of boxes) {
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (filled[(j * n + i) * ch] === 0) continue;
        if (open(i - 1, j) >= 0 || open(i + 1, j) >= 0 || open(i, j - 1) >= 0 || open(i, j + 1) >= 0) frontier.push(j * n + i);
      }
    }
  }
  /**
   * One layer: each front texel offers its cap to the four neighbours it may enter. With two channels a claimed
   * texel gets the cap byte alone until the layer ends (so a second parent only raises it and the texel is still
   * "unfilled" to the rest of the layer); with one, the mask byte at once. Returns the texels newly claimed.
   */
  const step = (from: readonly number[], commit: boolean): number[] => {
    const next: number[] = [];
    for (const c of from) {
      const i = c % n, j = (c - i) / n;
      const cap = ch === 2 ? filled[c * 2 + 1]! : ROOF_NO_CAP;
      const capM = decodeRoofCap(cap);
      for (let k = 0; k < 4; k++) {
        const ni = k === 0 ? i - 1 : k === 1 ? i + 1 : i, nj = k === 2 ? j - 1 : k === 3 ? j + 1 : j;
        const b = open(ni, nj);
        if (b < 0 || decodeRise(b & RISE_MASK) > capM) continue;
        const d = nj * n + ni;
        if (ch === 2) {
          const have = filled[d * 2 + 1]!;
          if (have === 0) next.push(d);
          if (have < cap) filled[d * 2 + 1] = cap;
        } else {
          next.push(d);
          filled[d] = MASK_ON;
        }
      }
    }
    if (ch === 2 && commit) for (const d of next) filled[d * 2] = MASK_ON;
    return next;
  };
  for (let layer = 0; layer < layers && frontier.length; layer++) {
    frontier = step(frontier, true);
    for (const d of frontier) texels.push(d);
  }
  let truncated = 0;
  if (frontier.length) {
    // one more look, nothing kept: the texels the next step would have entered
    const more = step(frontier, false);
    truncated = more.length;
    for (const d of more) {
      if (ch === 2) filled[d * 2 + 1] = 0;
      else filled[d] = 0;
    }
  }
  return { grown: texels.length, grownTruncated: truncated, texels };
}

/**
 * The dilated stencil (`mask`, what the shader cuts to) and the undilated
 * footprint raster it grew from (`core`, what the car's walls trace from),
 * the same geometry, channels and cleared outer ring. `core` is the raster
 * the fill already made, kept rather than discarded: no extra copy, and when
 * the radius is under one texel it is the very same object as `mask`.
 * With the height field (`heights`), polygons fill only where the mesh is not
 * measured as flat ground (KeepFilter) and then grow into the connected
 * mesh (growFootprints); `core` includes the grown texels.
 */
export function footprintMaskLayers(
  pk: PackedFootprints, opts: FootprintMaskOptions = {}, caps: Uint8Array | null = null, heights: HeightsView | null = null
): { mask: FootprintMask; core: FootprintMask } & GrowStats {
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
  const keep = heights ? new KeepFilter(heights.field.data, cell, x0, z0) : null;
  const nPolys = pk.polyRings.length - 1;
  for (let p = 0; p < nPolys; p++) {
    // cap 0: the mesh never rises over this footprint (an empty lot, a shed): not stencilled
    if (caps && caps[p] === 0) continue;
    const b = fillPolygon(filled, n, ch, cell, x0, z0, pk, p, xs, caps?.[p] ?? ROOF_NO_CAP, keep);
    if (b) boxes.push(b);
  }
  const growLayers = Math.floor(opts.growM ?? 0);
  let grow: (GrowStats & { texels: number[] }) | null = null;
  if (heights && cell === 1 && growLayers >= 1) {
    grow = growFootprints(
      filled, n, ch, boxes, heights.field.data, Math.floor(x0 - HEIGHT_ORIGIN + 0.5), Math.floor(z0 - HEIGHT_ORIGIN + 0.5), growLayers
    );
  }
  const rad = dilateM / cell;
  let data = filled;
  if (Math.floor(rad) >= 1) {
    data = filled.slice();
    const offs = discOffsets(rad);
    for (const [i0, j0, i1, j1] of boxes) dilateBox(filled, data, n, ch, offs, i0, j0, i1, j1);
    // the grown texels stand outside every box: stamp them from the flood's list
    if (grow) for (const c of grow.texels) dilateTexel(filled, data, n, ch, offs, c);
  }
  const finish = (d: Uint8Array) => {
    for (let k = 0; k < n; k++) {
      d[k * ch] = 0;
      d[((n - 1) * n + k) * ch] = 0;
      d[k * n * ch] = 0;
      d[(k * n + n - 1) * ch] = 0;
    }
    // outside every footprint the cap is "none", so the linear filter only ever loosens a cap at an edge
    if (ch === 2) for (let o = 0; o < d.length; o += 2) if (d[o] === 0 || d[o + 1] === 0) d[o + 1] = ROOF_NO_CAP;
  };
  finish(data);
  const mask: FootprintMask = { n, cell, cx, cz, size, channels: ch, data };
  const stats = { grown: grow?.grown ?? 0, grownTruncated: grow?.grownTruncated ?? 0 };
  if (data === filled) return { mask, core: mask, ...stats };
  finish(filled);
  return { mask, core: { ...mask, data: filled }, ...stats };
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
/** A gap cell in a group with no roofed-over cell (a pole, a tree, steps): not painted, no wall. */
export const CELL_UNROOFED = 3;

/** Default for the roofed-over rule (m): a gap group fills only if some cell's lowest geometry is this far above the ground. */
export const ROOF_MIN_M = 2.5;

/**
 * Cutout 3D's roofed-over rule for classifier gap cells. The classifier
 * calls a 10 m cell a building when its TALLEST geometry rises 3.5 m, so a
 * light pole, a tree, a column or a stepped terrace over open paving makes
 * one; Pioneer Courthouse Square was full of them, each painted whole and
 * walled. Here the LOWEST geometry decides: a roof over the cell keeps it
 * high, a pole leaves the paving at ground. Per 4-connected gap group, not
 * per cell: a building's edge cells hold its wall foot and read at ground
 * like a pole does, so a group fills whole when any of its cells is
 * roofed, and goes (CELL_UNROOFED) when none is. Decks and ramps carry
 * +Infinity and always fill. Returns the cells it dropped.
 */
export function requireRoofed(cells: Uint8Array, grid: Grid, lowRise: Float32Array, roofMinM: number): number {
  const { n } = grid;
  const stack: number[] = [], group: number[] = [];
  const seen = new Uint8Array(n * n);
  let dropped = 0;
  for (let s0 = 0; s0 < n * n; s0++) {
    if (cells[s0] !== CELL_GAP || seen[s0]) continue;
    seen[s0] = 1;
    stack.push(s0);
    group.length = 0;
    let roofed = false;
    while (stack.length) {
      const c = stack.pop()!;
      group.push(c);
      if (lowRise[c]! >= roofMinM) roofed = true;
      const i = c % n, j = Math.floor(c / n);
      const nb = [i > 0 ? c - 1 : -1, i < n - 1 ? c + 1 : -1, j > 0 ? c - n : -1, j < n - 1 ? c + n : -1];
      for (const d of nb) {
        if (d < 0 || seen[d] || cells[d] !== CELL_GAP) continue;
        seen[d] = 1;
        stack.push(d);
      }
    }
    if (roofed) continue;
    for (const c of group) cells[c] = CELL_UNROOFED;
    dropped += group.length;
  }
  return dropped;
}

/**
 * The same rule for classifier boxes (Cutout 3D's fallback before a stencil
 * lands): a box stays when any cell under it is roofed over, so a pole-cell
 * box does not collide while a real building's box, edges and all, does.
 */
export function roofedBoxes<B extends { min: { x: number; z: number }; max: { x: number; z: number } }>(
  boxes: readonly B[], lowRise: Float32Array, grid: Grid, roofMinM: number
): B[] {
  const { n, cell, half } = grid;
  const clampI = (v: number) => Math.min(n - 1, Math.max(0, v));
  return boxes.filter(b => {
    const i0 = clampI(Math.floor((b.min.x + half) / cell)), i1 = clampI(Math.floor((b.max.x - 1e-3 + half) / cell));
    const j0 = clampI(Math.floor((b.min.z + half) / cell)), j1 = clampI(Math.floor((b.max.z - 1e-3 + half) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (lowRise[j * n + i]! >= roofMinM) return true;
    return false;
  });
}

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
 * Paint every gap cell into the mask, in place: the texels whose centres
 * fall in the cell. Not dilated: the cell is already the classifier's coarse
 * hull. The outer texel ring stays clear. `value` 0 takes the same cells
 * back out (the builder borrows the cached undilated raster for a trace and
 * returns it as it found it). With the height field, a texel the field has
 * measured as not kept, or kept but rough (canopy), is left out: a gap cell
 * paints only the building in it. A texel the field has not measured paints,
 * so a cell over an unknown field paints whole. Returns the cells painted.
 */
export function paintGapCells(m: FootprintMask, cells: Uint8Array, grid: Grid, value = MASK_ON, heights: HeightsView | null = null): number {
  const [mx0, mz0] = maskOrigin(m);
  const f = heights?.field.data ?? null;
  const at = f ? fieldIndexer(m.cell, mx0, mz0) : null;
  let painted = 0;
  for (let c = 0; c < cells.length; c++) {
    if (cells[c] !== CELL_GAP) continue;
    painted++;
    const x = -grid.half + (c % grid.n) * grid.cell, z = -grid.half + Math.floor(c / grid.n) * grid.cell;
    const i0 = Math.max(1, Math.ceil((x - mx0) / m.cell - 0.5)), i1 = Math.min(m.n - 2, Math.ceil((x + grid.cell - mx0) / m.cell - 0.5) - 1);
    const j0 = Math.max(1, Math.ceil((z - mz0) / m.cell - 0.5)), j1 = Math.min(m.n - 2, Math.ceil((z + grid.cell - mz0) / m.cell - 0.5) - 1);
    // G is already ROOF_NO_CAP here: a gap cell has no Overture texel, so no cap
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (f && at) {
          const g = at(i, j);
          const b = g < 0 ? RISE_UNKNOWN : f[g]!;
          if ((b & RISE_MASK) !== RISE_UNKNOWN && (!(b & KEPT_BIT) || (b & ROUGH_BIT))) continue;
        }
        m.data[(j * m.n + i) * m.channels] = value;
      }
    }
  }
  return painted;
}

/**
 * The classifier boxes the cars hit while no stencil is on screen: in a
 * view that cuts to footprints (Cutout 3D), only the roofed-over ones, the
 * same rule its stencil applies to gap cells; every other view keeps them
 * all. Bots never come through here.
 */
export function fallbackCarBoxes<B extends { min: { x: number; z: number }; max: { x: number; z: number } }>(
  cutsToFootprints: boolean, boxes: readonly B[], lowRise: Float32Array | null, grid: Grid | null, roofMinM: number
): B[] {
  return cutsToFootprints && lowRise && grid && lowRise.length === grid.n * grid.n
    ? roofedBoxes(boxes, lowRise, grid, roofMinM)
    : [...boxes];
}

export interface ClassifierInput {
  /** the classifier's structure grid (1 = building, deck or ramp), a copy the build may keep */
  readonly structure: Uint8Array;
  readonly grid: Grid;
  /** a structure cell with an Overture texel this close (m) is covered (default 3) */
  readonly reachM?: number;
  /** photogrammetry top (world y) of every building cell, -Infinity elsewhere: the roof samples */
  readonly top?: Float32Array | null;
  /** lowest geometry above the ground estimate per building cell (Tileset.activeLowRiseGrid): the roofed-over rule */
  readonly lowRise?: Float32Array | null;
  /** a gap group fills only if some cell's lowRise reaches this (world units; default ROOF_MIN_M) */
  readonly roofMinM?: number;
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
export function polygonRoofCaps(
  pk: PackedFootprints, roof: RoofInput, top: Float32Array | null, grid: Grid | null, heights: HeightsView | null = null
): Uint8Array {
  return polygonRoofCapsDetailed(pk, roof, top, grid, heights).caps;
}

/** A polygon needs at least this many rising (kept) field texels, about 20 m2, or the mesh does not rise there. */
export const FIELD_MIN_RISING_TEXELS = 20;
/** The field decides a polygon's cap once at least this share of its texels are measured. */
export const FIELD_MIN_KNOWN_SHARE = 0.5;

/** The highest terrain node among the cells covering world [x0, x1] x [z0, z1] (bilinear never exceeds its nodes). */
function terrainMaxOver(t: HeightTerrain, x0: number, z0: number, x1: number, z1: number): number {
  const seg = t.segs, w = seg + 1;
  const ix = (x: number): number => Math.min(seg, Math.max(0, (x / t.size + 0.5) * seg));
  const i0 = Math.floor(ix(x0)), i1 = Math.min(seg, Math.floor(ix(x1)) + 1);
  const j0 = Math.floor(ix(z0)), j1 = Math.min(seg, Math.floor(ix(z1)) + 1);
  let m = -Infinity;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const v = t.data[j * w + i]!;
    if (v > m) m = v;
  }
  return Number.isFinite(m) ? m : Infinity;
}

/**
 * What the height field says of polygon p: `known` of its `total` texels measured, `rising` of them kept, and
 * the highest world Y over the kept ones (a coarse step's top, over the terrain). Scans in the field's own
 * lattice (1 m from -1800), whatever the mask's texel.
 */
function fieldVerdict(
  pk: PackedFootprints, p: number, xs: number[], h: HeightsView
): { total: number; known: number; rising: number; topY: number } {
  const f = h.field.data;
  let total = 0, known = 0, rising = 0, topY = -Infinity;
  const box = polygonBox(HEIGHT_N, 1, HEIGHT_ORIGIN, HEIGHT_ORIGIN, pk, p);
  // the highest terrain node under the box bounds the terrain anywhere in it: a texel whose rise cannot beat
  // the best world Y even over that is skipped without sampling the terrain
  const tMax = box ? terrainMaxOver(h.terrain, box[0] + HEIGHT_ORIGIN, box[1] + HEIGHT_ORIGIN, box[2] + HEIGHT_ORIGIN + 1, box[3] + HEIGHT_ORIGIN + 1) : 0;
  scanPolygon(HEIGHT_N, 1, HEIGHT_ORIGIN, HEIGHT_ORIGIN, pk, p, xs, (j, i0, i1) => {
    const row = j * HEIGHT_N;
    total += i1 - i0 + 1;
    for (let i = i0; i <= i1; i++) {
      const b = f[row + i]!;
      const q = b & RISE_MASK;
      if (q === RISE_UNKNOWN) continue;
      known++;
      if (!(b & KEPT_BIT)) continue;
      rising++;
      const rt = decodeRiseTop(q);
      if (rt + tMax <= topY) continue;
      const y = rt + sampleTerrain(h.terrain, HEIGHT_ORIGIN + i + 0.5, HEIGHT_ORIGIN + j + 0.5);
      if (y > topY) topY = y;
    }
  });
  return { total, known, rising, topY };
}

/** polygonRoofCaps, and how many footprints the height field dropped (as opposed to the classifier roofs). */
export function polygonRoofCapsDetailed(
  pk: PackedFootprints, roof: RoofInput, top: Float32Array | null, grid: Grid | null, heights: HeightsView | null = null
): { caps: Uint8Array; droppedByField: number } {
  const nPolys = pk.polyRings.length - 1;
  const caps = new Uint8Array(nPolys);
  const { coords, ringStarts, polyRings } = pk;
  const xs: number[] = [];
  let droppedByField = 0;
  for (let p = 0; p < nPolys; p++) {
    const s = ringStarts[polyRings[p]!]!, e = ringStarts[polyRings[p]! + 1]!;
    let roofY = Number.isFinite(roof.overtureTop[p]!) ? roof.overtureTop[p]! : -Infinity;
    // the height field, when it has measured half the footprint: it replaces the classifier's coarse top
    if (heights && e > s) {
      const v = fieldVerdict(pk, p, xs, heights);
      if (v.total > 0 && v.known >= v.total * FIELD_MIN_KNOWN_SHARE) {
        if (v.rising < FIELD_MIN_RISING_TEXELS) {
          caps[p] = 0;
          droppedByField++;
          continue;
        }
        if (v.topY > roofY) roofY = v.topY;
        caps[p] = encodeRoofCap(roofY + roof.marginM - roof.base[p]!);
        continue;
      }
    }
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
  return { caps, droppedByField };
}

/** One stencil build request: footprints (and their roof input) ride along only with a new set id. */
export interface CutoutJob {
  readonly setId: number;
  readonly packed?: PackedFootprints | undefined;
  /** with `packed`, when opts.roofCap is on */
  readonly roof?: RoofInput | undefined;
  readonly opts: FootprintMaskOptions;
  readonly classifier: ClassifierInput | null;
  /**
   * Bumped by main when a height chunk flips any kept or rough bit; a new value re-rasters the footprints
   * (the field itself never rides the job: the worker holds it and passes a reference to `build`).
   */
  readonly keepVersion?: number;
}

export interface CutoutStats {
  coverage: CoverageGap | null;
  /** classifier cells painted into the stencil */
  gapCells: number;
  /** the Overture raster was rebuilt (not the cached one reused) */
  baseRebuilt: boolean;
  /** footprints dropped because the mesh does not rise over them (cap byte 0) */
  dropped: number;
  /** classifier gap cells dropped by the roofed-over rule */
  unroofedCells: number;
  /** of `dropped`, the footprints the height field found flat (fewer than 20 rising texels) */
  droppedByField: number;
  /** texels the footprints grew into the connected mesh (growFootprints) */
  grown: number;
  /** candidate texels past the growth bound that still rose: the survey's "is 8 m short" count */
  grownTruncated: number;
  /** texels the height field marks rough (canopy), over the whole square */
  rough: number;
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
 * building cells and roof tops byte for byte, and the height field's keep version (bumped when a chunk
 * flips a kept or rough bit; the 13 MB field is not digested). The same digest as the last
 * posted job means the build would come out the same, so it is not posted.
 */
export function cutoutInputDigest(
  setId: number, opts: FootprintMaskOptions, classifier: ClassifierInput | null, keepVersion = 0
): string {
  const cl = classifier;
  const head = new TextEncoder().encode(`${setId}|${JSON.stringify(opts)}|k${keepVersion}|${cl
    ? `${cl.grid.n},${cl.grid.cell},${cl.grid.half},${cl.reachM ?? 3},${cl.roofMinM ?? ROOF_MIN_M},${cl.top ? 't' : '-'}${cl.lowRise ? 'l' : '-'}`
    : '-'}`);
  const parts: ArrayBufferView[] = [head];
  if (cl) {
    parts.push(cl.structure);
    if (cl.top) parts.push(cl.top);
    if (cl.lowRise) parts.push(cl.lowRise);
  }
  return digestBytes(...parts);
}

export type CutoutBuild =
  | ({
    changed: true; mask: FootprintMask; cells: Uint8Array | null; /** digestBytes of mask.data */ digest: string;
    /**
     * the undilated footprints plus the same gap cells, traced into wall segments (stencilTrace.ts,
     * SEG_STRIDE floats each): what the car hits. Not the dilated `mask`: its 2 m band is there so
     * leaning facades survive the cut, and as a wall it stood up to 2 m off every facade
     */
    segments: Float32Array; traceMs: number;
  } & CutoutStats)
  | ({ changed: false } & CutoutStats);

/**
 * The hybrid stencil, Overture at 1 m UNION the classifier's gap cells.
 * Holds the footprints and their dilated raster per set (and the undilated
 * one it grew from, which the car's walls trace), so a classifier
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
  /** the undilated raster `base` grew from (=== base when nothing dilated): the walls trace from it */
  private core: FootprintMask | null = null;
  private baseKey = '';
  private baseGrow: GrowStats = { grown: 0, grownTruncated: 0 };
  private baseDroppedByField = 0;
  private baseCaps: Uint8Array | null = null;
  private lastCells: Uint8Array | null = null;
  private lastSent = false;

  /**
   * @param heights the worker's height field and terrain, by reference (never copied), or null while there is
   *   none: the footprints then fill, drop and cap as they did before the field existed
   */
  build(job: CutoutJob, heights: HeightsView | null = null): CutoutBuild {
    if (job.packed) {
      this.setId = job.setId;
      this.packed = job.packed;
      this.roof = job.roof ?? null;
      this.base = null;
      this.core = null;
      this.lastSent = false;
    }
    if (!this.packed || this.setId !== job.setId) throw new Error(`cutout: footprint set ${job.setId} was never sent`);
    const key = `${JSON.stringify(job.opts)}|${heights ? `k${job.keepVersion ?? 0}` : '-'}`;
    const cl = job.classifier;
    // the roof samples stream in with the tiles: a changed cap (or a footprint the mesh turns out
    // not to rise over) re-rasters, an unchanged one reuses the cached raster
    const capped = this.roof ? polygonRoofCapsDetailed(this.packed, this.roof, cl?.top ?? null, cl?.grid ?? null, heights) : null;
    const caps = capped?.caps ?? null;
    let baseRebuilt = false;
    if (!this.base || this.baseKey !== key || !sameCells(caps, this.baseCaps)) {
      const layers = footprintMaskLayers(this.packed, job.opts, caps, heights);
      this.base = layers.mask;
      this.core = layers.core;
      this.baseGrow = layers;
      this.baseDroppedByField = capped?.droppedByField ?? 0;
      this.baseKey = key;
      this.baseCaps = caps;
      this.lastSent = false;
      baseRebuilt = true;
    }
    const base = this.base, core = this.core!;
    const cells = cl ? classifierCells(cl.structure, cl.grid, base, cl.reachM ?? 3) : null;
    const unroofedCells = cells && cl?.lowRise ? requireRoofed(cells, cl.grid, cl.lowRise, cl.roofMinM ?? ROOF_MIN_M) : 0;
    const coverage = cl && cells ? classifierGapFromCells(cl.structure, cl.grid, cells) : null;
    let dropped = 0;
    if (caps) for (let p = 0; p < caps.length; p++) if (caps[p] === 0) dropped++;
    let gapCells = 0;
    if (cells) for (let c = 0; c < cells.length; c++) if (cells[c] === CELL_GAP) gapCells++;
    const rough = heights ? heights.field.chunkRough.reduce((a, v) => a + v, 0) : 0;
    const stats: CutoutStats = {
      coverage, gapCells, baseRebuilt, dropped, unroofedCells, droppedByField: this.baseDroppedByField,
      grown: this.baseGrow.grown, grownTruncated: this.baseGrow.grownTruncated, rough
    };
    if (this.lastSent && sameCells(cells, this.lastCells)) return { changed: false, ...stats };
    const mask: FootprintMask = { ...base, data: base.data.slice() };
    if (cells && cl) paintGapCells(mask, cells, cl.grid, MASK_ON, heights);
    this.lastCells = cells;
    this.lastSent = true;
    const t0 = performance.now();
    let segments: Float32Array;
    if (core === base) {
      segments = traceStencil(mask, 0.5, base);
    } else if (cells && cl) {
      // the walls: the undilated raster plus the same gap cells. A gap cell has no dilated texel
      // within reach, so its texels are empty in `core` and taking them back out restores it exactly.
      // Grown texels (up to 8 m out) are in `core` and so in `base`, which picks the gap cells: none is ever in one
      paintGapCells(core, cells, cl.grid, MASK_ON, heights);
      try {
        segments = traceStencil(core, 0.5, base);
      } finally {
        paintGapCells(core, cells, cl.grid, 0, heights);
      }
    } else {
      segments = traceStencil(core, 0.5, base);
    }
    const traceMs = performance.now() - t0;
    return {
      changed: true, mask, cells: cells ? cells.slice() : null, digest: digestBytes(mask.data), segments, traceMs, ...stats
    };
  }
}

function sameCells(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}
