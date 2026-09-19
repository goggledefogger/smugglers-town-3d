import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getResolutionProfile, loadResolution3D, saveResolution3D, DEFAULT_RESOLUTION_3D
} from '../src/services/tiles/resolutionProfiles.ts';
import {
  allowedErrorM,
  TileStreamer
} from '../src/services/tiles/Tileset.ts';
import { GameRenderer } from '../src/render/Renderer.ts';
import { Heightfield } from '../src/core/heightfield.ts';
import type { TerrainProvider } from '../src/core/terrain/TerrainProvider.ts';

describe('3D Resolution Profiles', () => {
  it('defines Balanced, High, and Ultra profiles with descending geometric errors', () => {
    const balanced = getResolutionProfile('balanced');
    const high = getResolutionProfile('high');
    const ultra = getResolutionProfile('ultra');

    expect(balanced.lod.minErrorM).toBe(1.5);
    expect(high.lod.minErrorM).toBe(0.8);
    expect(ultra.lod.minErrorM).toBe(0.4);

    expect(high.lod.minErrorM).toBeLessThan(balanced.lod.minErrorM);
    expect(ultra.lod.minErrorM).toBeLessThan(high.lod.minErrorM);
  });

  it('increases tile budgets and refinement frequency for higher tiers', () => {
    const balanced = getResolutionProfile('balanced');
    const high = getResolutionProfile('high');
    const ultra = getResolutionProfile('ultra');

    expect(high.maxTiles).toBeGreaterThan(balanced.maxTiles);
    expect(ultra.maxTiles).toBeGreaterThan(high.maxTiles);

    expect(high.refineIntervalMs).toBeLessThan(balanced.refineIntervalMs);
    expect(ultra.refineIntervalMs).toBeLessThan(high.refineIntervalMs);

    expect(high.refineBatchSize).toBeGreaterThanOrEqual(balanced.refineBatchSize);
    expect(ultra.refineBatchSize).toBeGreaterThanOrEqual(high.refineBatchSize);
  });

  it('computes progressively finer allowedErrorM across distances', () => {
    const balanced = getResolutionProfile('balanced').lod;
    const high = getResolutionProfile('high').lod;
    const ultra = getResolutionProfile('ultra').lod;

    // Near vehicle (0m)
    expect(allowedErrorM(0, balanced)).toBe(1.5);
    expect(allowedErrorM(0, high)).toBe(0.8);
    expect(allowedErrorM(0, ultra)).toBe(0.4);

    // 180m away
    const errBal180 = allowedErrorM(180, balanced);
    const errHigh180 = allowedErrorM(180, high);
    const errUltra180 = allowedErrorM(180, ultra);
    expect(errHigh180).toBeLessThan(errBal180);
    expect(errUltra180).toBeLessThan(errHigh180);

    // 500m away
    const errBal500 = allowedErrorM(500, balanced);
    const errHigh500 = allowedErrorM(500, high);
    const errUltra500 = allowedErrorM(500, ultra);
    expect(errHigh500).toBeLessThan(errBal500);
    expect(errUltra500).toBeLessThan(errHigh500);
  });

  it('provides appropriate DPR caps and anisotropic levels across profiles', () => {
    const balanced = getResolutionProfile('balanced');
    const high = getResolutionProfile('high');
    const ultra = getResolutionProfile('ultra');

    expect(balanced.dprCap).toBe(1.5);
    expect(high.dprCap).toBe(2.0);
    expect(ultra.dprCap).toBe(2.5);

    expect(balanced.anisotropy).toBe(4);
    expect(high.anisotropy).toBe(8);
    expect(ultra.anisotropy).toBe(16);
  });
});

describe('TileStreamer Resolution Switching', () => {
  const mockHeightfield = new Heightfield(1000, 10, new Float32Array(121));
  const mockTerrain: TerrainProvider = {
    heightfield: mockHeightfield,
    reliefBoost: 1.0,
    isReal: true,
    label: 'Test City',
    satelliteCanvas: null,
    datumAltM: 0
  };

  it('initializes in balanced mode by default and allows switching', () => {
    const streamer = new TileStreamer(
      'fake-key',
      mockTerrain,
      { lat: 45, lon: -122 },
      { x: 0, y: 0, z: 0 },
      4,
      'balanced'
    );

    expect(streamer.activeResolutionMode).toBe('balanced');
    expect(streamer.activeLodPolicy.minErrorM).toBe(1.5);
    expect(streamer.activeMaxTiles).toBe(180);

    // Switch to High
    streamer.setResolutionMode('high');
    expect(streamer.activeResolutionMode).toBe('high');
    expect(streamer.activeLodPolicy.minErrorM).toBe(0.8);
    expect(streamer.activeMaxTiles).toBe(550);
    expect(streamer.collidersDirty).toBe(true);

    // Switch to Ultra
    streamer.setResolutionMode('ultra');
    expect(streamer.activeResolutionMode).toBe('ultra');
    expect(streamer.activeLodPolicy.minErrorM).toBe(0.4);
    expect(streamer.activeMaxTiles).toBe(750);

    streamer.dispose();
  });
});

