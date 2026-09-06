import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameRenderer } from '../src/render/Renderer.ts';

describe('GameRenderer adaptive resolution', () => {
  let mockCanvas: HTMLCanvasElement;
  let origWindow: unknown;

  beforeEach(() => {
    origWindow = (globalThis as any).window;
    (globalThis as any).cancelAnimationFrame = vi.fn();
    (globalThis as any).requestAnimationFrame = vi.fn();
    (globalThis as any).window = {
      devicePixelRatio: 1.0,
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
      getExtension: vi.fn().mockReturnValue(null),
      getParameter: vi.fn((param: number) => {
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

  it('locks native 1.0 pixel mapping on standard 1x displays', () => {
    (globalThis as any).window.devicePixelRatio = 1.0;
    const gr = new GameRenderer({ canvas: mockCanvas });
    expect(gr.pixelRatio).toBeCloseTo(1.0, 2);
    gr.dispose();
  });

  it('caps at 1.5 on high-DPI Retina screens: sharp, and measured to hold 60 Hz on an M1 Pro', () => {
    (globalThis as any).window.devicePixelRatio = 2.0;
    const gr = new GameRenderer({ canvas: mockCanvas });
    expect(gr.pixelRatio).toBeCloseTo(1.5, 2);
    gr.dispose();
  });

  it('ignores spike frame deltas from background tabs or pauses', () => {
    const gr = new GameRenderer({ canvas: mockCanvas });
    const initialRatio = gr.pixelRatio;

    // A large 1-second delta from a tab switch or pause
    gr.adapt(1.0, 5000);
    // Pixel ratio should NOT drop
    expect(gr.pixelRatio).toBe(initialRatio);

    // Negative / zero delta
    gr.adapt(0, 5016);
    expect(gr.pixelRatio).toBe(initialRatio);

    gr.dispose();
  });

  it('preserves initial resolution during the startup settling period', () => {
    const gr = new GameRenderer({ canvas: mockCanvas });
    const initialRatio = gr.pixelRatio;

    // First frame initializes startup timestamp
    gr.adapt(0.016, 100);

    // Simulate slow frames during the 2.5s settling buffer
    for (let i = 1; i <= 20; i++) {
      gr.adapt(0.045, 100 + i * 50); // ~22 FPS
    }
    // Startup grace period prevents premature resolution drop
    expect(gr.pixelRatio).toBe(initialRatio);
    gr.dispose();
  });

  it('ignores isolated hitches: a 200 ms frame among 60 FPS frames never drops a tier', () => {
    const gr = new GameRenderer({ canvas: mockCanvas });
    const initialRatio = gr.pixelRatio;
    let time = 100;
    for (let i = 0; i < 600; i++) {
      // a streaming hitch every 45 frames would have dragged a moving average over 18.5 ms
      const dt = i % 45 === 0 ? 0.14 : 0.0167;
      time += dt * 1000;
      gr.adapt(dt, time);
    }
    expect(gr.pixelRatio).toBe(initialRatio);
    gr.dispose();
  });

  it('downscales under sustained load after settling and recovers smoothly when framerate improves', () => {
    const gr = new GameRenderer({ canvas: mockCanvas });
    const initialScale = gr.pixelRatio;

    // First trigger initial settling timestamp at t = 100
    gr.adapt(0.016, 100);

    // Fast-forward past settling period (t > 2600) with sustained slow frames (0.040s = 25 FPS)
    let time = 3000;
    for (let i = 0; i < 60; i++) {
      time += 40;
      gr.adapt(0.040, time);
    }

    // After sustained slow frames beyond settling period, pixel ratio steps down
    expect(gr.pixelRatio).toBeLessThan(initialScale);
    const reducedRatio = gr.pixelRatio;

    // Now simulate sustained fast recovery (0.016s = 62 FPS) past the 5 s hold
    for (let i = 0; i < 400; i++) {
      time += 16;
      gr.adapt(0.016, time);
    }

    // Resolution recovers upward
    expect(gr.pixelRatio).toBeGreaterThan(reducedRatio);
    gr.dispose();
  });
});
