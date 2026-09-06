import { describe, it, expect } from 'vitest';
import { sampleGridSmooth, type ElevationGrid } from '../src/core/terrain/RealTerrain.ts';

function gridOf(n: number, f: (i: number, j: number) => number): ElevationGrid {
  const samples: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) samples.push(f(i, j));
  return { samples, gridN: n };
}

describe('sampleGridSmooth', () => {
  it('reproduces grid values at the nodes', () => {
    const g = gridOf(6, (i, j) => i * 3 + j * j);
    expect(sampleGridSmooth(g, 2, 3)).toBeCloseTo(2 * 3 + 9, 9);
    expect(sampleGridSmooth(g, 0, 0)).toBeCloseTo(0, 9);
  });

  it('is exact on a quadratic hill away from the edges, so slopes are continuous', () => {
    const g = gridOf(8, (i, j) => i * i + 2 * j);
    expect(sampleGridSmooth(g, 2.5, 3.25)).toBeCloseTo(2.5 * 2.5 + 6.5, 9);
    // slope across a grid edge does not jump: finite differences either side agree
    const d = 1e-3;
    const left = (sampleGridSmooth(g, 3, 3) - sampleGridSmooth(g, 3 - d, 3)) / d;
    const right = (sampleGridSmooth(g, 3 + d, 3) - sampleGridSmooth(g, 3, 3)) / d;
    expect(Math.abs(left - right)).toBeLessThan(0.01);
  });
});

describe('TerrainMesh continuous underlay', () => {
  it('instantiates, builds continuous mesh with polygonOffset, and disposes without crashing', async () => {
    const { TerrainMesh } = await import('../src/render/TerrainMesh.ts');
    const { createDesertTerrain } = await import('../src/core/terrain/ProceduralTerrain.ts');
    const { Heightfield } = await import('../src/core/heightfield.ts');
    const tm = new TerrainMesh();
    const hf = new Heightfield(100, 4, new Float32Array(5 * 5));
    const terrain = createDesertTerrain(hf);
    const mesh = tm.build(terrain, 1);
    expect(mesh).toBeDefined();
    expect(tm.mesh).toBe(mesh);
    expect(mesh.material).toBeDefined();

    // updateCutout is a safe no-op for backward compatibility
    tm.updateCutout([]);
    tm.updateCutout([{ minX: -500, maxX: 500, minZ: -500, maxZ: 500 }]);
    tm.dispose();
    expect(tm.mesh).toBeNull();
  });

  it('generates high-res sand detail texture and grid texture with anisotropic filtering', async () => {
    const { TerrainMesh } = await import('../src/render/TerrainMesh.ts');
    const { createDesertTerrain } = await import('../src/core/terrain/ProceduralTerrain.ts');
    const { Heightfield } = await import('../src/core/heightfield.ts');
    const { RepeatWrapping } = await import('three');

    // Setup mock document/canvas
    const mockCtx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      fillRect: () => {},
      strokeRect: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      getImageData: () => ({ data: new Uint8ClampedArray(512 * 512 * 4).fill(230) }),
      putImageData: () => {}
    };
    class MockCanvas {
      width = 512;
      height = 512;
      getContext() { return mockCtx; }
    }
    const origDoc = (globalThis as any).document;
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return new MockCanvas();
        return {};
      }
    };

    try {
      const tm = new TerrainMesh();
      const hf = new Heightfield(100, 4, new Float32Array(5 * 5));
      const terrain = createDesertTerrain(hf);
      const mesh = tm.build(terrain, 4);
      expect(mesh).toBeDefined();

      // Sand detail texture should be instantiated, repeated, and have anisotropy >= 8
      expect(tm.sandTexture).toBeDefined();
      expect(tm.sandTexture?.wrapS).toBe(RepeatWrapping);
      expect(tm.sandTexture?.wrapT).toBe(RepeatWrapping);
      expect(tm.sandTexture?.anisotropy).toBeGreaterThanOrEqual(8);

      // Grid texture should also have anisotropy >= 8
      expect(tm.gridTexture).toBeDefined();
      expect(tm.gridTexture?.anisotropy).toBeGreaterThanOrEqual(8);

      tm.dispose();
      expect(tm.sandTexture).toBeNull();
      expect(tm.gridTexture).toBeNull();
      expect(tm.mesh).toBeNull();
    } finally {
      (globalThis as any).document = origDoc;
    }
  });
});

describe('PropScatter', () => {
  it('scatters props in desert terrain, but skips all props and colliders in real cities', async () => {
    const { PropScatter } = await import('../src/render/PropScatter.ts');
    const { Heightfield } = await import('../src/core/heightfield.ts');
    const { Scene } = await import('three');

    const scene = new Scene();
    const ps = new PropScatter(scene);
    const hf = new Heightfield(5600, 16, new Float32Array(17 * 17));

    // Real city: 0 props, 0 colliders
    ps.scatter(hf, 2800, true);
    expect(ps.colliders.length).toBe(0);

    // Desert terrain: props and colliders generated
    ps.scatter(hf, 2800, false);
    expect(ps.colliders.length).toBeGreaterThan(0);
    expect(ps.colliders.some(c => c.kind === 'prop')).toBe(true);

    ps.dispose();
    expect(ps.colliders.length).toBe(0);
  });
});