describe('GameRenderer DPR Cap and Anisotropy', () => {
  let mockCanvas: HTMLCanvasElement;
  let origWindow: unknown;

  beforeEach(() => {
    origWindow = (globalThis as any).window;
    (globalThis as any).cancelAnimationFrame = vi.fn();
    (globalThis as any).requestAnimationFrame = vi.fn();
    (globalThis as any).window = {
      devicePixelRatio: 2.0,
      innerWidth: 1000,
      innerHeight: 800,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame: vi.fn(),
      cancelAnimationFrame: vi.fn()
    };
    (globalThis as any).self = (globalThis as any).window;

    const targetProps: Record<string, any> = {
      VERSION: 0x1f02,
      SHADING_LANGUAGE_VERSION: 0x8b8c,
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
      MAX_TEXTURE_SIZE: 0x0d33,
      MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
      MAX_TEXTURE_IMAGE_UNITS: 0x8872,
      MAX_SAMPLES: 0x8d57,
      getExtension: vi.fn((name: string) => {
        if (name === 'EXT_texture_filter_anisotropic' || name === 'WEBKIT_EXT_texture_filter_anisotropic') {
          return { MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff };
        }
        return null;
      }),
      getParameter: vi.fn((param: number) => {
        if (param === 0x84ff) return 16;
        if (param === 0x1f02 || param === undefined) return 'WebGL 1.0';
        if (param === 0x8b8c) return 'WebGL GLSL ES 1.00';
        if (param === 0x1f00) return 'WebKit';
        if (param === 0x1f01) return 'WebKit WebGL';
        return 16;
      }),
      getShaderPrecisionFormat: vi.fn().mockReturnValue({ precision: 1, rangeMin: 1, rangeMax: 1 }),
      getShaderParameter: vi.fn().mockReturnValue(true),
      getProgramParameter: vi.fn().mockReturnValue(true),
      canvas: { width: 1000, height: 800, style: {} }
    };

    const mockGl = new Proxy(targetProps, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        target[prop] = vi.fn();
        return target[prop];
      }
    });

    mockCanvas = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getContext: vi.fn().mockReturnValue(mockGl),
      style: {},
      width: 1000,
      height: 800
    } as unknown as HTMLCanvasElement;
  });

  afterEach(() => {
    (globalThis as any).window = origWindow;
    vi.restoreAllMocks();
  });

  it('allows dynamic DPR cap adjustment on high-DPI displays', () => {
    const renderer = new GameRenderer({ canvas: mockCanvas });

    // Initial DPR on 2.0x display with 1.5 default cap should be 1.5
    expect(renderer.pixelRatio).toBe(1.5);
    expect(renderer.maxAnisotropy).toBe(16);

    // Unlocking cap to 2.0 expands pixel ratio to native 2.0
    renderer.setDprCap(2.0);
    expect(renderer.pixelRatio).toBe(2.0);

    renderer.dispose();
  });
});



describe('resolution persistence', () => {
  let origStorage: unknown;
  let saved: Record<string, string>;

  beforeEach(() => {
    origStorage = (globalThis as any).localStorage;
    saved = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => saved[k] ?? null,
      setItem: (k: string, v: string) => { saved[k] = v; },
      removeItem: (k: string) => { delete saved[k]; },
      clear: () => { saved = {}; }
    };
  });

  afterEach(() => {
    (globalThis as any).localStorage = origStorage;
  });

  it('defaults to high when nothing is saved, the mode Best 3D needs', () => {
    expect(loadResolution3D(null)).toBe(DEFAULT_RESOLUTION_3D);
    expect(DEFAULT_RESOLUTION_3D).toBe('high');
  });

  it('lets an explicit url param beat the saved choice', () => {
    saved['stt.res3d'] = 'ultra';
    expect(loadResolution3D('balanced')).toBe('balanced');
    expect(loadResolution3D('ultra')).toBe('ultra');
  });

  it('falls back to the default for a saved value that is not a mode', () => {
    saved['stt.res3d'] = 'nonsense';
    expect(loadResolution3D(null)).toBe(DEFAULT_RESOLUTION_3D);
    expect(loadResolution3D('also-nonsense')).toBe(DEFAULT_RESOLUTION_3D);
  });

  it('round trips a saved mode, so the app and the settings screen agree', () => {
    saveResolution3D('ultra');
    expect(loadResolution3D(null)).toBe('ultra');
    expect(saved['stt.res3d']).toBe('ultra');
  });

  it('returns the default when there is no localStorage at all', () => {
    delete (globalThis as any).localStorage;
    expect(loadResolution3D(null)).toBe(DEFAULT_RESOLUTION_3D);
    expect(() => saveResolution3D('high')).not.toThrow();
  });
});
