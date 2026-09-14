import { describe, it, expect } from 'vitest';
import { footprintsFromOutlines, OUTLINE_GROUND, OUTLINE_WALL, OUTLINE_ROAD } from '../src/services/maps/MapsApi.ts';
import { rasterizeRoads, rasterizeCoverage } from '../src/services/osm/roads.ts';
import { collidersFromRasters, type TileRaster } from '../src/services/tiles/tileColliders.ts';
import { latLonToWorldPixel } from '../src/services/maps/MapsApi.ts';
import { worldToLl } from '../src/core/geo/projection.ts';

describe('rasterizeCoverage', () => {
  it('sets a cell only when most of it lies on set pixels', () => {
    // a 3x3 grid of zoom-17 tiles centred on the origin; a building filling world x >= 12 m, all z
    const origin = { lat: 37.7929, lon: -122.403 };
    const zoom = 17, w = 1920, h = 1920;
    const c = latLonToWorldPixel(origin.lat, origin.lon, zoom);
    const left = c.x - 960, top = c.y - 960;
    const edge = worldToLl(12, 0, origin as never);
    const ex = Math.round(latLonToWorldPixel(edge.lat, edge.lon, zoom).x - left);
    const pixels = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) pixels.fill(1, y * w + ex, y * w + w);
    const N = 20, CELL = 10, grid = { cell: CELL, half: 100, n: N };
    const g = rasterizeCoverage({ pixels, w, h, zoom, scale: 1, left, top }, grid, origin, 0.7);
    // cell 11 spans x 10..20: 80 % building; cell 10 spans 0..10: none; cell 12 fully inside
    expect(g.mask[10 * N + 11]).toBe(1);
    expect(g.mask[10 * N + 12]).toBe(1);
    expect(g.mask[10 * N + 10]).toBe(0);
    expect(g.mask[10 * N + 9]).toBe(0);
    const g2 = rasterizeCoverage({ pixels, w, h, zoom, scale: 1, left, top }, grid, origin, 0.9);
    expect(g2.mask[10 * N + 11]).toBe(0);
  });
});

describe('footprintsFromOutlines', () => {
  it('fills closed outlines, leaves open ones and the ground alone, and does not leak through a corner', () => {
    const w = 20, h = 12;
    const c = new Uint8Array(w * h).fill(OUTLINE_GROUND);
    for (let x = 0; x < w; x++) c[x] = OUTLINE_ROAD; // a road along the top edge
    const rect = (x0: number, y0: number, x1: number, y1: number): void => {
      for (let x = x0; x <= x1; x++) { c[y0 * w + x] = OUTLINE_WALL; c[y1 * w + x] = OUTLINE_WALL; }
      for (let y = y0; y <= y1; y++) { c[y * w + x0] = OUTLINE_WALL; c[y * w + x1] = OUTLINE_WALL; }
    };
    rect(2, 3, 7, 9);   // closed building
    rect(11, 3, 17, 9); // building with a gap in its wall
    c[3 * w + 14] = OUTLINE_GROUND;
    const f = footprintsFromOutlines(c, w, h);
    expect(f[6 * w + 4]).toBe(1);  // inside the closed one
    expect(f[3 * w + 2]).toBe(1);  // its wall counts too
    expect(f[6 * w + 14]).toBe(0); // the open one floods
    expect(f[1 * w + 9]).toBe(0);  // ground between them
    expect(f[0]).toBe(0);          // road
    expect(f[11 * w + 19]).toBe(0); // bottom corner reached from the edge
  });
});

describe('collidersFromRasters with a building footprint mask', () => {
  const N = 40, CELL = 10, HALF = (N * CELL) / 2;
  const grid = { cell: CELL, half: HALF, n: N };
  const raster = (top: Float32Array, low: Float32Array): TileRaster => ({ i0: 0, j0: 0, w: N, h: N, top, low });
  // flat ground with a squat 2 m block at cells 15..24 x 15..24: under the 3.5 m rise, so invisible to the classifier
  const top = new Float32Array(N * N);
  for (let j = 15; j < 25; j++) for (let i = 15; i < 25; i++) top[j * N + i] = 2;
  const terrain = new Float32Array(N * N);
  const footprint = { ...grid, mask: new Uint8Array(N * N) };
  for (let j = 15; j < 25; j++) for (let i = 15; i < 25; i++) footprint.mask[j * N + i] = 1;

  it('a footprint cell becomes a building however low the ground estimate makes it', () => {
    expect(collidersFromRasters([raster(top, top)], grid, terrain, 1)).toHaveLength(0);
    const boxes = collidersFromRasters([raster(top, top)], grid, terrain, 1, undefined, undefined, undefined, null, undefined, footprint);
    expect(boxes.length).toBeGreaterThan(0);
    const b = boxes[0]!;
    expect(b.min.x).toBeCloseTo(-HALF + 15 * CELL + 1, 0);
    expect(b.max.x).toBeCloseTo(-HALF + 25 * CELL - 1, 0);
  });

  it('the footprint outranks a road corridor lapping over its edge, and the corridor still clears the street beside it', () => {
    // a 12 m street along row 14 whose 5 m slack reaches the centre of row 15, the footprint's first row
    const streetZ = -HALF + 14.5 * CELL;
    const roads = rasterizeRoads([[{ east: -HALF, north: -streetZ, widthM: 12 }, { east: HALF, north: -streetZ, widthM: 12 }]], grid);
    expect(roads.mask[15 * N + 20]).toBe(1);
    const boxes = collidersFromRasters([raster(top, top)], grid, terrain, 1, undefined, undefined, undefined, roads, undefined, footprint);
    expect(boxes.length).toBeGreaterThan(0);
    expect(Math.min(...boxes.map(b => b.min.z))).toBeCloseTo(-HALF + 15 * CELL + 1, 0); // row 15 kept
    expect(boxes.some(b => b.min.z - 1 <= streetZ && b.max.z + 1 >= streetZ)).toBe(false);
  });
});
