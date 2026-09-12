import { rasterizeRoads, isDrivableWay } from '../src/services/osm/roads.ts';
import {
  collidersFromRasters, groundField, type TileRaster
} from '../src/services/tiles/tileColliders.ts';

const N = 60;
const CELL = 10;
const HALF = (N * CELL) / 2;
const grid = { cell: CELL, half: HALF, n: N };

/** Straight polyline in local metres: [east, north] pairs. */
function line(pts: [number, number][], widthM: number): { east: number; north: number; widthM: number }[] {
  return pts.map(([east, north]) => ({ east, north, widthM }));
}

/** A road running due east at world z = zRoad (north = -z). */
function eastRoad(zRoad: number, widthM: number): { east: number; north: number; widthM: number }[] {
  return line([[-HALF, -zRoad], [HALF, -zRoad]], widthM);
}

describe('rasterizeRoads', () => {
  it('covers the cells a straight road passes through and no others', () => {
    // road along z = 0 → north = 0, spanning the whole grid
    const roads = rasterizeRoads([line([[-300, 0], [300, 0]], 12)], grid);
    const mid = Math.floor(N / 2);
    expect(roads.mask[29 * N + mid]).toBe(1);
    expect(roads.mask[30 * N + mid]).toBe(1);
    // well clear of the road
    expect(roads.mask[25 * N + mid]).toBe(0);
    expect(roads.mask[34 * N + mid]).toBe(0);
    // spans the width
    expect(roads.mask[29 * N + 2]).toBe(1);
    expect(roads.mask[29 * N + (N - 3)]).toBe(1);
  });

  it('marks diagonal roads cell-by-cell without gaps', () => {
    // 45° street along east = -north (world z = east), spanning the whole grid
    const roads = rasterizeRoads([line([[-300, 300], [300, -300]], 14)], grid);
    for (let k = 0; k < N - 8; k++) {
      const i = 4 + k, j = 4 + k;
      expect(roads.mask[j * N + i]).toBe(1);
    }
  });

  it('clamps to the grid bounds without throwing', () => {
    // a road along east = -north (world z = x, the main diagonal) spans corner cells
    const roads = rasterizeRoads([line([[-99999, 99999], [99999, -99999]], 20)], grid);
    expect(roads.mask.length).toBe(N * N);
    expect(roads.mask[0 * N + 0]).toBe(1);
  });
});

