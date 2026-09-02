/**
 * Building colliders from streamed photogrammetry tiles.
 *
 * A Google tile is one merged mesh (ground + buildings + trees), so per-mesh
 * bounds say nothing about buildings. Each tile is rasterized once: every
 * triangle's height is stamped into a 10 m height grid over its footprint.
 * Compositing the rasters gives the photogrammetry "roof" surface; a cell is
 * a building when that surface rises well above the elevation-grid terrain
 * (tall buildings, roof interiors included) OR above the lowest neighbouring
 * cell (ramps, low buildings, poles — things the coarse elevation grid can't
 * see). Building cells merge into AABBs: runs along X, then identical runs
 * stack across rows.
 */
import { Vector3, Box3, type Object3D, type Mesh } from 'three';
import { WORLD_M_PER_M } from '../../core/geo/ecef.ts';
import type { BuildingCollider } from '../../core/physics/VehicleBody.ts';
import type { Heightfield } from '../../core/heightfield.ts';

/** 1.5 units = 10 m cells. */
const CELL = 1.5;
/** Real meters above the elevation-grid terrain that make a cell a building. */
const RISE_ABOVE_TERRAIN_M = 18;
/**
 * Real meters above the lowest neighbouring cell that make a cell a building.
 * A 1-cell window keeps hillsides out: over 10 m a 60 % slope is still under 6 m.
 */
const LOCAL_RELIEF_M = 6;
const LOCAL_K = 1;

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
  readonly top: Float32Array;
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
  const stamp = (i: number, j: number, y: number): void => {
    if (i < i0 || i > i1 || j < j0 || j > j1) return;
    const idx = (j - j0) * w + (i - i0);
    if (y > top[idx]!) top[idx] = y;
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
      for (const q of _tri) {
        if (q.x >= -half && q.x < half && q.z >= -half && q.z < half) stamp(cellOf(q.x), cellOf(q.z), q.y);
      }
      const det = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
      if (Math.abs(det) < 1e-9) continue; // vertical: vertices already stamped
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
  return { i0, j0, w, h, top };
}

/** Separable min filter with radius k; empty (-Infinity) cells are ignored. */
function minFilter(src: Float32Array, n: number, k: number): Float32Array {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let d = Math.max(0, i - k); d <= Math.min(n - 1, i + k); d++) {
        const v = src[j * n + d]!;
        if (v !== -Infinity && v < m) m = v;
      }
      tmp[j * n + i] = m;
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let d = Math.max(0, j - k); d <= Math.min(n - 1, j + k); d++) {
        const v = tmp[d * n + i]!;
        if (v < m) m = v;
      }
      out[j * n + i] = m;
    }
  }
  return out;
}

/** Max over all tile rasters on the full grid; -Infinity where no tile has data. */
function compositeTops(rasters: readonly (TileRaster | null)[], n: number): Float32Array {
  const top = new Float32Array(n * n).fill(-Infinity);
  for (const r of rasters) {
    if (!r) continue;
    for (let j = 0; j < r.h; j++) {
      const g = (r.j0 + j) * n + r.i0;
      const l = j * r.w;
      for (let i = 0; i < r.w; i++) {
        const v = r.top[l + i]!;
        if (v > top[g + i]!) top[g + i] = v;
      }
    }
  }
  return top;
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
  const local = minFilter(compositeTops(rasters, n), n, LOCAL_K);
  const c0 = Math.max(0, Math.floor(n / 2 - coreHalfUnits / cell));
  const c1 = Math.min(n - 1, Math.ceil(n / 2 + coreHalfUnits / cell));
  const diffs: number[] = [];
  for (let j = c0; j <= c1; j++) {
    for (let i = c0; i <= c1; i++) {
      const c = j * n + i;
      if (local[c] !== Infinity) diffs.push(local[c]! - terrainTop[c]!);
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
  const local = minFilter(top, n, LOCAL_K);
  const rise = RISE_ABOVE_TERRAIN_M * WORLD_M_PER_M * reliefBoost;
  const relief = LOCAL_RELIEF_M * WORLD_M_PER_M * reliefBoost;
  const isBuilding = (c: number): boolean => {
    const t = top[c]!;
    return t !== -Infinity && (t - terrainTop[c]! >= rise || t - local[c]! >= relief);
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
        lo = Math.min(lo, terrainTop[c]!);
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
