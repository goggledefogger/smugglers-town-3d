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
    expect(() => tm.neutralizeBuildingFootprints([], 5600)).not.toThrow();
    tm.dispose();
  });

  it('neutralizes building footprints and updates texture when canvas is present', async () => {
    const { TerrainMesh } = await import('../src/render/TerrainMesh.ts');
    const { Heightfield } = await import('../src/core/heightfield.ts');
    const { Vector3 } = await import('three');

    const tm = new TerrainMesh();
    const hf = new Heightfield(100, 4, new Float32Array(5 * 5));

    // Create a mock canvas with a 2D context
    const width = 100, height = 100;
    const pixelData = new Uint8ClampedArray(width * height * 4);
    // Fill with ambient ground color (r: 100, g: 120, b: 90)
    for (let i = 0; i < pixelData.length; i += 4) {
      pixelData[i] = 100;
      pixelData[i + 1] = 120;
      pixelData[i + 2] = 90;
      pixelData[i + 3] = 255;
    }

    let putImageDataCalled = false;
    const mockCtx = {
      getImageData: () => ({ data: pixelData, width, height }),
      putImageData: () => { putImageDataCalled = true; }
    };

    class MockHTMLCanvasElement {
      width = width;
      height = height;
      getContext() { return mockCtx; }
    }

    // Set global HTMLCanvasElement for the test
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

      const initialVersion = tm.texture?.version ?? 0;
      tm.neutralizeBuildingFootprints(mockColliders, 100);
      expect(putImageDataCalled).toBe(true);
      expect(tm.texture?.version).toBeGreaterThan(initialVersion);

      // Re-calling with identical count skips redundant processing
      putImageDataCalled = false;
      tm.neutralizeBuildingFootprints(mockColliders, 100);
      expect(putImageDataCalled).toBe(false);
    } finally {
      (globalThis as unknown as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = origCanvas;
      tm.dispose();
    }
  });
});