describe('collidersFromRasters with road mask', () => {
  const makeRaster = (top: Float32Array, low: Float32Array): TileRaster =>
    ({ i0: 0, j0: 0, w: N, h: N, top, low });

  /**
   * The brief's failure shape, honestly modelled: a street climbing over a
   * crest. Morphological opening is exact on constant grades but sags at the
   * crest by ~half the window's sagitta, so the surface stands far above the
   * estimate there and the classifier walls the street. Buildings flank the
   * street on both sides, standing 8 m above the local road surface.
   */
  function crestScenario(): { top: Float32Array; low: Float32Array; terrain: Float32Array } {
    const top = new Float32Array(N * N);
    const low = new Float32Array(N * N);
    const terrain = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = j * N + i;
        const x = (i - 30) * CELL;
        const surface = 24 - (x * x) / 300; // sharp crest at i = 30
        const street = j >= 20 && j <= 24; // 5-cell (50 m) street corridor
        top[c] = street ? surface : surface + 8;
        low[c] = top[c];
        terrain[c] = surface - 4; // DEM within smoothing tolerance of the street
      }
    }
    return { top, low, terrain };
  }

  it('without roads: the crest street is walled (the baseline failure)', () => {
    const { top, low, terrain } = crestScenario();
    const boxes = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);
    // the classifier puts at least one box across the street corridor
    const streetZ = -HALF + 22.5 * CELL; // centre of row 22
    const wallsStreet = boxes.some(b => b.min.z - 1 <= streetZ && b.max.z + 1 >= streetZ);
    expect(wallsStreet).toBe(true);
    expect(boxes.length).toBeGreaterThan(0);
  });

  it('with an OSM road down the street: the corridor is clear, flanks stay solid', () => {
    const { top, low, terrain } = crestScenario();
    // street corridor centre row 22 → world z = -HALF + 22.5 * CELL
    const streetZ = -HALF + 22.5 * CELL;
    const roads = rasterizeRoads([eastRoad(streetZ, 12)], grid);
    // sanity: the street corridor row is road
    expect(roads.mask[22 * N + 30]).toBe(1);
    const boxes = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1, undefined, undefined, undefined, roads);
    const wallsStreet = boxes.some(b => b.min.z - 1 <= streetZ && b.max.z + 1 >= streetZ);
    expect(wallsStreet).toBe(false);
    // the flanking building rows are still solid
    expect(boxes.length).toBeGreaterThan(0);
    const flankZ = -HALF + 15.5 * CELL; // row 15, building side
    const solidFlank = boxes.some(b => b.min.z - 1 <= flankZ && b.max.z + 1 >= flankZ);
    expect(solidFlank).toBe(true);
  });

  it('a null road mask (fetch failed) changes nothing', () => {
    const { top, low, terrain } = crestScenario();
    const a = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1, undefined, undefined, undefined, null);
    const b = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);
    expect(a.length).toBe(b.length);
  });

  it('preserves surface driving heightfield on crest roads instead of sinking into earth', () => {
    const { top, low, terrain } = crestScenario();
    const streetZ = -HALF + 22.5 * CELL;
    const roads = rasterizeRoads([eastRoad(streetZ, 12)], grid);
    const gfWithRoads = groundField([makeRaster(top, low)], grid, terrain, 1, undefined, roads);
    const gfWithoutRoads = groundField([makeRaster(top, low)], grid, terrain, 1);

    const crestRoadCell = 22 * N + 30;
    // Without road mask, opening sag drops the driving heightfield ~12 m below the surface (to ~12 m)
    expect(gfWithoutRoads[crestRoadCell]).toBeLessThan(15);
    // With road mask, the driving heightfield stays on the road surface (24 m - 3x3 smoothing)
    expect(gfWithRoads[crestRoadCell]).toBeGreaterThan(23);
  });
});

describe('isDrivableWay', () => {
  it('accepts standard vehicular highway classes', () => {
    expect(isDrivableWay({ highway: 'primary' })).toBe(true);
    expect(isDrivableWay({ highway: 'residential' })).toBe(true);
    expect(isDrivableWay({ highway: 'service' })).toBe(true);
    expect(isDrivableWay({ highway: 'unclassified' })).toBe(true);
  });

  it('accepts cycleways and multi-use paved greenways (like Willamette Greenway)', () => {
    expect(isDrivableWay({ highway: 'cycleway' })).toBe(true);
    expect(isDrivableWay({
      highway: 'path',
      bicycle: 'designated',
      name: 'Willamette Greenway'
    })).toBe(true);
    expect(isDrivableWay({
      highway: 'path',
      surface: 'asphalt'
    })).toBe(true);
    expect(isDrivableWay({
      highway: 'path',
      bicycle: 'yes'
    })).toBe(true);
    expect(isDrivableWay({
      highway: 'pedestrian'
    })).toBe(true);
  });

  it('rejects pedestrian sidewalks, steps, and indoor passages', () => {
    expect(isDrivableWay({ highway: 'footway' })).toBe(false);
    expect(isDrivableWay({ highway: 'steps' })).toBe(false);
    expect(isDrivableWay({ highway: 'path', informal: 'yes', surface: 'unpaved' })).toBe(false);
    expect(isDrivableWay({ highway: 'primary', indoor: 'yes' })).toBe(false);
    expect(isDrivableWay({ highway: 'service', tunnel: 'building_passage' })).toBe(false);
    expect(isDrivableWay({ highway: 'pedestrian', area: 'yes' })).toBe(false);
    expect(isDrivableWay(undefined)).toBe(false);
    expect(isDrivableWay({})).toBe(false);
  });
});
