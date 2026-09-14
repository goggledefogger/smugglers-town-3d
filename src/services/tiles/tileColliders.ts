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
import type { RoadGrid } from '../../services/osm/roads.ts';

export interface ColliderThresholds {
  /** 10 units = 10 m cells. */
  readonly cell: number;
  /** Opening radius in cells (6 = 60 m, a 120 m window) to erase buildings from ground. */
  readonly groundOpeningK: number;
  /** Real meters above estimated ground that make a cell a building (New Orleans 1-story buildings). */
  readonly buildingRiseM: number;
  /** Height threshold above ground where AmortizedGroundBuilder flattens physics ground to base b (preserves gradual slopes). */
  readonly groundBuildingRiseM: number;
  /** Height gap between physics ground and 3D tile surface (5cm to contact pavement cleanly). */
  readonly tileGroundGap: number;
  /** Percentile used for WGS84 ellipsoid vs MSL geoid datum calibration (Portland river valley vs SF hills). */
  readonly datumPercentile: number;
  /** Vertical bin size in meters for underpass clearance detection bitmask. */
  readonly verticalBinSizeM: number;
  /** Vehicle underpass clearance zone: min height above ground road. */
  readonly clearanceDriveMinM: number;
  /** Vehicle underpass clearance zone: max height above ground road to test for open overhead underpass. */
  readonly clearanceDriveMaxM: number;
  /** Clearance margin below structure top surface. */
  readonly clearanceTopMarginM: number;
  /** Min thickness of elevated road slab (m). */
  readonly deckMinThicknessM: number;
  /** Max thickness of elevated road slab (m) (covers roadbed and underside truss). */
  readonly deckMaxThicknessM: number;
  /** Min vertical open clearance below deck (m) (requires at least 4m headroom). */
  readonly deckMinClearanceBelowM: number;
  /** Drop off edge height above ground for bridge ribbon (m). */
  readonly deckDropThresholdM: number;
  /** High overhead underpass span min height (m). */
  readonly underpassMinHeightM: number;
  /** Max width in cells for narrow 1-2 lane bridge spans (2 cells = 20m). */
  readonly narrowSpanMaxWidthCells: number;
  /** Max width in cells for multi-lane bridge spans (6 cells = 60m). */
  readonly multiLaneMaxWidthCells: number;
  /** Min length in cells for multi-lane bridge ribbons (5 cells = 50m). */
  readonly multiLaneMinLengthCells: number;
  /** Min aspect ratio margin (length >= width + aspectMargin). */
  readonly multiLaneAspectMarginCells: number;
  /** Max thickness of approach ramp surface layer (m). */
  readonly rampMaxThicknessM: number;
  /** Max vertical step drop allowed per 10m cell along a descending ramp (m). */
  readonly rampMaxDropPerStepM: number;
  /** Min vertical drop per step to ensure strictly descending ramp (m). */
  readonly rampMinDropPerStepM: number;
  /** Proximity to ground level to terminate ramp tracing (m). */
  readonly rampGroundProximityM: number;
  /** Max elevation step between adjacent 10m cells for driveable terrain (2.8m = 28% grade). */
  readonly driveableMaxStepM: number;
  /** Max cell thickness for driveable terrain (2.8m = single surface sheet, no vertical walls). */
  readonly driveableMaxThicknessM: number;
  /** Max elevation rise above estimated ground for driveable terrain (8.0m = knoll/embankment lag). */
  readonly driveableMaxTerrainRiseM: number;
  /** Ground base tolerance to seed driveable terrain flood fill (1.2m). */
  readonly driveableBaseToleranceM: number;
  /** Inset for exterior building faces bordering street lanes (1.0m to clear 10m quantization). */
  readonly insetExteriorStreetM: number;
  /** Inset for isolated single-cell columns/piers (2.8m to hug structural pillars). */
  readonly insetIsolatedColumnM: number;
  /** Max bicubic smoothing error in meters between 87m DEM terrain and 10m photogrammetry on steep terrain. */
  readonly terrainSmoothingToleranceM: number;
  /** Slope-adaptive rise coefficient scaling building rise with local terrain gradient tan(theta). */
  readonly slopeAdaptiveRiseCoeff: number;
  /** Active driving experiment mode under evaluation. */
  readonly experimentMode?: ColliderExperimentMode;
  /** Slack multiplier for OSM road corridor reach padding (default 0.5; 0.85 in road_carve). */
  readonly roadReachSlackMultiplier?: number;
}

