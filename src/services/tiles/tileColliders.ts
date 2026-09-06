/**
 * Building colliders from streamed photogrammetry tiles.
 *
 * A Google tile is one merged mesh (ground + buildings + trees), so per-mesh
 * bounds say nothing about buildings. Each tile is rasterized once: every
 * triangle's height is stamped into a 10 m height grid over its footprint.
 * Compositing the rasters gives the photogrammetry surface (a DSM).
 *
 * Ground level is then estimated from that surface alone, by morphological
 * opening — a min filter followed by a max filter at a radius wider than a
 * city block. Opening is exact on a slope (min then max of a linear ramp
 * returns the ramp), so hills survive it, while anything narrower than the
 * window is erased. A cell is a building when the surface stands
 * `BUILDING_RISE_M` above that estimate.
 *
 * It deliberately does NOT compare against the elevation-grid terrain. That
 * grid is 87 m samples smoothed with a bicubic, which is fine over flat
 * downtowns and badly wrong on hills: in San Francisco the smoothing error
 * alone exceeded the threshold, so whole hillsides became invisible walls
 * and the map filled with collision nobody could see.
 *
 * Building cells merge into AABBs: runs along X, then identical runs stack
 * across rows.
 */
import { Vector3, Box3, type Object3D, type Mesh } from 'three';
import { WORLD_M_PER_M } from '../../core/geo/ecef.ts';
import type { BuildingCollider } from '../../core/physics/VehicleBody.ts';
import type { Heightfield } from '../../core/heightfield.ts';

/** 10 units = 10 m cells. */
const CELL = 10;
/**
 * Opening radius in cells (6 = 60 m, a 120 m window). Wider than a city
 * block so buildings are erased from the ground estimate; narrow enough that
 * only a sharp hill crest gets shaved, and then by well under the threshold.
 */
const GROUND_K = 6;
/**
 * Real meters above the estimated ground that make a cell a building.
 * Set to 3.5m (~12ft) to capture 1-story commercial/residential structures,
 * building annexes, and low-rise historical architecture (e.g. New Orleans French Quarter)
 * while ignoring road crowns, curbs, and parked vehicles (<2m).
 */
const BUILDING_RISE_M = 3.5;
/**
 * Height threshold above morphological ground where AmortizedGroundBuilder
 * flattens the physics ground to the opened base b under buildings and bridge decks.
 * Kept at 8.0m so gradual slopes, curved hills, knolls, and road embankments
 * preserve their driveable surface in the physics ground rather than dropping to b.
 */
const GROUND_BUILDING_RISE_M = 8.0;
/**
 * Height gap between the physics ground and photogrammetry surface.
 * Kept at 5cm so 3D tile pavement sits cleanly above the continuous terrain underlay
 * while vehicle tires contact the pavement directly rather than hovering.
 */
export const TILE_GROUND_GAP = 0.05;

export interface Grid {
  readonly cell: number;
  readonly half: number;
  readonly n: number;
}

export interface TileRaster {
  readonly i0: number;
  readonly j0: number;
  readonly w: number;
  readonly h: number;
  /** Highest surface per cell: roofs, canopy, wall tops. */
  readonly top: Float32Array;
  /** Lowest surface per cell: the street under canopy or a bridge deck; a roof inside a building. */
  readonly low: Float32Array;
  /** Vertical height band bitmask (1.5m per bit) relative to y0 for underpass clearance detection. */
  readonly mask?: Uint32Array;
  readonly y0?: number;
}

export function gridFor(ground: Heightfield): Grid {
  return { cell: CELL, half: ground.size / 2, n: Math.ceil(ground.size / CELL) };
}

export function sampleTerrain(grid: Grid, ground: Heightfield): Float32Array {
  const { n, cell, half } = grid;
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      out[j * n + i] = ground.sample(-half + (i + 0.5) * cell, -half + (j + 0.5) * cell);
    }
  }
  return out;
}

const _tri = [new Vector3(), new Vector3(), new Vector3()] as const;

/**
 * Height grid over the object's footprint: every cell center inside a
 * triangle takes the triangle plane's height there, and every vertex stamps
 * its own cell so walls (no footprint) and slivers still register. Stamping
 * a triangle's max over its whole footprint would smear the high end of any
 * large sloped triangle downhill and turn hillsides into "buildings".
 */
