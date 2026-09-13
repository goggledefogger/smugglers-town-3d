/**
 * three.js renderer + scene + camera setup. Owns the canvas, resize handling,
 * the painted sky, and adaptive resolution; everything else is added to the
 * scene by the view modules.
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, Fog, Vector3, Vector2,
  DirectionalLight, AmbientLight, HemisphereLight,
  SRGBColorSpace, ACESFilmicToneMapping, WebGLRenderTarget,
  RGBAFormat, UnsignedByteType, LinearFilter,
  type Object3D, type Mesh, type Material, type Texture
} from 'three';
import { makeSkyTexture, SKY_HORIZON, SKY_MID_LIGHT } from './skyTexture.ts';
import { LIGHTING_COLORS } from '../core/theme.ts';
import { logger } from '../app/log.ts';

const log = logger('render');

export interface RendererDeps {
  readonly canvas: HTMLCanvasElement;
  readonly onResize?: (w: number, h: number) => void;
}

const SUN_POS = new Vector3(120, 200, 80);

/**
 * Two light rigs. Arcade lights the procedural desert and Game 3D boxes the
 * way they were designed. Photo is for real places: the tiles and satellite
 * ground are unlit photos shown as-is, so the sun, sky and ambient are scaled
 * to put a lit car's upward faces at about the brightness of a photographed
 * surface with the same albedo, instead of half again brighter.
 */
const LIGHT_RIGS = {
  arcade: { sun: 1.4, ambient: 0.6, hemi: 0.5, exposure: 1.05 },
  photo: { sun: 1.0, ambient: 0.35, hemi: 0.35, exposure: 1.0 }
} as const;

export class GameRenderer {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  private readonly deps: RendererDeps;
  private baseRatio: number;
  private minScale: number;
  private scale = 1;
  private tierIndex = 0;
  private readonly tiers = [1.0, 0.86, 0.74];
  // last 1.5 s of frame times; the median ignores the hitches a mean does not
  private readonly frameWindow = new Float32Array(90);
  private frameCount = 0;
  private dprCap = 1.5;
  private firstFrameMs = 0;
  private lastAdjustMs = -Infinity;
  private readonly sun: DirectionalLight;
  private readonly ambient: AmbientLight;
  private readonly hemi: HemisphereLight;
  private tilesTarget: WebGLRenderTarget | null = null;
  private isProjecting3dTiles = false;
  private readonly _res = new Vector2();

  private computeDisplayLimits(): { baseRatio: number; minScale: number } {
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    // On standard 1x displays (<=1.25): native 1:1 pixel mapping (or supersampled if dprCap > 1.5).
    // Minimum scale is 0.85 to maintain readability under extreme load.
    if (dpr <= 1.25) {
      const baseRatio = this.dprCap > 1.5 ? Math.min(1.5, this.dprCap) : 1.0;
      return { baseRatio, minScale: 0.85 };
    }
    // High-DPI (Retina, mobile, 4K): capped at dprCap (1.5 for balanced, 2.0 for native Retina, 2.5 for ultra)
    const baseRatio = Math.min(dpr, this.dprCap);
    return { baseRatio, minScale: 0.72 };
  }

  setDprCap(cap: number): void {
    if (this.dprCap === cap) return;
    this.dprCap = cap;
    this.handleResize();
  }

