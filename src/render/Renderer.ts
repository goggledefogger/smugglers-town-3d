/**
 * three.js renderer + scene + camera setup. Owns the canvas, resize handling,
 * the painted sky, and adaptive resolution; everything else is added to the
 * scene by the view modules.
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, Fog, Vector3,
  DirectionalLight, AmbientLight, HemisphereLight,
  SRGBColorSpace, ACESFilmicToneMapping,
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
  private firstFrameMs = 0;
  private lastAdjustMs = -Infinity;

  private computeDisplayLimits(): { baseRatio: number; minScale: number } {
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    // On standard 1x displays (<=1.25): native 1:1 pixel mapping (1.0).
    // Minimum scale is 0.85 to maintain readability under extreme load.
    if (dpr <= 1.25) {
      return { baseRatio: 1.0, minScale: 0.85 };
    }
    // High-DPI (Retina, mobile, 4K): 1.5x. Measured on an M1 Pro 14" driving
    // Manhattan: 1.25 holds 120 Hz, 1.5 and 2.0 both hold a solid 60 Hz with
    // no spikes, so 1.5 buys the sharper image for nothing visible; the tiers
    // below take weaker GPUs down to 1.29 and 1.11.
    const baseRatio = Math.min(dpr, 1.5);
    return { baseRatio, minScale: 0.72 };
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

    const sun = new DirectionalLight(LIGHTING_COLORS.sun, 1.4);
    sun.position.copy(SUN_POS);
    this.scene.add(sun);
    this.scene.add(new AmbientLight(LIGHTING_COLORS.ambient, 0.6));
    this.scene.add(new HemisphereLight(SKY_MID_LIGHT, LIGHTING_COLORS.groundBounce, 0.5));

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => this.handleResize());
    }
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
    log.debug('render scale', {
      tier,
      pixelRatio: Number((this.baseRatio * this.scale).toFixed(3)),
      medianMs: Number((median * 1000).toFixed(1))
    });
  }

  get pixelRatio(): number {
    return this.baseRatio * this.scale;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Compile an object's programs and upload its textures now. three does both
   * lazily on the first frame an object is drawn, so a turn that brings fifty
   * streamed tiles into view was a 200 ms stall; doing it as each tile lands
   * spreads the same work over the download.
   */
  warm(obj: Object3D): void {
    this.renderer.compile(obj, this.camera, this.scene);
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
    return Math.min(this.renderer.capabilities.getMaxAnisotropy(), 4);
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
    this.renderer.dispose();
  }
}