export function rasterizeTile(obj: Object3D, grid: Grid): TileRaster | null {
  const { n, cell, half } = grid;
  obj.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(obj);
  if (bounds.isEmpty() || bounds.max.x < -half || bounds.min.x >= half || bounds.max.z < -half || bounds.min.z >= half) {
    return null;
  }
  const cellOf = (v: number): number => Math.min(n - 1, Math.max(0, Math.floor((v + half) / cell)));
  const i0 = cellOf(bounds.min.x), i1 = cellOf(bounds.max.x);
  const j0 = cellOf(bounds.min.z), j1 = cellOf(bounds.max.z);
  const w = i1 - i0 + 1, h = j1 - j0 + 1;
  const BIN_SIZE = 1.5;
  const y0 = bounds.min.y;
  const top = new Float32Array(w * h).fill(-Infinity);
  const low = new Float32Array(w * h).fill(Infinity);
  const mask = new Uint32Array(w * h);
  const stampRange = (i: number, j: number, yA: number, yB: number): void => {
    if (i < i0 || i > i1 || j < j0 || j > j1) return;
    const idx = (j - j0) * w + (i - i0);
    const minY = Math.min(yA, yB);
    const maxY = Math.max(yA, yB);
    if (maxY > top[idx]!) top[idx] = maxY;
    if (minY < low[idx]!) low[idx] = minY;
    const b0 = Math.min(31, Math.max(0, Math.floor((minY - y0) / BIN_SIZE)));
    const b1 = Math.min(31, Math.max(0, Math.floor((maxY - y0) / BIN_SIZE)));
    if (b0 <= b1) {
      const rangeBits = (0xFFFFFFFF >>> (31 - (b1 - b0))) << b0;
      mask[idx] = (mask[idx]! | (rangeBits >>> 0)) >>> 0;
    }
  };
  const stamp = (i: number, j: number, y: number): void => stampRange(i, j, y, y);
  const [a, b, c] = _tri;
  obj.traverse(o => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.index;
    const triCount = (index ? index.count : pos.count) / 3;
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
        _tri[k]!.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld);
      }
      const minY = Math.min(a.y, b.y, c.y), maxY = Math.max(a.y, b.y, c.y);
      const det = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
      const nx = (b.y - a.y) * (c.z - a.z) - (c.y - a.y) * (b.z - a.z);
      const nz = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
      const nHoriz = Math.hypot(nx, nz);
      // A steep wall, pier face, or facade has normal pointing mostly horizontally (slope > 63°: nHoriz > 2.0 * |det|)
      const isSteepWall = Math.abs(det) < 1e-9 || (nHoriz > 2.0 * Math.abs(det) && maxY - minY >= BIN_SIZE);

      if (isSteepWall) {
        // Step along all 3 edges of steep vertical walls so thin facades/piers
        // continuously stamp every cell they cross with their true edge segment height
        const stepEdge = (p1: { x: number; y: number; z: number }, p2: { x: number; y: number; z: number }) => {
          const len = Math.hypot(p2.x - p1.x, p2.z - p1.z);
          const steps = Math.max(1, Math.ceil(len / (cell * 0.5)));
          for (let s = 0; s < steps; s++) {
            const f0 = s / steps;
            const f1 = (s + 1) / steps;
            const x = p1.x + (p2.x - p1.x) * f0;
            const z = p1.z + (p2.z - p1.z) * f0;
            const yA = p1.y + (p2.y - p1.y) * f0;
            const yB = p1.y + (p2.y - p1.y) * f1;
            if (x >= -half && x < half && z >= -half && z < half) {
              stampRange(cellOf(x), cellOf(z), yA, yB);
            }
          }
          if (p2.x >= -half && p2.x < half && p2.z >= -half && p2.z < half) {
            stamp(cellOf(p2.x), cellOf(p2.z), p2.y);
          }
        };
        stepEdge(a, b);
        stepEdge(b, c);
        stepEdge(c, a);
        if (Math.abs(det) < 1e-9) continue;
      } else if (Math.abs(det) < 1e-9) {
        continue;
      }

      // Stamp centroid height so small triangles register accurately
      const midX = (a.x + b.x + c.x) / 3, midZ = (a.z + b.z + c.z) / 3;
      if (midX >= -half && midX < half && midZ >= -half && midZ < half) {
        stamp(cellOf(midX), cellOf(midZ), (a.y + b.y + c.y) / 3);
      }

      const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x);
      const minZ = Math.min(a.z, b.z, c.z), maxZ = Math.max(a.z, b.z, c.z);
      if (maxX < -half || minX >= half || maxZ < -half || minZ >= half) continue;
      const ia = Math.max(i0, cellOf(minX)), ib = Math.min(i1, cellOf(maxX));
      const ja = Math.max(j0, cellOf(minZ)), jb = Math.min(j1, cellOf(maxZ));
      for (let j = ja; j <= jb; j++) {
        const cz = -half + (j + 0.5) * cell;
        for (let i = ia; i <= ib; i++) {
          const cx = -half + (i + 0.5) * cell;
          const l1 = ((cx - a.x) * (c.z - a.z) - (c.x - a.x) * (cz - a.z)) / det;
          const l2 = ((b.x - a.x) * (cz - a.z) - (cx - a.x) * (b.z - a.z)) / det;
          const l0 = 1 - l1 - l2;
          if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
          stamp(i, j, l0 * a.y + l1 * b.y + l2 * c.y);
        }
      }
    }
  });
  return { i0, j0, w, h, top, low, mask, y0 };
}

/**
 * Separable sliding-window extreme with radius k, O(cells) via a monotonic
 * deque — the window is 120 m wide, so a naive scan would be 13× the work.
 * Cells holding the `skip` sentinel take no part and come back as `skip`
 * when the whole window is empty.
 */
function windowExtreme(src: Float32Array, n: number, k: number, min: boolean, skip: number): Float32Array {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const deque = new Int32Array(n);
  const beats = (a: number, b: number): boolean => (min ? a <= b : a >= b);
  const pass = (from: Float32Array, to: Float32Array, byRow: boolean): void => {
    for (let a = 0; a < n; a++) {
      const at = (b: number): number => from[byRow ? a * n + b : b * n + a]!;
      let head = 0, tail = 0;
      for (let b = 0; b < n + k; b++) {
        if (b < n && at(b) !== skip) {
          while (tail > head && beats(at(b), at(deque[tail - 1]!))) tail--;
          deque[tail++] = b;
        }
        const c = b - k;
        if (c < 0) continue;
        while (tail > head && deque[head]! < c - k) head++;
        const v = tail > head ? at(deque[head]!) : skip;
        if (byRow) to[a * n + c] = v;
        else to[c * n + a] = v;
      }
    }
  };
  pass(src, tmp, true);
  pass(tmp, out, false);
  return out;
}