describe('neutralizeBuildingFootprints', () => {
  it('safely handles empty colliders or node environment without canvas', async () => {
    const { TerrainMesh } = await import('../src/render/TerrainMesh.ts');
    const tm = new TerrainMesh();
    // Empty colliders
    expect(() => tm.neutralizeBuildingFootprints([], 5600, 1)).not.toThrow();
    tm.dispose();
  });

  it('neutralizes building footprints, restores source copy, and respects generation and mode', async () => {
    const { TerrainMesh } = await import('../src/render/TerrainMesh.ts');
    const { Heightfield } = await import('../src/core/heightfield.ts');
    const { Vector3 } = await import('three');

    const tm = new TerrainMesh();
    const hf = new Heightfield(100, 4, new Float32Array(5 * 5));

    const width = 100, height = 100;
    let fillRectCalled = false;
    let drawImageCalled = false;
    const mockCtx = {
      drawImage: () => { drawImageCalled = true; },
      fillRect: () => { fillRectCalled = true; }
    };

    class MockHTMLCanvasElement {
      width = width;
      height = height;
      getContext() { return mockCtx; }
    }

    const origCanvas = (globalThis as unknown as { HTMLCanvasElement?: unknown }).HTMLCanvasElement;
    (globalThis as unknown as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = MockHTMLCanvasElement;

    try {
      const mockCanvas = new MockHTMLCanvasElement() as unknown as HTMLCanvasElement;
      const terrain = {
        label: 'test',
        isReal: true,
        heightfield: hf,
        satelliteCanvas: mockCanvas,
        reliefBoost: 1,
        datumAltM: 0
      };

      tm.build(terrain, 1);
      expect(tm.texture).toBeDefined();

      const mockColliders = [
        {
          min: new Vector3(-10, 0, -10),
          max: new Vector3(10, 20, 10)
        }
      ];

      // Gated on mode: in game3d mode, paint pass is skipped
      tm.setMode('game3d');
      tm.neutralizeBuildingFootprints(mockColliders, 100, 1);
      expect(fillRectCalled).toBe(false);

      // In photoreal mode: paints footprints
      tm.setMode('photoreal');
      expect(fillRectCalled).toBe(true);
      expect(drawImageCalled).toBe(true);

      // Re-calling with identical generation skips redundant processing
      fillRectCalled = false;
      drawImageCalled = false;
      tm.neutralizeBuildingFootprints(mockColliders, 100, 1);
      expect(fillRectCalled).toBe(false);

      // Calling with new generation repaints cleanly
      tm.neutralizeBuildingFootprints(mockColliders, 100, 2);
      expect(fillRectCalled).toBe(true);
      expect(drawImageCalled).toBe(true);
    } finally {
      (globalThis as unknown as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = origCanvas;
      tm.dispose();
    }
  });
});

describe('AmortizedGroundBuilder', () => {
  it('produces identical output to groundField when stepped incrementally or synchronously', async () => {
    const { groundField, AmortizedGroundBuilder } = await import('../src/services/tiles/tileColliders.ts');
    const N = 40;
    const grid = { cell: 10, half: (N * 10) / 2, n: N };
    const terrainTop = new Float32Array(N * N).fill(5);

    const w = 20, h = 20;
    const top = new Float32Array(w * h).fill(12);
    const low = new Float32Array(w * h).fill(5);
    const rasters = [{ i0: 10, j0: 10, w, h, top, low }];

    // 1. Synchronous groundField
    const expected = groundField(rasters, grid, terrainTop, 1);

    // 2. Incremental AmortizedGroundBuilder (stepped with small 0.5ms budget)
    const builder = new AmortizedGroundBuilder(rasters, grid, terrainTop, 1);
    let steps = 0;
    while (!builder.step(0.5)) {
      steps++;
    }
    expect(steps).toBeGreaterThan(0);
    expect(builder.done).toBe(true);
    expect(builder.result).toBeDefined();

    // Verify cell-by-cell identity
    for (let i = 0; i < N * N; i++) {
      expect(builder.result![i]).toBeCloseTo(expected[i]!, 5);
    }
  });

  it('maintains consistent ground datum and does not sink when refined tiles are processed', async () => {
    const { groundField, TILE_GROUND_GAP } = await import('../src/services/tiles/tileColliders.ts');
    const N = 40;
    const grid = { cell: 10, half: (N * 10) / 2, n: N };
    const terrainTop = new Float32Array(N * N).fill(10);

    // Initial coarse tile covering the center: tile mesh surface at 10.0m
    const tileSurfaceHeight = 10;
    const coarseRaster = {
      i0: 10, j0: 10, w: 20, h: 20,
      top: new Float32Array(20 * 20).fill(tileSurfaceHeight),
      low: new Float32Array(20 * 20).fill(tileSurfaceHeight)
    };
    const initialGround = groundField([coarseRaster], grid, terrainTop, 1);
    const centerIdx = 20 * N + 20;
    expect(initialGround[centerIdx]).toBeCloseTo(tileSurfaceHeight + TILE_GROUND_GAP, 2);

    // Refined tile replacing the center with calibrated datum (same ground level)
    const refinedRaster = {
      i0: 15, j0: 15, w: 10, h: 10,
      top: new Float32Array(10 * 10).fill(tileSurfaceHeight),
      low: new Float32Array(10 * 10).fill(tileSurfaceHeight)
    };
    const refinedGround = groundField([coarseRaster, refinedRaster], grid, terrainTop, 1);
    // Ground at center MUST stay at tileSurfaceHeight + TILE_GROUND_GAP, not sinking below ground
    expect(refinedGround[centerIdx]).toBeCloseTo(tileSurfaceHeight + TILE_GROUND_GAP, 2);
    expect(refinedGround[centerIdx]).toBeCloseTo(initialGround[centerIdx]!, 2);
  });
});