export type ColliderExperimentMode = 'baseline' | 'road_carve' | 'curbside_inset' | 'high_res';

export const DEFAULT_COLLIDER_THRESHOLDS: ColliderThresholds = {
  cell: 10,
  groundOpeningK: 6,
  buildingRiseM: 3.5,
  groundBuildingRiseM: 8.0,
  tileGroundGap: 0.05,
  datumPercentile: 0.15,
  verticalBinSizeM: 1.5,
  clearanceDriveMinM: 1.2,
  clearanceDriveMaxM: 4.5,
  clearanceTopMarginM: 1.5,
  deckMinThicknessM: 0.8,
  deckMaxThicknessM: 7.0,
  deckMinClearanceBelowM: 4.0,
  deckDropThresholdM: 2.5,
  underpassMinHeightM: 13.0,
  narrowSpanMaxWidthCells: 2,
  multiLaneMaxWidthCells: 6,
  multiLaneMinLengthCells: 5,
  multiLaneAspectMarginCells: 2,
  rampMaxThicknessM: 6.0,
  rampMaxDropPerStepM: 4.5,
  rampMinDropPerStepM: 0.05,
  rampGroundProximityM: 1.0,
  driveableMaxStepM: 2.8,
  driveableMaxThicknessM: 2.8,
  driveableMaxTerrainRiseM: 8.0,
  driveableBaseToleranceM: 1.2,
  insetExteriorStreetM: 1.0,
  insetIsolatedColumnM: 2.8,
  terrainSmoothingToleranceM: 8.0,
  slopeAdaptiveRiseCoeff: 12.0,
  experimentMode: 'baseline',
  roadReachSlackMultiplier: 0.5
};

/**
 * Produces collider thresholds for each driving experiment mode.
 */
export function thresholdsForMode(mode: ColliderExperimentMode): ColliderThresholds {
  switch (mode) {
    case 'road_carve':
      return {
        ...DEFAULT_COLLIDER_THRESHOLDS,
        experimentMode: 'road_carve',
        roadReachSlackMultiplier: 0.85
      };
    case 'curbside_inset':
      return {
        ...DEFAULT_COLLIDER_THRESHOLDS,
        experimentMode: 'curbside_inset',
        // Inset exterior street-bordering faces by 2.4m to clear residential lanes from curb overhang
        insetExteriorStreetM: 2.4
      };
    case 'high_res':
      return {
        ...DEFAULT_COLLIDER_THRESHOLDS,
        experimentMode: 'high_res',
        cell: 5,
        groundOpeningK: 12, // 12 * 5m = 60m radius opening, matching physical 60m window
        insetExteriorStreetM: 0.8
      };
    case 'baseline':
    default:
      return {
        ...DEFAULT_COLLIDER_THRESHOLDS,
        experimentMode: 'baseline',
        roadReachSlackMultiplier: 0.5
      };
  }
}

/** 10 units = 10 m cells. */
const CELL = DEFAULT_COLLIDER_THRESHOLDS.cell;
const GROUND_K = DEFAULT_COLLIDER_THRESHOLDS.groundOpeningK;
export const TILE_GROUND_GAP = DEFAULT_COLLIDER_THRESHOLDS.tileGroundGap;

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
 * The road mask is OSM centrelines on the same grid (see services/osm/roads.ts).
 * A road cell is never a building, and its ground surface is the roadbed itself,
 * not the sagging morphological ground estimate.
 */
function roadExempt(roadMask: RoadGrid | null | undefined, c: number): boolean {
  return roadMask != null && roadMask.mask[c] === 1;
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
  private readonly roadMask?: RoadGrid | null | undefined;

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
    reliefBoost = 1,
    thresholds: ColliderThresholds = DEFAULT_COLLIDER_THRESHOLDS,
    roadMask?: RoadGrid | null
  ) {
    this.n = grid.n;
    this.cell = grid.cell;
    this.terrainTop = terrainTop;
    this.rasters = rasters;
    this.k = thresholds.groundOpeningK;
    this.rise = thresholds.groundBuildingRiseM * WORLD_M_PER_M * reliefBoost;
    this.roadMask = roadMask;

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
              // A road cell is not a building roof: the ground is the road surface itself,
              // not the sagging morphological opening estimate b.
              const tileGround = roadExempt(this.roadMask, c)
                ? Math.min(t, this.low[c]!)
                : ((t - b >= this.rise) ? b : Math.max(b - 0.5, Math.min(t, this.low[c]!)));
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
  reliefBoost = 1,
  thresholds: ColliderThresholds = DEFAULT_COLLIDER_THRESHOLDS,
  roadMask?: RoadGrid | null
): Float32Array {
  const builder = new AmortizedGroundBuilder(rasters, grid, terrainTop, reliefBoost, thresholds, roadMask);
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
  coreHalfUnits = 200,
  thresholds: ColliderThresholds = DEFAULT_COLLIDER_THRESHOLDS
): number | null {
  const { n, cell } = grid;
  const ground = groundEstimate(compositeTops(rasters, n), n, thresholds.groundOpeningK);
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
  return diffs[Math.floor(diffs.length * thresholds.datumPercentile)]!;
}