export const NO_DATA = -Infinity;

/**
 * Ground level under the photogrammetry surface: a morphological opening
 * (min then max) at `GROUND_K`. Cells with no tile coverage stay NO_DATA,
 * and so do cells whose whole window is uncovered — a missing collider is
 * far cheaper than a false one.
 */
export function groundEstimate(top: Float32Array, n: number, k = GROUND_K): Float32Array {
  const mins = windowExtreme(top, n, k, true, NO_DATA);
  const ground = windowExtreme(mins, n, k, false, NO_DATA);
  // the window is truncated at the border, which biases the estimate low on
  // the uphill edge of any slope and paints a wall there; that strip is
  // inside the physics bounce zone, so simply declare no ground in it
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (i < k || j < k || i >= n - k || j >= n - k) ground[j * n + i] = NO_DATA;
    }
  }
  return ground;
}

/** Max over all tile rasters on the full grid; -Infinity where no tile has data. */
function compositeTops(rasters: readonly (TileRaster | null)[], n: number): Float32Array {
  return composite(rasters, n, true);
}

/** Min over all tile rasters; +Infinity where no tile has data. */
function compositeLows(rasters: readonly (TileRaster | null)[], n: number): Float32Array {
  return composite(rasters, n, false);
}

function composite(rasters: readonly (TileRaster | null)[], n: number, max: boolean): Float32Array {
  const out = new Float32Array(n * n).fill(max ? -Infinity : Infinity);
  for (const r of rasters) {
    if (!r) continue;
    const src = max ? r.top : r.low;
    for (let j = 0; j < r.h; j++) {
      const g = (r.j0 + j) * n + r.i0;
      const l = j * r.w;
      for (let i = 0; i < r.w; i++) {
        const v = src[l + i]!;
        if (max ? v > out[g + i]! : v < out[g + i]!) out[g + i] = v;
      }
    }
  }
  return out;
}

/**
 * Incrementally builds the shared ground heightfield row-by-row across frames,
 * bounding execution time to ~1.5-2ms per frame to eliminate main-thread hitches
 * during runtime tile refinement.
 */
export class AmortizedGroundBuilder {
  readonly n: number;
  readonly cell: number;
  private readonly terrainTop: Float32Array;
  private readonly rasters: readonly (TileRaster | null)[];
  private readonly k: number;
  private readonly rise: number;

  private phase = 0;
  private row = 0;

  private top: Float32Array;
  private low: Float32Array;
  private minsTmp: Float32Array;
  private mins: Float32Array;
  private groundTmp: Float32Array;
  private ground: Float32Array;
  private raw: Float32Array;
  private out: Float32Array;
  private deque: Int32Array;

  done = false;
  result: Float32Array | null = null;

  constructor(
    rasters: readonly (TileRaster | null)[],
    grid: Grid,
    terrainTop: Float32Array,
    reliefBoost = 1
  ) {
    this.n = grid.n;
    this.cell = grid.cell;
    this.terrainTop = terrainTop;
    this.rasters = rasters;
    this.k = GROUND_K;
    this.rise = GROUND_BUILDING_RISE_M * WORLD_M_PER_M * reliefBoost;

    const total = this.n * this.n;
    this.top = new Float32Array(total).fill(-Infinity);
    this.low = new Float32Array(total).fill(Infinity);
    this.minsTmp = new Float32Array(total);
    this.mins = new Float32Array(total);
    this.groundTmp = new Float32Array(total);
    this.ground = new Float32Array(total);
    this.raw = new Float32Array(total);
    this.out = new Float32Array(total);
    this.deque = new Int32Array(this.n);
  }

