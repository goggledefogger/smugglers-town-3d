import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Texture } from 'three';
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
      ACTIVE_UNIFORMS: 0x8b86,
      ACTIVE_ATTRIBUTES: 0x8b89,
      createProgram: vi.fn(() => ({})),
      createShader: vi.fn(() => ({})),
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
      getProgramParameter: vi.fn((_program, param) => param === 0x8b86 || param === 0x8b89 ? 0 : true),
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
    vi.useRealTimers();
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

  describe('shader warmup', () => {
    let ready: boolean;
    let gr: GameRenderer;
    let tile: Group;
    let material: MeshBasicMaterial;

    beforeEach(() => {
      vi.useFakeTimers();
      ready = false;
      const gl = mockCanvas.getContext('webgl2')!;
      vi.mocked(gl.getExtension as (name: string) => unknown).mockImplementation(name => name === 'KHR_parallel_shader_compile'
        ? { COMPLETION_STATUS_KHR: 0x91b1 } : null);
      vi.mocked(gl.getProgramParameter).mockImplementation((_program, param) => {
        if (param === 0x91b1) return ready;
        return param === 0x8b86 || param === 0x8b89 ? 0 : true;
      });
      gr = new GameRenderer({ canvas: mockCanvas });
      material = new MeshBasicMaterial();
      tile = new Group();
      tile.add(new Mesh(new BoxGeometry(), material));
      tile.traverse(o => o.layers.set(1));
      gr.camera.layers.disable(1);
      gr.scene.add(tile);
    });

    afterEach(() => {
      gr.dispose();
      material.dispose();
      tile.traverse(o => { if (o instanceof Mesh) o.geometry.dispose(); });
    });

    it('survives disposing a real Three.js tile material during readiness polling', async () => {
      gr.warm(tile);
      expect(gr.renderer.properties.get(material)).toHaveProperty('currentProgram');
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      gr.scene.remove(tile);
      material.dispose();
      expect(gr.renderer.properties.get(material)).not.toHaveProperty('currentProgram');
      await vi.advanceTimersByTimeAsync(10);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([true, false])('preserves mode visibility changes while warming (initially %s)', async initial => {
      tile.visible = initial;
      gr.warm(tile);
      tile.visible = !initial;
      ready = true;
      await vi.advanceTimersByTimeAsync(10);
      expect(tile.visible).toBe(!initial);
      expect(gr.camera.layers.mask).toBe(1);
    });

    it('keeps pending tiles out of draws, then draws only after every live material is ready', async () => {
      const second = new MeshBasicMaterial({ color: 0xff0000 });
      (tile.children[0] as Mesh).material = [material, second];
      gr.camera.layers.enable(1);
      const draw = vi.spyOn(gr.renderer, 'render').mockImplementation(() => {
        expect(tile.visible).toBe(ready);
      });
      try {
        gr.warm(tile);
        material.dispose();
        await vi.advanceTimersByTimeAsync(10);
        gr.render();
        expect(tile.visible).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        ready = true;
        await vi.advanceTimersByTimeAsync(10);
        gr.render();
        expect(draw).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        second.dispose();
      }
    });

    it('deduplicates overlapping warmups and still uploads textures eagerly', async () => {
      const map = new Texture();
      material.map = map;
      const upload = vi.spyOn(gr.renderer, 'initTexture').mockImplementation(() => {});
      const compile = vi.spyOn(gr.renderer, 'compile');
      gr.warm(tile);
      gr.warm(tile);
      expect(compile).toHaveBeenCalledTimes(1);
      expect(upload).toHaveBeenCalledWith(map);
      ready = true;
      await vi.advanceTimersByTimeAsync(10);
      expect(tile.visible).toBe(true);
      map.dispose();
    });

    it('cancels readiness callbacks when the renderer is disposed', async () => {
      gr.warm(tile);
      gr.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10);
    });

    it('suppresses pending tiles in both projection passes without changing mode visibility', async () => {
      (window as any).__tiles = { group: tile };
      tile.visible = false;
      gr.setProjecting3dTiles(true);
      gr.warm(tile);
      const visibleAtDraw: boolean[] = [];
      vi.spyOn(gr.renderer, 'setRenderTarget').mockImplementation(() => {});
      vi.spyOn(gr.renderer, 'render').mockImplementation(() => { visibleAtDraw.push(tile.visible); });
      gr.render();
      expect(visibleAtDraw).toEqual([false, false]);
      expect(tile.visible).toBe(false);
      ready = true;
      await vi.advanceTimersByTimeAsync(10);
      gr.render();
      expect(visibleAtDraw).toEqual([false, false, true, false]);
      expect(tile.visible).toBe(false);
    });

    it('restores draw-scoped visibility even when drawing throws', () => {
      gr.warm(tile);
      vi.spyOn(gr.renderer, 'render').mockImplementation(() => { throw new Error('draw failed'); });
      expect(() => gr.render()).toThrow('draw failed');
      expect(tile.visible).toBe(true);
    });

    it('handles disposal during the fallback delay without parallel shader support', async () => {
      gr.dispose();
      vi.mocked(mockCanvas.getContext('webgl2')!.getExtension).mockReturnValue(null);
      gr = new GameRenderer({ canvas: mockCanvas });
      gr.warm(tile);
      expect(vi.getTimerCount()).toBe(1);
      material.dispose();
      await vi.advanceTimersByTimeAsync(10);
      expect(vi.getTimerCount()).toBe(0);
      expect(tile.visible).toBe(true);
    });
  });
});
