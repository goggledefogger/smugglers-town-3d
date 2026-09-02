import { describe, it, expect, vi, afterEach } from 'vitest';
import { Mesh, BufferGeometry, BufferAttribute, Group, Vector3, Matrix4 } from 'three';
import {
  boxDistanceM, collectTiles, glbPlacement, buildingCollidersFrom, allowedErrorM, DEFAULT_LOD,
  rasterizeTile, tileGroundOffset, type TileNode
} from '../src/services/tiles/Tileset.ts';
import { tileTransformChain } from '../src/core/geo/projection.ts';
import { latLonToEcef } from '../src/core/geo/ecef.ts';
import { Heightfield } from '../src/core/heightfield.ts';

const ORIGIN = { x: 1000, y: 2000, z: 3000 };

/** axis-aligned OBB of half-size h centered at c */
function box(c: { x: number; y: number; z: number }, h: number): number[] {
  return [c.x, c.y, c.z, h, 0, 0, 0, h, 0, 0, 0, h];
}

describe('boxDistanceM', () => {
  it('is 0 inside the box and the axis gap outside', () => {
    expect(boxDistanceM(ORIGIN, box(ORIGIN, 10))).toBe(0);
    expect(boxDistanceM({ x: ORIGIN.x + 25, y: ORIGIN.y, z: ORIGIN.z }, box(ORIGIN, 10))).toBeCloseTo(15, 9);
  });

  it('respects box orientation', () => {
    // half-size 10, rotated 45° about Z
    const s = 10 / Math.SQRT2;
    const rot = [0, 0, 0, s, s, 0, -s, s, 0, 0, 0, 10];
    // 20 along the first axis: 10 past its face
    expect(boxDistanceM({ x: 20 / Math.SQRT2, y: 20 / Math.SQRT2, z: 0 }, rot)).toBeCloseTo(10, 9);
    // a corner of the unrotated box lies outside the rotated one
    expect(boxDistanceM({ x: 10, y: 10, z: 0 }, rot)).toBeGreaterThan(0);
  });
});

describe('allowedErrorM', () => {
  it('grows with distance between the clamps', () => {
    expect(allowedErrorM(0, DEFAULT_LOD)).toBe(20);
    expect(allowedErrorM(1000, DEFAULT_LOD)).toBe(50);
    expect(allowedErrorM(5000, DEFAULT_LOD)).toBe(70);
  });
});

describe('collectTiles', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('takes one GLB per path at the LOD, forwards sessions, skips ancestors and far tiles', async () => {
    const far = { x: ORIGIN.x + 50_000, y: ORIGIN.y, z: ORIGIN.z };
    const subA: TileNode = {
      boundingVolume: { box: box(ORIGIN, 5000) }, geometricError: 100, content: { uri: '/a.glb' },
      children: [
        {
          boundingVolume: { box: box(ORIGIN, 2000) }, geometricError: 10, content: { uri: '/a0.glb' },
          children: [{ boundingVolume: { box: box(ORIGIN, 1000) }, geometricError: 5, content: { uri: '/a00.glb' } }]
        },
        { boundingVolume: { box: box(ORIGIN, 2000) }, geometricError: 50, content: { uri: '/b.json' } },
        { boundingVolume: { box: box(far, 2000) }, geometricError: 10, content: { uri: '/far.glb' } }
      ]
    };
    const subB = { root: { boundingVolume: { box: box(ORIGIN, 1500) }, geometricError: 8, content: { uri: '/b0.glb' } } };
    const root: TileNode = {
      boundingVolume: { box: box(ORIGIN, 1e7) }, geometricError: 1e6,
      children: [{ boundingVolume: { box: box(ORIGIN, 1e6) }, geometricError: 1e5, content: { uri: '/a.json?session=S1' } }]
    };
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetched.push(url);
      return { ok: true, json: async () => (url.includes('/a.json') ? { root: subA } : subB) };
    }));

    const tiles = await collectTiles(root, ORIGIN, 3000, 'key');

    expect(tiles.map(t => t.node.content?.uri).sort()).toEqual(['/a0.glb', '/b0.glb']);
    expect(tiles.every(t => t.session === 'S1')).toBe(true);
    expect(fetched).toEqual([
      'https://tile.googleapis.com/a.json?session=S1',
      'https://tile.googleapis.com/b.json?session=S1'
    ]);
  });
});