  /**
   * Run one slice of the computation up to budgetMs (or until complete if budgetMs is Infinity).
   * Returns true if completed, false if more work remains.
   */
  step(budgetMs = 2.0): boolean {
    if (this.done) return true;
    const start = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const n = this.n;
    const k = this.k;
    const deque = this.deque;

    while (!this.done) {
      // Phase 0: Composite tops and lows from rasters
      if (this.phase === 0) {
        const batchEnd = Math.min(this.rasters.length, this.row + 30);
        for (; this.row < batchEnd; this.row++) {
          const r = this.rasters[this.row];
          if (!r) continue;
          for (let j = 0; j < r.h; j++) {
            const g = (r.j0 + j) * n + r.i0;
            const l = j * r.w;
            for (let i = 0; i < r.w; i++) {
              const tv = r.top[l + i]!;
              if (tv > this.top[g + i]!) this.top[g + i] = tv;
              const lv = r.low[l + i]!;
              if (lv < this.low[g + i]!) this.low[g + i] = lv;
            }
          }
        }
        if (this.row >= this.rasters.length) {
          this.phase = 1;
          this.row = 0;
        }
      }
      // Phase 1: windowExtreme MIN - Pass 1 by rows
      else if (this.phase === 1) {
        const batchEnd = Math.min(n, this.row + 40);
        for (; this.row < batchEnd; this.row++) {
          const a = this.row;
          let head = 0, tail = 0;
          for (let b = 0; b < n + k; b++) {
            if (b < n) {
              const val = this.top[a * n + b]!;
              if (val !== NO_DATA) {
                while (tail > head && val <= this.top[a * n + deque[tail - 1]!]!) tail--;
                deque[tail++] = b;
              }
            }
            const c = b - k;
            if (c < 0) continue;
            while (tail > head && deque[head]! < c - k) head++;
            this.minsTmp[a * n + c] = tail > head ? this.top[a * n + deque[head]!]! : NO_DATA;
          }
        }
        if (this.row >= n) {
          this.phase = 2;
          this.row = 0;
        }
      }
      // Phase 2: windowExtreme MIN - Pass 2 by cols
      else if (this.phase === 2) {
        const batchEnd = Math.min(n, this.row + 40);
        for (; this.row < batchEnd; this.row++) {
          const a = this.row;
          let head = 0, tail = 0;
          for (let b = 0; b < n + k; b++) {
            if (b < n) {
              const val = this.minsTmp[b * n + a]!;
              if (val !== NO_DATA) {
                while (tail > head && val <= this.minsTmp[deque[tail - 1]! * n + a]!) tail--;
                deque[tail++] = b;
              }
            }
            const c = b - k;
            if (c < 0) continue;
            while (tail > head && deque[head]! < c - k) head++;
            this.mins[c * n + a] = tail > head ? this.minsTmp[deque[head]! * n + a]! : NO_DATA;
          }
        }
        if (this.row >= n) {
          this.phase = 3;
          this.row = 0;
        }
      }
      // Phase 3: windowExtreme MAX - Pass 1 by rows
      else if (this.phase === 3) {
        const batchEnd = Math.min(n, this.row + 40);
        for (; this.row < batchEnd; this.row++) {
          const a = this.row;
          let head = 0, tail = 0;
          for (let b = 0; b < n + k; b++) {
            if (b < n) {
              const val = this.mins[a * n + b]!;
              if (val !== NO_DATA) {
                while (tail > head && val >= this.mins[a * n + deque[tail - 1]!]!) tail--;
                deque[tail++] = b;
              }
            }
            const c = b - k;
            if (c < 0) continue;
            while (tail > head && deque[head]! < c - k) head++;
            this.groundTmp[a * n + c] = tail > head ? this.mins[a * n + deque[head]!]! : NO_DATA;
          }
        }
        if (this.row >= n) {
          this.phase = 4;
          this.row = 0;
        }
      }
      // Phase 4: windowExtreme MAX - Pass 2 by cols
      else if (this.phase === 4) {
        const batchEnd = Math.min(n, this.row + 40);
        for (; this.row < batchEnd; this.row++) {
          const a = this.row;
          let head = 0, tail = 0;
          for (let b = 0; b < n + k; b++) {
            if (b < n) {
              const val = this.groundTmp[b * n + a]!;
              if (val !== NO_DATA) {
                while (tail > head && val >= this.groundTmp[deque[tail - 1]! * n + a]!) tail--;
                deque[tail++] = b;
              }
            }
            const c = b - k;
            if (c < 0) continue;
            while (tail > head && deque[head]! < c - k) head++;
            this.ground[c * n + a] = tail > head ? this.groundTmp[deque[head]! * n + a]! : NO_DATA;
          }
        }
        if (this.row >= n) {
          this.phase = 5;
          this.row = 0;
        }
      }
      // Phase 5: Border mask & raw heights with seam closure clamp
      else if (this.phase === 5) {
        const batchEnd = Math.min(n, this.row + 40);
        for (; this.row < batchEnd; this.row++) {
          const j = this.row;
          const isBorderJ = j < k || j >= n - k;
          for (let i = 0; i < n; i++) {
            const c = j * n + i;
            if (isBorderJ || i < k || i >= n - k) {
              this.ground[c] = NO_DATA;
            }
            const t = this.top[c]!, b = this.ground[c]!;
            if (t === NO_DATA || b === NO_DATA) {
              this.raw[c] = this.terrainTop[c]!;
            } else {
              const tileGround = (t - b >= this.rise) ? b : Math.max(b - 0.5, Math.min(t, this.low[c]!));
              this.raw[c] = tileGround + TILE_GROUND_GAP;
            }
          }
        }
        if (this.row >= n) {
          this.phase = 6;
          this.row = 0;
        }
      }
      // Phase 6: 3x3 smoothing blur
      else if (this.phase === 6) {
        const batchEnd = Math.min(n, this.row + 40);
        for (; this.row < batchEnd; this.row++) {
          const j = this.row;
          for (let i = 0; i < n; i++) {
            let sum = 0, count = 0;
            for (let dj = -1; dj <= 1; dj++) {
              const jj = j + dj;
              if (jj < 0 || jj >= n) continue;
              for (let di = -1; di <= 1; di++) {
                const ii = i + di;
                if (ii < 0 || ii >= n) continue;
                sum += this.raw[jj * n + ii]!;
                count++;
              }
            }
            this.out[j * n + i] = sum / count;
          }
        }
        if (this.row >= n) {
          this.done = true;
          this.result = this.out;
          return true;
        }
      }

      const elapsed = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - start;
      if (elapsed >= budgetMs) {
        return false;
      }
    }

    return true;
  }
}