export function collidersFromRasters(
  rasters: readonly (TileRaster | null)[],
  grid: Grid,
  terrainTop: Float32Array,
  reliefBoost = 1,
  outDeckGrid?: Float32Array,
  thresholds: ColliderThresholds = DEFAULT_COLLIDER_THRESHOLDS,
  /** n*n, receives 1 where the cell is a building, deck or ramp (what a render filter must leave alone). */
  outStructureGrid?: Uint8Array,
  /** OSM road-centreline mask on the same grid; road cells are exempt from building classification. */
  roadMask?: RoadGrid | null,
  /** n*n, receives the photogrammetry top of every building cell (NO_DATA elsewhere): per-cell roof heights for rendering. */
  outTopGrid?: Float32Array
): BuildingCollider[] {
  const { n, cell, half } = grid;
  const top = compositeTops(rasters, n);
  const low = compositeLows(rasters, n);
  const ground = groundEstimate(top, n, thresholds.groundOpeningK);
  const rise = thresholds.buildingRiseM * WORLD_M_PER_M * reliefBoost;
  const BIN_SIZE = thresholds.verticalBinSizeM;

  if (outDeckGrid) {
    outDeckGrid.fill(NO_DATA);
  }

  // Which masked rasters cover each cell. Footprints only overlap at tile
  // edges, so one slot per cell plus a map for the rest; without this every
  // tall cell scanned all ~300 rasters of a city, 45 ms per rebuild.
  const firstRaster = new Int32Array(n * n).fill(-1);
  const moreRasters = new Map<number, number[]>();
  rasters.forEach((r, ri) => {
    if (!r || !r.mask || r.y0 === undefined) return;
    for (let j = 0; j < r.h; j++) {
      for (let i = 0; i < r.w; i++) {
        const c = (r.j0 + j) * n + r.i0 + i;
        if (firstRaster[c]! < 0) firstRaster[c] = ri;
        else {
          const l = moreRasters.get(c);
          if (l) l.push(ri);
          else moreRasters.set(c, [ri]);
        }
      }
    }
  });

  /** True if raster `r` has no geometry in the vertical band [g + 1 bin, y2] at cell c. */
  const rasterClear = (r: TileRaster, c: number, g: number, y2: number): boolean => {
    const j = Math.floor(c / n) - r.j0;
    const i = (c % n) - r.i0;
    const m = r.mask![j * r.w + i]!;
    if (!m) return true;
    // Clearance begins above the ground road surface (at least 1 full height bin above ground)
    const gBin = Math.floor((g - r.y0!) / BIN_SIZE);
    const b1 = Math.max(0, gBin + 1);
    const b2 = Math.min(31, Math.floor((y2 - r.y0!) / BIN_SIZE));
    if (b1 > b2) return true;
    const rangeMask = (0xFFFFFFFF >>> (31 - (b2 - b1))) << b1;
    // Geometry in the driving clearance zone (wall, pier, column)
    return (m & rangeMask) === 0;
  };

  /**
   * Check if the vehicle driving zone above the ground [g + 1.2m, min(g + 4.5m, t - 1.5m)]
   * has no geometry in any tile raster covering cell c. If clear, the space is an open underpass / bridge span.
   */
  const hasGroundClearance = (c: number, g: number, t: number): boolean => {
    const ri = firstRaster[c]!;
    if (ri < 0) return false;
    const y2 = Math.min(g + thresholds.clearanceDriveMaxM, t - thresholds.clearanceTopMarginM);
    if (!rasterClear(rasters[ri]!, c, g, y2)) return false;
    const more = moreRasters.get(c);
    if (more) {
      for (const k of more) if (!rasterClear(rasters[k]!, c, g, y2)) return false;
    }
    return true;
  };

  const getGroundY = (c: number): number => {
    const gMorph = ground[c];
    if (gMorph !== NO_DATA && gMorph !== undefined) {
      if (terrainTop[c] !== NO_DATA && terrainTop[c] !== undefined) {
        return Math.max(gMorph, terrainTop[c]! - thresholds.terrainSmoothingToleranceM);
      }
      return gMorph;
    }
    return terrainTop[c]!;
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
      if (tNb === NO_DATA || tNb <= gNb + thresholds.deckDropThresholdM) break;
      spanWest++;
      if (spanWest > thresholds.multiLaneMaxWidthCells) break;
    }
    let spanEast = 0;
    for (let dx = 1; cx + dx < n; dx++) {
      const nb = cz * n + (cx + dx);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + thresholds.deckDropThresholdM) break;
      spanEast++;
      if (spanEast > thresholds.multiLaneMaxWidthCells) break;
    }
    const widthX = spanWest + 1 + spanEast;

    // Continuous elevated span in Z (drop on South and North)
    let spanSouth = 0;
    for (let dz = -1; cz + dz >= 0; dz--) {
      const nb = (cz + dz) * n + cx;
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + thresholds.deckDropThresholdM) break;
      spanSouth++;
      if (spanSouth > thresholds.multiLaneMaxWidthCells) break;
    }
    let spanNorth = 0;
    for (let dz = 1; cz + dz < n; dz++) {
      const nb = (cz + dz) * n + cx;
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + thresholds.deckDropThresholdM) break;
      spanNorth++;
      if (spanNorth > thresholds.multiLaneMaxWidthCells) break;
    }
    const widthZ = spanSouth + 1 + spanNorth;

    // Narrow span in either axis (1-2 cells wide: <= 20m)
    if (widthX <= thresholds.narrowSpanMaxWidthCells || widthZ <= thresholds.narrowSpanMaxWidthCells) return true;

    // Check diagonal extents for angled bridges
    let diag1 = 0;
    for (let d = 1; cx + d < n && cz + d < n; d++) {
      const nb = (cz + d) * n + (cx + d);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + thresholds.deckDropThresholdM) break;
      diag1++;
      if (diag1 > 10) break;
    }
    for (let d = 1; cx - d >= 0 && cz - d >= 0; d++) {
      const nb = (cz - d) * n + (cx - d);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + thresholds.deckDropThresholdM) break;
      diag1++;
      if (diag1 > 10) break;
    }

    let diag2 = 0;
    for (let d = 1; cx + d < n && cz - d >= 0; d++) {
      const nb = (cz - d) * n + (cx + d);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + thresholds.deckDropThresholdM) break;
      diag2++;
      if (diag2 > 10) break;
    }
    for (let d = 1; cx - d >= 0 && cz + d < n; d++) {
      const nb = (cz + d) * n + (cx - d);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + thresholds.deckDropThresholdM) break;
      diag2++;
      if (diag2 > 10) break;
    }

    const minCross = Math.min(widthX, widthZ);
    const maxLen = Math.max(widthX, widthZ, diag1 + 1, diag2 + 1);

    // Multi-lane bridge ribbon (width <= 6 cells = 60m, length >= 5 cells = 50m, length >= width + 2)
    return minCross <= thresholds.multiLaneMaxWidthCells &&
      maxLen >= thresholds.multiLaneMinLengthCells &&
      maxLen >= minCross + thresholds.multiLaneAspectMarginCells;
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
      if (tNb === NO_DATA || tNb <= gNb + thresholds.rampGroundProximityM) break;
      spanWest++;
      if (spanWest > thresholds.multiLaneMaxWidthCells) break;
    }
    let spanEast = 0;
    for (let dx = 1; cx + dx < n; dx++) {
      const nb = cz * n + (cx + dx);
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + thresholds.rampGroundProximityM) break;
      spanEast++;
      if (spanEast > thresholds.multiLaneMaxWidthCells) break;
    }
    let spanSouth = 0;
    for (let dz = -1; cz + dz >= 0; dz--) {
      const nb = (cz + dz) * n + cx;
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + thresholds.rampGroundProximityM) break;
      spanSouth++;
      if (spanSouth > thresholds.multiLaneMaxWidthCells) break;
    }
    let spanNorth = 0;
    for (let dz = 1; cz + dz < n; dz++) {
      const nb = (cz + dz) * n + cx;
      const tNb = top[nb]!;
      const gNb = getGroundY(nb);
      if (tNb === NO_DATA || tNb <= gNb + thresholds.rampGroundProximityM) break;
      spanNorth++;
      if (spanNorth > thresholds.multiLaneMaxWidthCells) break;
    }
    const widthX = spanWest + 1 + spanEast;
    const widthZ = spanSouth + 1 + spanNorth;
    return widthX <= thresholds.multiLaneMaxWidthCells || widthZ <= thresholds.multiLaneMaxWidthCells;
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
      t - l >= thresholds.deckMinThicknessM &&
      t - l <= thresholds.deckMaxThicknessM &&
      l - g >= thresholds.deckMinClearanceBelowM &&
      clearanceOk &&
      isNarrowSpan(c);
    // High overhead underpass span: at least 13m high, narrow span, with confirmed open driving clearance below from mesh mask
    const isUnderpassDeck =
      hasMask &&
      t - g >= thresholds.underpassMinHeightM &&
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
      if (lNb !== undefined && lNb !== Infinity && tNb - lNb > thresholds.rampMaxThicknessM && !clearanceOk) continue;

      // Ramp MUST descend strictly towards the ground along a narrow roadway span
      const drop = currT - tNb;
      if (drop > thresholds.rampMinDropPerStepM && drop <= thresholds.rampMaxDropPerStepM && tNb >= gNb && (isNarrowSpan(nb) || isRoadwayRibbon(nb))) {
        isRamp[nb] = 1;
        if (outDeckGrid) outDeckGrid[nb] = tNb;
        // Continue downward towards ground; stop once ground level is reached (within 1m of ground)
        if (tNb > gNb + thresholds.rampGroundProximityM) {
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
  const maxDriveStep = thresholds.driveableMaxStepM * WORLD_M_PER_M * reliefBoost;
  const maxCellThick = thresholds.driveableMaxThicknessM * WORLD_M_PER_M * reliefBoost;
  const maxTerrainRise = thresholds.driveableMaxTerrainRiseM * WORLD_M_PER_M * reliefBoost;
  const groundBaseTolerance = thresholds.driveableBaseToleranceM * WORLD_M_PER_M * reliefBoost;

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
    const terr = terrainTop[c];
    if (terr !== undefined && terr !== NO_DATA && t - terr < rise) return false;
    if (isDeck[c] || isRamp[c]) return false;
    // Exempt gradual driveable terrain (slopes, hillsides, knolls, road embankments)
    if (isDriveableGround[c]) return false;
    // OSM says a road runs through here: the crest error of the opening-based
    // ground estimate is exactly the false wall this corridor was severed by
    if (roadExempt(roadMask, c)) return false;
    return true;
  };

  if (outStructureGrid) {
    for (let c = 0; c < n * n; c++) {
      outStructureGrid[c] = isBuilding(c) || isDeck[c] || isRamp[c] ? 1 : 0;
    }
  }
  if (outTopGrid) {
    for (let c = 0; c < n * n; c++) {
      outTopGrid[c] = isBuilding(c) ? top[c]! : NO_DATA;
    }
  }

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
        const gC = getGroundY(c);
        // When an overhead structure has confirmed open driving clearance below (e.g. elevated canopy,
        // skybridge, or viaduct), elevate its floor so vehicles can drive cleanly underneath
        const cellFloor = hasGroundClearance(c, gC, top[c]!)
          ? gC + thresholds.clearanceDriveMaxM + 1.0
          : gC;
        lo = Math.min(lo, cellFloor);
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
    const insetMax = isIsolatedColumn ? thresholds.insetIsolatedColumnM : thresholds.insetExteriorStreetM;
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
export function buildingCollidersFrom(
  tiles: Object3D,
  ground: Heightfield,
  reliefBoost = 1,
  thresholds: ColliderThresholds = DEFAULT_COLLIDER_THRESHOLDS,
  roadMask?: RoadGrid | null
): BuildingCollider[] {
  const grid = gridFor(ground);
  tiles.updateMatrixWorld(true);
  return collidersFromRasters(
    tiles.children.map(c => rasterizeTile(c, grid)),
    grid,
    sampleTerrain(grid, ground),
    reliefBoost,
    undefined,
    thresholds,
    undefined,
    roadMask
  );
}