describe('glbPlacement', () => {
  it('lands a real Portland tile node near the world origin (glTF Y-up → ECEF)', () => {
    const origin = { lat: 45.5152, lon: -122.6784 };
    const ecef0 = latLonToEcef(origin.lat, origin.lon, 0);
    // node translation read straight out of a depth-20 Portland GLB
    const nodeT = new Vector3(-2415800, 4527445, 3769234);
    const w = nodeT.clone().applyMatrix4(glbPlacement(origin, ecef0, 1));
    expect(Math.hypot(w.x, w.z)).toBeLessThan(5000 * 0.15);
    expect(Math.abs(w.y)).toBeLessThan(1000 * 0.15);
    // without the Y-up fix the same node lands on the far side of the planet
    const raw = nodeT.clone().applyMatrix4(tileTransformChain(new Matrix4(), origin, ecef0, 1));
    expect(raw.length()).toBeGreaterThan(1e6 * 0.15);
  });
});

describe('buildingCollidersFrom', () => {
  // 60-unit field, flat at 0: 10 m cells → 40 cells, cell 20 starts at x = 0
  const flat = new Heightfield(60, 1, new Float32Array([0, 0, 0, 0]));
  function tri(a: number[], b: number[], c: number[]): Mesh {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array([...a, ...b, ...c]), 3));
    return new Mesh(geo);
  }

  /** axis-aligned horizontal quad at height y */
  function quad(x0: number, z0: number, x1: number, z1: number, y: number): Mesh[] {
    return [tri([x0, y, z0], [x1, y, z0], [x1, y, z1]), tri([x0, y, z0], [x1, y, z1], [x0, y, z1])];
  }

  it('turns a wall into an AABB column at its top vertex and ignores ground-level ones', () => {
    const g = new Group();
    g.add(tri([0, 0, 0], [3, 0, 0], [1.5, 50, 0]));
    g.add(tri([-20, 1, -20], [-10, 1, -20], [-15, 1, -10]));
    const boxes = buildingCollidersFrom(g, flat);
    expect(boxes).toHaveLength(1);
    const b = boxes[0]!;
    expect(b.max.y).toBeCloseTo(50, 5);
    expect(b.min.x).toBeCloseTo(1.5, 5);
    expect(b.max.x).toBeCloseTo(3, 5);
    expect(b.min.z).toBeCloseTo(0, 5);
    expect(b.max.z).toBeCloseTo(1.5, 5);
  });

  it('catches a low deck edge by local relief and merges its rows into one box', () => {
    const g = new Group();
    // 2 units up: under the terrain-rise threshold, but 2 above the ground beside it
    for (const m of quad(0, 0, 6, 6, 2)) g.add(m);
    for (const m of quad(-4, 0, 0, 6, 0)) g.add(m);
    const boxes = buildingCollidersFrom(g, flat);
    expect(boxes).toHaveLength(1);
    const b = boxes[0]!;
    expect(b.max.y).toBeCloseTo(2, 5);
    expect(b.min.x).toBeCloseTo(0, 5);
    // only the deck column adjacent to ground sees the relief: the edge, not the interior
    expect(b.max.x).toBeCloseTo(1.5, 5);
    expect(b.min.z).toBeCloseTo(0, 5);
    expect(b.max.z).toBeCloseTo(7.5, 5);
  });

  it('does not flag a steep hillside as a building', () => {
    // 40 % slope rising along +x, terrain and tile agree
    const hill = new Heightfield(60, 1, new Float32Array([0, 24, 0, 24]));
    const g = new Group();
    g.add(tri([-30, 0, -30], [30, 24, -30], [-30, 0, 30]));
    g.add(tri([30, 24, -30], [30, 24, 30], [-30, 0, 30]));
    expect(buildingCollidersFrom(g, hill)).toHaveLength(0);
  });
});

describe('tileGroundOffset', () => {
  it('reports how far the tile ground sits above the terrain', () => {
    const g = new Group();
    const geo = new BufferGeometry();
    // a ground slab 4 units below the terrain, covering the field
    geo.setAttribute('position', new BufferAttribute(new Float32Array([
      -30, -4, -30, 30, -4, -30, -30, -4, 30,
      30, -4, -30, 30, -4, 30, -30, -4, 30
    ]), 3));
    g.add(new Mesh(geo));
    const grid = { cell: 1.5, half: 30, n: 40 };
    const terrain = new Float32Array(40 * 40).fill(0);
    g.updateMatrixWorld(true);
    const offset = tileGroundOffset(g.children.map(c => rasterizeTile(c, grid)), grid, terrain, 30);
    expect(offset).toBeCloseTo(-4, 5);
  });
});
