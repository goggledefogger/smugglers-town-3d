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
/** Real meters above the estimated ground that make a cell a building. */
const BUILDING_RISE_M = 8;
/**
 * The shared ground sits this far (world units) above the tile surface, so
 * the vehicle smoothly rides over street-level photogrammetry noise, kerbs,
 * parked cars and bushes without snagging.
 */
export const TILE_GROUND_GAP = 0.6;

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
  const top = new Float32Array(w * h).fill(-Infinity);
  const low = new Float32Array(w * h).fill(Infinity);
  const stamp = (i: number, j: number, y: number): void => {
    if (i < i0 || i > i1 || j < j0 || j > j1) return;
    const idx = (j - j0) * w + (i - i0);
    if (y > top[idx]!) top[idx] = y;
    if (y < low[idx]!) low[idx] = y;
  };
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
      const det = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
      if (Math.abs(det) < 1e-9) {
        // vertical wall: stamp vertices
        for (const q of _tri) {
          if (q.x >= -half && q.x < half && q.z >= -half && q.z < half) stamp(cellOf(q.x), cellOf(q.z), q.y);
        }
        continue;
      }
      // non-vertical: stamp the centroid so small triangles register without bleeding into neighbor cells
      const midX = (a.x + b.x + c.x) / 3, midZ = (a.z + b.z + c.z) / 3, midY = (a.y + b.y + c.y) / 3;
      if (midX >= -half && midX < half && midZ >= -half && midZ < half) {
        stamp(cellOf(midX), cellOf(midZ), midY);
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
  return { i0, j0, w, h, top, low };
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

const NO_DATA = -Infinity;

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
 * The one ground the whole game plays on, per cell. Where tiles cover a cell
 * it is the tile surface: the lowest one, so streets survive tree canopy and
 * bridge decks, and the opened base under anything tall enough to be a
 * building. Cells without coverage fall back to the elevation-grid terrain,
 * which the tiles were calibrated against, so the seam is small. A 3×3 box
 * takes the 10 m quantisation off the result before it becomes a heightfield.
 *
 * Physics, spawning, props, shadows, the camera and the satellite drape all
 * sample the heightfield built from this; the building colliders' floors are
 * cut from the same base. Before this the elevation grid (87 m samples) was
 * the ground for physics while the tiles were the ground for collision, and
 * in San Francisco the two disagreed by whole storeys: cars sat inside the
 * tile mesh and slid under building boxes.
 */
export function groundField(
  rasters: readonly (TileRaster | null)[],
  grid: Grid,
  terrainTop: Float32Array,
  reliefBoost = 1
): Float32Array {
  const { n } = grid;
  const top = compositeTops(rasters, n);
  const low = compositeLows(rasters, n);
  const base = groundEstimate(top, n);
  const rise = BUILDING_RISE_M * WORLD_M_PER_M * reliefBoost;
  const raw = new Float32Array(n * n);
  for (let c = 0; c < n * n; c++) {
    const t = top[c]!, b = base[c]!;
    if (t === NO_DATA || b === NO_DATA) raw[c] = terrainTop[c]!;
    else raw[c] = (t - b >= rise ? b : low[c]!) + TILE_GROUND_GAP;
  }
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let sum = 0, count = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= n) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= n) continue;
          sum += raw[jj * n + ii]!;
          count++;
        }
      }
      out[j * n + i] = sum / count;
    }
  }
  return out;
}

/**
 * How far the tile ground sits above the terrain over the field core, or
 * null without enough data. Tiles are placed by height above the WGS84
 * ellipsoid while the elevation grid is above mean sea level; the geoid runs
 * ~20 m below the ellipsoid around Portland, which buried bridge decks and
 * ground floors. Measuring beats shipping a geoid model: the 30th percentile
 * of (local ground − terrain) lands inside the cluster of true ground cells,
 * below roofs and canopy, above valleys the coarse grid interpolates over.
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
  return diffs[Math.floor(diffs.length * 0.3)]!;
}

export function collidersFromRasters(
  rasters: readonly (TileRaster | null)[],
  grid: Grid,
  terrainTop: Float32Array,
  reliefBoost = 1
): BuildingCollider[] {
  const { n, cell, half } = grid;
  const top = compositeTops(rasters, n);
  const ground = groundEstimate(top, n);
  const rise = BUILDING_RISE_M * WORLD_M_PER_M * reliefBoost;
  const isBuilding = (c: number): boolean => {
    const t = top[c]!;
    const g = ground[c]!;
    return t !== NO_DATA && g !== NO_DATA && t - g >= rise;
  };

  const out: BuildingCollider[] = [];
  let above = new Map<number, BuildingCollider>();
  for (let j = 0; j < n; j++) {
    const z0 = -half + j * cell;
    const row = new Map<number, BuildingCollider>();
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
        // the box floor follows the estimated ground, which tracks a hill far
        // better than the smoothed elevation grid; fall back to it when a
        // cell has no tile coverage nearby
        lo = Math.min(lo, ground[c] !== NO_DATA ? ground[c]! : terrainTop[c]!);
        continue;
      }
      if (start < 0) continue;
      const key = start * (n + 1) + i;
      const prev = above.get(key);
      if (prev) {
        prev.max.z = z0 + cell;
        prev.max.y = Math.max(prev.max.y, hi);
        prev.min.y = Math.min(prev.min.y, lo - 1);
        row.set(key, prev);
      } else {
        const b: BuildingCollider = {
          min: new Vector3(-half + start * cell, lo - 1, z0),
          max: new Vector3(-half + i * cell, hi, z0 + cell)
        };
        out.push(b);
        row.set(key, b);
      }
      start = -1;
    }
    above = row;
  }
  // Inset building colliders horizontally by 1.2m so 10m quantization steps and
  // facade overshoots do not protrude into roadway lanes and sidewalks.
  const INSET_M = 1.2;
  for (const b of out) {
    const width = b.max.x - b.min.x;
    const depth = b.max.z - b.min.z;
    const insetX = Math.min(INSET_M, Math.max(0, (width - 2) / 2));
    const insetZ = Math.min(INSET_M, Math.max(0, (depth - 2) / 2));
    b.min.x += insetX;
    b.max.x -= insetX;
    b.min.z += insetZ;
    b.max.z -= insetZ;
  }
  return out;
}

/** Colliders straight from a group of meshes (tests and one-shot use). */
export function buildingCollidersFrom(tiles: Object3D, ground: Heightfield, reliefBoost = 1): BuildingCollider[] {
  const grid = gridFor(ground);
  tiles.updateMatrixWorld(true);
  return collidersFromRasters(
    tiles.children.map(c => rasterizeTile(c, grid)), grid, sampleTerrain(grid, ground), reliefBoost
  );
}