/**
 * The one ground the whole game plays on, per cell. Where tiles cover a cell
 * it is the tile surface: the lowest one, so streets survive tree canopy and
 * bridge decks, and the opened base under anything tall enough to be a
 * building. Cells without coverage fall back to the elevation-grid terrain,
 * which the tiles were calibrated against, so the seam is small. A 3×3 box
 * takes the 10 m quantisation off the result before it becomes a heightfield.
 */
export function groundField(
  rasters: readonly (TileRaster | null)[],
  grid: Grid,
  terrainTop: Float32Array,
  reliefBoost = 1
): Float32Array {
  const builder = new AmortizedGroundBuilder(rasters, grid, terrainTop, reliefBoost);
  builder.step(Infinity);
  return builder.result!;
}

/**
 * How far the tile ground sits above the terrain over the field core, or
 * null without enough data. Tiles are placed by height above the WGS84
 * ellipsoid while the elevation grid is above mean sea level; the geoid runs
 * ~20 m below the ellipsoid around Portland, which buried bridge decks and
 * ground floors. Measuring beats shipping a geoid model.
 *
 * Location Tuning Note:
 * The 15th percentile (0.15) was chosen based on calibration across Portland (low flat
 * river valley with elevated bridges where 30th percentile previously submerged road approaches)
 * and dense urban canyons (Midtown Manhattan and San Francisco hills where coarse 87m elevation
 * samples interpolate across valleys). The 15th percentile lands inside the true ground cluster
 * while keeping 85%+ of tile streets strictly at or above the terrain underlay datum.
 */
export function tileGroundOffset(
  rasters: readonly (TileRaster | null)[],
  grid: Grid,
  terrainTop: Float32Array,
  coreHalfUnits = 200
): number | null {
  const { n, cell } = grid;
  const ground = groundEstimate(compositeTops(rasters, n), n);
  const c0 = Math.max(0, Math.floor(n / 2 - coreHalfUnits / cell));
  const c1 = Math.min(n - 1, Math.ceil(n / 2 + coreHalfUnits / cell));
  const diffs: number[] = [];
  for (let j = c0; j <= c1; j++) {
    for (let i = c0; i <= c1; i++) {
      const c = j * n + i;
      if (ground[c] !== NO_DATA) diffs.push(ground[c]! - terrainTop[c]!);
    }
  }
  if (diffs.length < 100) return null;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length * 0.15)]!;
}