  constructor(deps: RendererDeps) {
    this.deps = deps;
    const limits = this.computeDisplayLimits();
    this.baseRatio = limits.baseRatio;
    this.minScale = limits.minScale;

    const width = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const height = typeof window !== 'undefined' ? window.innerHeight : 800;

    this.renderer = new WebGLRenderer({ canvas: deps.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(this.baseRatio * this.scale);
    // sRGB output + ACES filmic so satellite textures read as real daylight
    // instead of washed-out flat Lambert
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = makeSkyTexture(SUN_POS);
    this.scene.fog = new Fog(SKY_HORIZON, 1500, 5000);

    this.camera = new PerspectiveCamera(
      62, width / height, 0.5, 8000
    );
    this.camera.position.set(0, 20, 30);

    this.sun = new DirectionalLight(LIGHTING_COLORS.sun, 1.4);
    this.sun.position.copy(SUN_POS);
    this.sun.layers.enable(1);
    this.scene.add(this.sun);
    this.ambient = new AmbientLight(LIGHTING_COLORS.ambient, 0.6);
    this.ambient.layers.enable(1);
    this.scene.add(this.ambient);
    this.hemi = new HemisphereLight(SKY_MID_LIGHT, LIGHTING_COLORS.groundBounce, 0.5);
    this.hemi.layers.enable(1);
    this.scene.add(this.hemi);
    this.setLightRig('arcade');

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => this.handleResize());
      deps.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        log.warn('WebGL context lost — reload recommended');
      });
      deps.canvas.addEventListener('webglcontextrestored', () => {
        log.info('WebGL context restored — reloading');
        window.location.reload();
      });
    }
  }

  /** Photo for real places seen through their tiles; arcade for everything drawn by the game. */
  setLightRig(rig: keyof typeof LIGHT_RIGS): void {
    const r = LIGHT_RIGS[rig];
    this.sun.intensity = r.sun;
    this.ambient.intensity = r.ambient;
    this.hemi.intensity = r.hemi;
    this.renderer.toneMappingExposure = r.exposure;
  }

  private handleResize(): void {
    const limits = this.computeDisplayLimits();
    this.baseRatio = limits.baseRatio;
    this.minScale = limits.minScale;
    const width = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const height = typeof window !== 'undefined' ? window.innerHeight : 800;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.baseRatio * this.scale);
    this.renderer.setSize(width, height);
    if (this.tilesTarget) {
      this.tilesTarget.setSize(Math.round(width * this.pixelRatio), Math.round(height * this.pixelRatio));
    }
    this.deps.onResize?.(width, height);
  }

  /**
   * Adaptive resolution: call once per frame with the raw frame delta. On 1x
   * displays this locks 1:1; on high-DPI it steps through discrete tiers
   * (1.25 -> 1.08 -> 0.93). A tier change resizes the canvas and reallocates
   * the multisampled backbuffer, a ~150 ms stall, so it must only answer
   * sustained GPU overload: the trigger is the median of the last 1.5 s
   * (a single 200 ms hitch cannot move it, where it dragged the old moving
   * average over the line), after a 5 s grace and with 5 s between changes.
   */
  adapt(dt: number, nowMs: number): void {
    // Ignore invalid or paused frames (background tab, modal pause, tab switch)
    if (dt > 0.15 || dt <= 0) return;
    this.frameWindow[this.frameCount++ % this.frameWindow.length] = dt;

    if (this.firstFrameMs === 0) this.firstFrameMs = nowMs;
    if (nowMs - this.firstFrameMs < 5000 || nowMs - this.lastAdjustMs < 5000) return;
    const filled = Math.min(this.frameCount, this.frameWindow.length);
    if (filled < 30) return;

    const sorted = this.frameWindow.slice(0, filled).sort();
    const median = sorted[filled >> 1]!;
    // 18.5 ms (< 54 FPS) for most frames means the GPU is the bottleneck: drop a tier
    if (median > 1 / 54 && this.tierIndex < this.tiers.length - 1) this.setTier(this.tierIndex + 1, nowMs, median);
    // recover once frames are solidly under 16.9 ms (59+ FPS)
    else if (median < 1 / 59 && this.tierIndex > 0) this.setTier(this.tierIndex - 1, nowMs, median);
  }

  private setTier(tier: number, nowMs: number, median: number): void {
    this.tierIndex = tier;
    this.scale = Math.max(this.minScale, this.tiers[tier]!);
    this.lastAdjustMs = nowMs;
    this.renderer.setPixelRatio(this.baseRatio * this.scale);
    if (this.tilesTarget) {
      const w = this.renderer.domElement.width || 1280;
      const h = this.renderer.domElement.height || 720;
      this.tilesTarget.setSize(w, h);
    }
    log.debug('render scale', {
      tier,
      pixelRatio: Number((this.baseRatio * this.scale).toFixed(3)),
      medianMs: Number((median * 1000).toFixed(1))
    });
  }

  get pixelRatio(): number {
    return this.baseRatio * this.scale;
  }

  setProjecting3dTiles(enabled: boolean): void {
    this.isProjecting3dTiles = enabled;
    if (enabled) {
      const w = Math.round(this.renderer.domElement.width || 1280);
      const h = Math.round(this.renderer.domElement.height || 720);
      if (!this.tilesTarget) {
        this.tilesTarget = new WebGLRenderTarget(w, h, {
          minFilter: LinearFilter,
          magFilter: LinearFilter,
          format: RGBAFormat,
          type: UnsignedByteType,
          depthBuffer: true,
        });
      } else {
        this.tilesTarget.setSize(w, h);
      }
    }
  }

  getTilesTexture(): Texture | null {
    return this.tilesTarget?.texture ?? null;
  }

  getResolution(out?: Vector2): Vector2 {
    const res = out ?? this._res;
    const w = this.renderer.domElement.width || 1280;
    const h = this.renderer.domElement.height || 720;
    return res.set(w, h);
  }

  render(): void {
    if (this.isProjecting3dTiles && this.tilesTarget) {
      // 1. Offscreen pass: render 3D tiles (layer 1) with transparent background
      const prevBg = this.scene.background;
      this.scene.background = null;

      // Ensure clutter filter is off during offscreen pass so building facades are never clipped
      const clutterFilter = (window as any).__clutterFilter;
      const prevClutterMode = clutterFilter?.mode;
      if (clutterFilter) {
        clutterFilter.mode = 'off';
      }

      // Use this.camera directly so aspect, FOV, and projection matrix are 100% identical
      this.camera.layers.set(1);

      this.renderer.setRenderTarget(this.tilesTarget);
      this.renderer.setClearColor(0x000000, 0.0);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      this.scene.background = prevBg;

      if (clutterFilter && prevClutterMode !== undefined) {
        clutterFilter.mode = prevClutterMode;
      }

      // 2. Main scene camera only renders layer 0 (so tiles aren't drawn directly over the boxes)
      this.camera.layers.set(0);
    }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Compile an object's programs and upload its textures now. three does both
   * lazily on the first frame an object is drawn, so a turn that brings fifty
   * streamed tiles into view was a 200 ms stall; doing it as each tile lands
   * spreads the same work over the download.
   */
  warm(obj: Object3D): void {
    // link status is only read on first draw, and reading it blocks until the
    // driver has finished linking: with sync compile that wait landed inside
    // a frame (30-100 ms). compileAsync polls KHR_parallel_shader_compile
    // instead, so hide the object until every program is actually ready
    const wasVisible = obj.visible;
    obj.visible = false;
    this.renderer.compileAsync(obj, this.camera, this.scene)
      .catch(e => log.warn('shader compile failed', e))
      .finally(() => { obj.visible = wasVisible; });
    obj.traverse(o => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const map = (m as Material & { map?: Texture | null }).map;
        if (map) this.renderer.initTexture(map);
      }
    });
  }

  get maxAnisotropy(): number {
    return Math.min(this.renderer.capabilities.getMaxAnisotropy(), 16);
  }

  /**
   * The GPU behind the canvas, for bug reports — "it runs badly" means
   * something different on an integrated chip than on a discrete one. Browsers
   * may withhold the extension for fingerprinting reasons; then it is unknown.
   */
  get gpu(): string {
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return 'unknown';
    return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? 'unknown').slice(0, 60);
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.handleResize);
    }
    this.tilesTarget?.dispose();
    this.renderer.dispose();
  }
}
