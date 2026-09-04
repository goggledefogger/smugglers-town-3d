import { describe, it, expect, vi, afterEach } from 'vitest';
import { Mesh, BufferGeometry, BufferAttribute, Group, Vector3, Matrix4, Float32BufferAttribute } from 'three';
import {
  boxDistanceM, collectTiles, glbPlacement, allowedErrorM, DEFAULT_LOD, STREAM_LOD, type TileNode
} from '../src/services/tiles/Tileset.ts';
import {
  buildingCollidersFrom, rasterizeTile, tileGroundOffset, groundEstimate, groundField, TILE_GROUND_GAP
} from '../src/services/tiles/tileColliders.ts';
import { tileTransformChain } from '../src/core/geo/projection.ts';
import { latLonToEcef } from '../src/core/geo/ecef.ts';
import { Heightfield } from '../src/core/heightfield.ts';
import { tileCache, cacheKeyFor } from '../src/services/tiles/TileCache.ts';
import { satelliteUrl } from '../src/services/maps/MapsApi.ts';

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
  it('grows with distance between the clamps for DEFAULT_LOD', () => {
    expect(allowedErrorM(0, DEFAULT_LOD)).toBe(10);
    expect(allowedErrorM(900, DEFAULT_LOD)).toBe(30);
    expect(allowedErrorM(3000, DEFAULT_LOD)).toBe(60);
  });

  it('allows high-resolution ~1.5m error near the vehicle for STREAM_LOD', () => {
    expect(allowedErrorM(0, STREAM_LOD)).toBe(1.5);
    expect(allowedErrorM(60, STREAM_LOD)).toBe(1.5);
    expect(allowedErrorM(180, STREAM_LOD)).toBe(3.0);
    expect(allowedErrorM(480, STREAM_LOD)).toBe(8.0);
    expect(allowedErrorM(3000, STREAM_LOD)).toBe(40);
  });
});