export function collidersFromRasters(
  rasters: readonly (TileRaster | null)[],
  grid: Grid,
  terrainTop: Float32Array,
  reliefBoost = 1,
  outDeckGrid?: Float32Array
): BuildingCollider[] {
  const { n, cell, half } = grid;
  const top = compositeTops(rasters, n);
  const low = compositeLows(rasters, n);
  const ground = groundEstimate(top, n);
  const rise = BUILDING_RISE_M * WORLD_M_PER_M * reliefBoost;
  const BIN_SIZE = 1.5;

  if (outDeckGrid) {
    outDeckGrid.fill(NO_DATA);
  }

  /**
   * Check if the vehicle driving zone above the ground [g + 1.2m, min(g + 4.5m, t - 1.5m)]
   * has no geometry in any tile raster covering cell c. If clear, the space is an open underpass / bridge span.
   */
  const hasGroundClearance = (c: number, g: number, t: number): boolean => {
    const y2 = Math.min(g + 4.5, t - 1.5);
    let foundRaster = false;
    for (const r of rasters) {
      if (!r || !r.mask || r.y0 === undefined) continue;
      const j = Math.floor(c / n) - r.j0;
      const i = (c % n) - r.i0;
      if (i < 0 || i >= r.w || j < 0 || j >= r.h) continue;
      foundRaster = true;
      const idx = j * r.w + i;
      const m = r.mask[idx]!;
      if (!m) continue;
      // Clearance begins above the ground road surface (at least 1 full height bin above ground)
      const gBin = Math.floor((g - r.y0) / BIN_SIZE);
      const b1 = Math.max(0, gBin + 1);
      const b2 = Math.min(31, Math.floor((y2 - r.y0) / BIN_SIZE));
      if (b1 <= b2) {
        const rangeMask = (0xFFFFFFFF >>> (31 - (b2 - b1))) << b1;
        if ((m & rangeMask) !== 0) {
          // Geometry exists in the driving clearance zone (wall, pier, column)
          return false;
        }
      }
    }
    return foundRaster;
  };

  const getGroundY = (c: number): number => {
    return ground[c] !== NO_DATA ? ground[c]! : terrainTop[c]!;
  };

  /**
   * Check if an elevated span is a bridge deck, viaduct, overpass, or approach ramp:
   * 1. Narrow roadway ribbon (width <= 2 cells, i.e. <= 20m in X or Z) - covers 1-2 lane bridges, overpasses, ramps.
   * 2. Multi-lane bridge ribbon (width <= 6 cells, i.e. <= 60m in X or Z) with significant length
   *    (length >= 5 cells, i.e. >= 50m, and length >= width + 2) - covers major interstate and river bridges across all lanes.
   * Broad squarish buildings (e.g. 40m x 40m warehouses with gabled roofs) are excluded.
   */
  const isNarrowSpan = (c: number): boolean => {
    const cx = c % n;
    const cz = Math.floor(c / n);

    // Continuous elevated span in X (drop on West and East)
    let spanWest = 0;
    for (let dx = -1; cx + dx >= 0; dx--) {
      const nb = cz * n + (cx + dx);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + 2.5) break;
      spanWest++;
      if (spanWest > 6) break;
    }
    let spanEast = 0;
    for (let dx = 1; cx + dx < n; dx++) {
      const nb = cz * n + (cx + dx);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + 2.5) break;
      spanEast++;
      if (spanEast > 6) break;
    }
    const widthX = spanWest + 1 + spanEast;

    // Continuous elevated span in Z (drop on South and North)
    let spanSouth = 0;
    for (let dz = -1; cz + dz >= 0; dz--) {
      const nb = (cz + dz) * n + cx;
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + 2.5) break;
      spanSouth++;
      if (spanSouth > 6) break;
    }
    let spanNorth = 0;
    for (let dz = 1; cz + dz < n; dz++) {
      const nb = (cz + dz) * n + cx;
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + 2.5) break;
      spanNorth++;
      if (spanNorth > 6) break;
    }
    const widthZ = spanSouth + 1 + spanNorth;

    // Narrow span in either axis (1-2 cells wide: <= 20m)
    if (widthX <= 2 || widthZ <= 2) return true;

    // Check diagonal extents for angled bridges
    let diag1 = 0;
    for (let d = 1; cx + d < n && cz + d < n; d++) {
      const nb = (cz + d) * n + (cx + d);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + 2.5) break;
      diag1++;
      if (diag1 > 10) break;
    }
    for (let d = 1; cx - d >= 0 && cz - d >= 0; d++) {
      const nb = (cz - d) * n + (cx - d);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + 2.5) break;
      diag1++;
      if (diag1 > 10) break;
    }

    let diag2 = 0;
    for (let d = 1; cx + d < n && cz - d >= 0; d++) {
      const nb = (cz - d) * n + (cx + d);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + 2.5) break;
      diag2++;
      if (diag2 > 10) break;
    }
    for (let d = 1; cx - d >= 0 && cz + d < n; d++) {
      const nb = (cz + d) * n + (cx - d);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + 2.5) break;
      diag2++;
      if (diag2 > 10) break;
    }

    const minCross = Math.min(widthX, widthZ);
    const maxLen = Math.max(widthX, widthZ, diag1 + 1, diag2 + 1);

    // Multi-lane bridge ribbon (width <= 6 cells = 60m, length >= 5 cells = 50m, length >= width + 2)
    return minCross <= 6 && maxLen >= 5 && maxLen >= minCross + 2;
  };

  /**
   * Check if a cell is on a roadway ribbon (width <= 6 cells = 60m in either X or Z)
   * transitioning down towards ground level.
   * Unlike isNarrowSpan, this does not require a minimum elevated length of 5 cells,
   * so approach ramps are recognized all the way down to ground level (<= 1.0m above ground).
   */
  const isRoadwayRibbon = (c: number): boolean => {
    const cx = c % n;
    const cz = Math.floor(c / n);
    let spanWest = 0;
    for (let dx = -1; cx + dx >= 0; dx--) {
      const nb = cz * n + (cx + dx);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + 1.0) break;
      spanWest++;
      if (spanWest > 6) break;
    }
    let spanEast = 0;
    for (let dx = 1; cx + dx < n; dx++) {
      const nb = cz * n + (cx + dx);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + 1.0) break;
      spanEast++;
      if (spanEast > 6) break;
    }
    let spanSouth = 0;
    for (let dz = -1; cz + dz >= 0; dz--) {
      const nb = (cz + dz) * n + cx;
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + 1.0) break;
      spanSouth++;
      if (spanSouth > 6) break;
    }
    let spanNorth = 0;
    for (let dz = 1; cz + dz < n; dz++) {
      const nb = (cz + dz) * n + cx;
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + 1.0) break;
      spanNorth++;
      if (spanNorth > 6) break;
    }
    const widthX = spanWest + 1 + spanEast;
    const widthZ = spanSouth + 1 + spanNorth;
    return widthX <= 6 || widthZ <= 6;
  };

  // Pre-classify elevated bridge decks and overhead underpass spans
  const isDeck = new Uint8Array(n * n);
  const isRamp = new Uint8Array(n * n);
  const queue: number[] = [];
  const hasMask = rasters.some(r => r && r.mask);

  for (let c = 0; c < n * n; c++) {
    const t = top[c]!;
    const g = getGroundY(c);
    const l = low[c]!;
    if (t === NO_DATA || g === NO_DATA || t - g < rise) continue;

    const clearanceOk = !hasMask || hasGroundClearance(c, g, t);
    // Bridge deck / viaduct: elevated roadway structure with clear slab thickness (0.8m - 7.0m),
    // clearance below, and a narrow roadway ribbon (1-2 cells wide) dropping off to ground on its sides
    const isThinElevatedDeck =
      l !== Infinity &&
      t - l >= 0.8 &&
      t - l <= 7.0 &&
      l - g >= 4.0 &&
      clearanceOk &&
      isNarrowSpan(c);
    // High overhead underpass span: at least 13m high, narrow span, with confirmed open driving clearance below from mesh mask
    const isUnderpassDeck =
      hasMask &&
      t - g >= 13.0 &&
      hasGroundClearance(c, g, t) &&
      isNarrowSpan(c);

    if (isThinElevatedDeck || isUnderpassDeck) {
      isDeck[c] = 1;
      if (outDeckGrid) outDeckGrid[c] = t;
    }
  }

  // Find terminal boundary cells of elevated decks to seed approach ramps
  for (let c = 0; c < n * n; c++) {
    if (!isDeck[c]) continue;
    const cx = c % n;
    const cz = Math.floor(c / n);
    const hasNonDeckNeighbor =
      (cx > 0 && !isDeck[c - 1]) ||
      (cx < n - 1 && !isDeck[c + 1]) ||
      (cz > 0 && !isDeck[c - n]) ||
      (cz < n - 1 && !isDeck[c + n]);
    if (hasNonDeckNeighbor) {
      queue.push(c);
    }
  }

  // Ramp Continuity Rule: Trace descending road slopes from elevated deck terminals
  // down to ground level to unblock solid approach viaducts (e.g. Brooklyn Bridge earthen approaches).
  // Ramps must be narrow roadway ribbons (isNarrowSpan or isRoadwayRibbon), not broad gabled or pitched building roofs.
  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++]!;
    const cx = curr % n;
    const cz = Math.floor(curr / n);
    const currT = top[curr]!;

    const neighbors = [
      cx > 0 ? curr - 1 : -1,
      cx < n - 1 ? curr + 1 : -1,
      cz > 0 ? curr - n : -1,
      cz < n - 1 ? curr + n : -1,
    ];

    for (const nb of neighbors) {
      if (nb < 0 || isDeck[nb] || isRamp[nb]) continue;
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || gNb === NO_DATA) continue;
      // Only road surface layers (thickness <= 6.0m) or elevated ramp decks with open driving clearance below
      // Thick vertical columns/piers (t - l >= 10m without clearance) are skipped
      const lNb = low[nb];
      const clearanceOk = !hasMask || hasGroundClearance(nb, gNb, tNb);
      if (lNb !== undefined && lNb !== Infinity && tNb - lNb > 6.0 && !clearanceOk) continue;

      // Ramp MUST descend strictly towards the ground along a narrow roadway span
      const drop = currT - tNb;
      if (drop > 0.05 && drop <= 4.5 && tNb >= gNb && (isNarrowSpan(nb) || isRoadwayRibbon(nb))) {
        isRamp[nb] = 1;
        if (outDeckGrid) outDeckGrid[nb] = tNb;
        // Continue downward towards ground; stop once ground level is reached (within 1m of ground)
        if (tNb > gNb + 1.0) {
          queue.push(nb);
        }
      }
    }
  }

  /**
   * Identify cells that are part of gradual, driveable terrain (slopes, hillsides,
   * knolls, crests, road embankments, earth berms) connected to the ground.
   *
   * Morphological opening erases terrain features narrower than the 120m window,
   * under-estimating ground by 3.5m - 7m on curved slopes and knolls.
   * When BUILDING_RISE_M = 3.5m, this causes driveable terrain to be falsely flagged
   * as building colliders ("black boxes").
   *
   * A cell is genuine driveable terrain if it is reachable from ground level
   * (top <= ground + 1.2m) via a continuous path of driveable steps
   * (|top[A] - top[B]| <= 2.8m per 10m cell, <= 28% grade) with no vertical building
   * wall facades (top - low <= 2.8m) and height within 8m of estimated ground.
   *
   * Low-rise buildings (e.g. 4.5m tall in New Orleans) are enclosed by vertical
   * walls (drop >= 3.5m to street, top - low >= 3.5m) so the driveable flood-fill
   * cannot climb onto them; they remain solid building colliders.
   */
  const isDriveableGround = new Uint8Array(n * n);
  const driveQueue: number[] = [];
  const maxDriveStep = 2.8 * WORLD_M_PER_M * reliefBoost;
  const maxCellThick = 2.8 * WORLD_M_PER_M * reliefBoost;
  const maxTerrainRise = 8.0 * WORLD_M_PER_M * reliefBoost;
  const groundBaseTolerance = 1.2 * WORLD_M_PER_M * reliefBoost;

  // Seed with base ground cells (within 1.2m of ground level)
  for (let c = 0; c < n * n; c++) {
    const t = top[c]!;
    const g = getGroundY(c);
    if (t === NO_DATA || g === NO_DATA) continue;
    if (t <= g + groundBaseTolerance) {
      isDriveableGround[c] = 1;
      driveQueue.push(c);
    }
  }

  let driveHead = 0;
  while (driveHead < driveQueue.length) {
    const curr = driveQueue[driveHead++]!;
    const cx = curr % n;
    const cz = Math.floor(curr / n);
    const currT = top[curr]!;

    const neighbors = [
      cx > 0 ? curr - 1 : -1,
      cx < n - 1 ? curr + 1 : -1,
      cz > 0 ? curr - n : -1,
      cz < n - 1 ? curr + n : -1,
    ];

    for (const nb of neighbors) {
      if (nb < 0 || isDriveableGround[nb]) continue;
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || gNb === NO_DATA) continue;

      // Only within 8.0m of estimated ground (shaving lag on hills/embankments);
      // taller structures (>= 8.0m) are buildings or bridges
      if (tNb > gNb + maxTerrainRise) continue;

      // Single surface sheet: no vertical building walls/facades in cell (thickness <= 2.8m)
      const lNb = low[nb];
      if (lNb !== undefined && lNb !== Infinity && tNb - lNb > maxCellThick) continue;

      // Driveable grade: step between adjacent 10m cells <= 2.8m (<= 28% slope)
      const step = Math.abs(tNb - currT);
      if (step > maxDriveStep) continue;

      isDriveableGround[nb] = 1;
      driveQueue.push(nb);
    }
  }

  const isBuilding = (c: number): boolean => {
    const t = top[c]!;
    const g = ground[c]!;
    // Border cells (within GROUND_K = 60m of the map edge) have ground[c] === NO_DATA.
    // We intentionally do NOT fall back to terrainTop here: on steep slopes, terrainTop
    // disagrees with tile elevation at the edges, which would flag steep hillsides as false buildings.
    if (t === NO_DATA || g === NO_DATA || t - g < rise) return false;
    if (isDeck[c] || isRamp[c]) return false;
    // Exempt gradual driveable terrain (slopes, hillsides, knolls, road embankments)
    if (isDriveableGround[c]) return false;
    return true;
  };

  interface BoxExtent {
    b: BuildingCollider;
    i0: number;
    i1: number;
    j0: number;
    j1: number;
  }
  const boxes: BoxExtent[] = [];
  let above = new Map<number, BoxExtent>();
  for (let j = 0; j < n; j++) {
    const z0 = -half + j * cell;
    const row = new Map<number, BoxExtent>();
    let start = -1, hi = -Infinity, lo = Infinity;
    for (let i = 0; i <= n; i++) {
      const c = j * n + i;
      if (i < n && isBuilding(c)) {
        if (start < 0) {
          start = i;
          hi = -Infinity;
          lo = Infinity;
        }
        hi = Math.max(hi, top[c]!);
        // Box floor follows true ground level so buildings extend all the way down to the terrain
        lo = Math.min(lo, getGroundY(c));
        continue;
      }
      if (start < 0) continue;
      const key = start * (n + 1) + i;
      const prev = above.get(key);
      if (prev) {
        prev.b.max.z = z0 + cell;
        prev.b.max.y = Math.max(prev.b.max.y, hi);
        prev.b.min.y = Math.min(prev.b.min.y, lo - 1);
        prev.j1 = j + 1;
        row.set(key, prev);
      } else {
        const b: BuildingCollider = {
          min: new Vector3(-half + start * cell, lo - 1, z0),
          max: new Vector3(-half + i * cell, hi, z0 + cell)
        };
        const ext: BoxExtent = { b, i0: start, i1: i, j0: j, j1: j + 1 };
        boxes.push(ext);
        row.set(key, ext);
      }
      start = -1;
    }
    above = row;
  }

  // Neighbor-aware horizontal insetting:
  // Inset exterior faces that border open streets or non-building cells by 1.0m to prevent
  // 10m quantization steps from protruding into roadway lanes.
  // Internal faces between adjacent building cells remain 100% flush (0m inset) so contiguous
  // buildings are solid with zero gaps, zero cracks, and zero isolated pillars.
  // Freestanding 1-cell columns (isolated piers/towers with no building neighbors on all 4 sides)
  // get a 2.8m inset to snugly hug structural supports.
  for (const { b, i0, i1, j0, j1 } of boxes) {
    let touchSouth = false;
    if (j0 > 0) {
      for (let i = i0; i < i1; i++) {
        if (isBuilding((j0 - 1) * n + i)) { touchSouth = true; break; }
      }
    }
    let touchNorth = false;
    if (j1 < n) {
      for (let i = i0; i < i1; i++) {
        if (isBuilding(j1 * n + i)) { touchNorth = true; break; }
      }
    }
    let touchWest = false;
    if (i0 > 0) {
      for (let j = j0; j < j1; j++) {
        if (isBuilding(j * n + (i0 - 1))) { touchWest = true; break; }
      }
    }
    let touchEast = false;
    if (i1 < n) {
      for (let j = j0; j < j1; j++) {
        if (isBuilding(j * n + i1)) { touchEast = true; break; }
      }
    }

    const width = b.max.x - b.min.x;
    const depth = b.max.z - b.min.z;
    const isIsolatedColumn = (i1 - i0 === 1) && (j1 - j0 === 1) && !touchSouth && !touchNorth && !touchWest && !touchEast;
    const insetMax = isIsolatedColumn ? 2.8 : 1.0;
    const insetX = Math.min(insetMax, Math.max(0, (width - 2) / 2));
    const insetZ = Math.min(insetMax, Math.max(0, (depth - 2) / 2));

    if (!touchWest) b.min.x += insetX;
    if (!touchEast) b.max.x -= insetX;
    if (!touchSouth) b.min.z += insetZ;
    if (!touchNorth) b.max.z -= insetZ;
  }

  return boxes.map(e => e.b);
}

/** Colliders straight from a group of meshes (tests and one-shot use). */
export function buildingCollidersFrom(tiles: Object3D, ground: Heightfield, reliefBoost = 1): BuildingCollider[] {
  const grid = gridFor(ground);
  tiles.updateMatrixWorld(true);
  return collidersFromRasters(
    tiles.children.map(c => rasterizeTile(c, grid)), grid, sampleTerrain(grid, ground), reliefBoost
  );
}