describe('TileCache & cacheKeyFor', () => {
  it('strips ?session= query parameters from 3D tile URLs', () => {
    const url1 = 'https://tile.googleapis.com/v1/3dtiles/tiles/tile123.glb?session=abc123xyz';
    const url2 = 'https://tile.googleapis.com/v1/3dtiles/tiles/tile123.glb?session=differentSession';
    expect(cacheKeyFor(url1)).toBe('https://tile.googleapis.com/v1/3dtiles/tiles/tile123.glb');
    expect(cacheKeyFor(url1)).toBe(cacheKeyFor(url2));
  });

  it('strips API key from satellite maps URL while preserving scale and geometry', () => {
    const url = satelliteUrl(45.5, -122.6, 'SECRET_KEY', 15, 640, 640, 2);
    expect(url).toContain('scale=2');
    const key = cacheKeyFor(url);
    expect(key).not.toContain('SECRET_KEY');
    expect(key).toContain('scale=2');
    expect(key).toContain('center=45.5%2C-122.6');
  });

  it('stores and retrieves binary buffers in memory', async () => {
    const fakeUrl = 'https://tile.googleapis.com/test-tile.glb';
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;
    await tileCache.putBuffer(fakeUrl, data);
    const retrieved = await tileCache.getBuffer(fakeUrl);
    expect(retrieved).not.toBeNull();
    expect(Array.from(new Uint8Array(retrieved!))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('stores and retrieves JSON in memory', async () => {
    const fakeUrl = 'https://tile.googleapis.com/sub.json?session=XYZ';
    const json = { root: { geometricError: 4 } };
    await tileCache.putJson(fakeUrl, json);
    const retrieved = await tileCache.getJson(fakeUrl);
    expect(retrieved).toEqual(json);
  });
});

describe('satelliteUrl', () => {
  it('defaults to scale=2 for high resolution output', () => {
    const url = satelliteUrl(35.68, 139.76, 'KEY', 15, 640, 640);
    expect(url).toContain('scale=2');
    expect(url).toContain('maptype=satellite');
    expect(url).toContain('size=640x640');
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
    expect(Math.hypot(w.x, w.z)).toBeLessThan(5000);
    expect(Math.abs(w.y)).toBeLessThan(1000);
    // without the Y-up fix the same node lands on the far side of the planet
    const raw = nodeT.clone().applyMatrix4(tileTransformChain(new Matrix4(), origin, ecef0, 1));
    expect(raw.length()).toBeGreaterThan(1e6);
  });
});

describe('groundEstimate', () => {
  const n = 40;
  const rampOf = (): Float32Array => {
    const a = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) a[j * n + i] = i * 0.5;
    return a;
  };

  it('leaves a slope untouched, so hillsides are not buildings', () => {
    const ramp = rampOf();
    const ground = groundEstimate(ramp, n, 3);
    for (let j = 5; j < n - 5; j++) {
      for (let i = 5; i < n - 5; i++) {
        expect(ground[j * n + i]).toBeCloseTo(ramp[j * n + i]!, 6);
      }
    }
  });

  it('erases anything narrower than the window, so towers stand above it', () => {
    const top = rampOf();
    for (let j = 18; j <= 20; j++) for (let i = 18; i <= 20; i++) top[j * n + i]! += 20;
    const ground = groundEstimate(top, n, 3);
    expect(top[19 * n + 19]! - ground[19 * n + 19]!).toBeCloseTo(20, 6);
    expect(top[19 * n + 5]! - ground[19 * n + 5]!).toBeCloseTo(0, 6);
  });

  it('reports no ground where no tile covers the window', () => {
    const empty = new Float32Array(n * n).fill(-Infinity);
    expect(groundEstimate(empty, n, 3)[20 * n + 20]).toBe(-Infinity);
  });
});

describe('buildingCollidersFrom', () => {
  // 300-unit field so the 9-unit opening radius is small next to the world,
  // as it is in a real match (840 units)
  const SIZE = 300;
  const flat = new Heightfield(SIZE, 1, new Float32Array([0, 0, 0, 0]));

  /** Two triangles covering the field with a linear surface y = a + b·x. */
  function slab(a: number, b: number): Mesh {
    const h = SIZE / 2;
    const y = (x: number): number => a + b * x;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array([
      -h, y(-h), -h, h, y(h), -h, -h, y(-h), h,
      h, y(h), -h, h, y(h), h, -h, y(-h), h
    ]), 3));
    return new Mesh(geo);
  }

  /** Flat roof patch spanning [x0,x1]×[z0,z1] at height y. */
  function roof(x0: number, z0: number, x1: number, z1: number, y: number): Mesh {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array([
      x0, y, z0, x1, y, z0, x0, y, z1,
      x1, y, z0, x1, y, z1, x0, y, z1
    ]), 3));
    return new Mesh(geo);
  }

  it('boxes a building standing on flat ground', () => {
    const g = new Group();
    g.add(slab(0, 0));
    g.add(roof(-6, -6, 6, 6, 9)); // 9 units up = 60 real m
    const boxes = buildingCollidersFrom(g, flat);
    expect(boxes.length).toBeGreaterThan(0);
    const top = Math.max(...boxes.map(b => b.max.y));
    expect(top).toBeCloseTo(9, 5);
    // and every box sits over the roof's footprint, not out on the open ground
    for (const b of boxes) {
      expect(b.min.x).toBeGreaterThan(-12);
      expect(b.max.x).toBeLessThan(12);
    }
  });

  it('does not flag a steep hillside as a building', () => {
    const g = new Group();
    g.add(slab(0, 0.4)); // 40 % grade across the whole field
    expect(buildingCollidersFrom(g, flat)).toHaveLength(0);
  });

  it('finds a building on a hillside, not the hill itself', () => {
    const g = new Group();
    g.add(slab(0, 0.4));
    g.add(roof(-6, -6, 6, 6, 0.4 * 0 + 9)); // 9 units above the slope at x≈0
    const boxes = buildingCollidersFrom(g, flat);
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.min.x).toBeGreaterThan(-12);
      expect(b.max.x).toBeLessThan(12);
    }
  });

  /** A 4-sided vertical pillar/column spanning [x0,x1]×[z0,z1] from y0 to y1. */
  function pillar(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): Mesh {
    const geo = new BufferGeometry();
    const pos = [
      // South wall (z = z0)
      x0, y0, z0,  x1, y0, z0,  x1, y1, z0,
      x0, y0, z0,  x1, y1, z0,  x0, y1, z0,
      // North wall (z = z1)
      x0, y0, z1,  x1, y1, z1,  x1, y0, z1,
      x0, y0, z1,  x0, y1, z1,  x1, y1, z1,
      // West wall (x = x0)
      x0, y0, z0,  x0, y1, z0,  x0, y1, z1,
      x0, y0, z0,  x0, y1, z1,  x0, y0, z1,
      // East wall (x = x1)
      x1, y0, z0,  x1, y1, z1,  x1, y1, z0,
      x1, y0, z0,  x1, y0, z1,  x1, y1, z1,
    ];
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    return new Mesh(geo);
  }

  it('exempts elevated bridge decks and underpasses with open driving clearance', () => {
    const g = new Group();
    g.add(slab(0, 0)); // ground roadway at Y = 0
    g.add(roof(-6, -6, 6, 6, 20)); // elevated bridge deck at Y = 20m (open air from 0 to 20)
    const boxes = buildingCollidersFrom(g, flat);
    // Because the driving zone [1.2m, 4.5m] is completely clear, it is an underpass roadway, not a building
    expect(boxes).toHaveLength(0);
  });

  it('detects ground-hitting bridge piers as solid colliders while leaving underpasses open', () => {
    const g = new Group();
    g.add(slab(0, 0)); // ground roadway at Y = 0
    g.add(roof(-12, -6, 12, 6, 20)); // elevated bridge deck at Y = 20m from X = -12 to 12
    // Solid bridge pier column on the east side: X in [4.5, 9], Z in [-3, 3], Y from 0 to 20
    g.add(pillar(4.5, -3, 9, 3, 0, 20));

    const boxes = buildingCollidersFrom(g, flat);

    // There should be a solid collider for the pier column, but NOT for the open underpass lane on the west side
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      // The box must sit over the pier (X > 0), not over the open underpass roadway (X < 0)
      expect(b.min.x).toBeGreaterThanOrEqual(0);
      expect(b.max.y).toBeCloseTo(20, 1);
    }
  });

  it('keeps tall bridge towers in the water as solid colliders (not thin elevated decks)', () => {
    const g = new Group();
    g.add(slab(0, 0)); // water surface at Y = 0
    // A massive 50m stone tower standing in the water from Y = 0 to 50
    g.add(pillar(-6, -6, 6, 6, 0, 50));
    g.add(roof(-6, -6, 6, 6, 50));

    const boxes = buildingCollidersFrom(g, flat);
    expect(boxes.length).toBeGreaterThan(0);
    const top = Math.max(...boxes.map(b => b.max.y));
    expect(top).toBeCloseTo(50, 1);
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

describe('one shared ground', () => {
  // groundEstimate masks a 6-cell border, so the interior is cells 6..33
  const N = 40;
  const grid = { cell: 1.5, half: (N * 1.5) / 2, n: N };
  const flat = (v: number): Float32Array => new Float32Array(N * N).fill(v);
  const raster = (top: Float32Array, low: Float32Array) => ({ i0: 0, j0: 0, w: N, h: N, top, low });

  it('rasterizes the lowest surface per cell as well as the highest', () => {
    // a ground quad at y=0 with a canopy quad at y=5 over the same cells
    const g = new Group();
    const quad = (y: number): Mesh => {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute([
        -6, y, -6,  6, y, -6,  6, y, 6,
        -6, y, -6,  6, y, 6,  -6, y, 6
      ], 3));
      return new Mesh(geo);
    };
    g.add(quad(0), quad(5));
    const r = rasterizeTile(g, grid)!;
    const c = Math.floor(r.w / 2) + Math.floor(r.h / 2) * r.w;
    expect(r.top[c]).toBeCloseTo(5, 6);
    expect(r.low[c]).toBeCloseTo(0, 6);
  });

  it('keeps the street under canopy, the base under a building, and the terrain where no tiles are', () => {
    const top = flat(0), low = flat(0);
    // a tree: 0.9 units (6 m) over the street, below the building rise
    top[15 * N + 15] = 0.9;
    // a tower over one cell with its roof well past the building rise
    top[25 * N + 25] = 40;
    low[25 * N + 25] = 40;
    // one interior cell with no tile data at all
    top[20 * N + 20] = -Infinity;
    low[20 * N + 20] = Infinity;
    const terrain = flat(9);
    const ground = groundField([raster(top, low)], grid, terrain);
    const at = (i: number, j: number): number => ground[j * N + i]!;
    // interior street cells sit the gap above the tile surface
    expect(at(10, 10)).toBeCloseTo(TILE_GROUND_GAP, 5);
    // the canopy did not lift the street (lowest surface wins)...
    expect(at(15, 15)).toBeCloseTo(TILE_GROUND_GAP, 5);
    // ...and neither did the tower (its opened base is the street)
    expect(at(25, 25)).toBeCloseTo(TILE_GROUND_GAP, 5);
    // no data: the terrain, feathered into the tile ground by the box filter
    expect(at(20, 20)).toBeGreaterThan(TILE_GROUND_GAP);
    expect(at(20, 20)).toBeLessThan(9);
    // the masked border is terrain outright
    expect(at(2, 2)).toBeCloseTo(9, 5);
  });

  it('builds a heightfield from cells and copies heights into an existing one', () => {
    const cells = new Float32Array([0, 4, 0, 4]); // 2×2 row-major, east column raised
    const hf = Heightfield.fromCells(cells, 2, 10);
    expect(hf.size).toBe(20);
    expect(hf.segs).toBe(2);
    expect(hf.sample(-10, 0)).toBeCloseTo(0, 6);
    expect(hf.sample(10, 0)).toBeCloseTo(4, 6);
    expect(hf.sample(0, 0)).toBeCloseTo(2, 6);
    const other = Heightfield.fromCells(new Float32Array([1, 1, 1, 1]), 2, 10);
    hf.copyFrom(other);
    expect(hf.sample(10, 0)).toBeCloseTo(1, 6);
    expect(() => hf.copyFrom(new Heightfield(20, 1, new Float32Array(4)))).toThrow();
  });
});
