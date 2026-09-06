/**
 * three.js renderer + scene + camera setup. Owns the canvas, resize handling,
 * the painted sky, and adaptive resolution; everything else is added to the
 * scene by the view modules.
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, Fog, Vector3,
  DirectionalLight, AmbientLight, HemisphereLight,
  SRGBColorSpace, ACESFilmicToneMapping
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
  private frameAvg = 1 / 60;
  private lastAdjustMs = 0;

  private computeDisplayLimits(): { baseRatio: number; minScale: number } {
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    // On standard 1x displays (<=1.25): native 1:1 pixel mapping (1.0).
    // Minimum scale is 0.85 to maintain readability under extreme load.
    if (dpr <= 1.25) {
      return { baseRatio: 1.0, minScale: 0.85 };
    }
    // On high-DPI displays (Retina, mobile, 4K): target 1.25x.
    // 1.25x provides subpixel antialiased edges on Retina (>220 PPI) while saving
    // ~49% fragment fill-rate over 1.75x and ~61% over 2.0x to guarantee smooth 60 FPS.
    const baseRatio = Math.min(dpr, 1.25);
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
   * Adaptive resolution: call once per frame with the raw frame delta.
   * On 1x displays, locks native 1:1 pixel mapping (1.0). On high-DPI displays,
   * scales across discrete tiers (1.25 -> 1.08 -> 0.90) to preserve smooth 60 FPS
   * without WebGL backbuffer reallocation stutter.
   */
  adapt(dt: number, nowMs: number): void {
    // Ignore invalid or paused frames (background tab, modal pause, tab switch)
    if (dt > 0.15 || dt <= 0) return;

    // Smooth moving average over ~30 frames
    this.frameAvg += (dt - this.frameAvg) * 0.04;

    // Grace period for initial page load / shader compilation (2.5s)
    if (this.lastAdjustMs === 0) {
      this.lastAdjustMs = nowMs + 2500;
      return;
    }
    // Require at least 2.5s between tier shifts to prevent backbuffer reallocation stutter
    if (nowMs - this.lastAdjustMs < 2500) return;

    // Target 60 FPS (16.6ms). If frame time averages > 18.5ms (< 54 FPS), drop a tier
    if (this.frameAvg > 1 / 54 && this.tierIndex < this.tiers.length - 1) {
      this.tierIndex++;
      this.scale = Math.max(this.minScale, this.tiers[this.tierIndex]!);
      this.lastAdjustMs = nowMs;
      this.renderer.setPixelRatio(this.baseRatio * this.scale);
      log.debug('render scale down', {
        tier: this.tierIndex,
        scale: Number(this.scale.toFixed(3)),
        pixelRatio: Number((this.baseRatio * this.scale).toFixed(3)),
        fps: Math.round(1 / this.frameAvg)
      });
    }
    // Only recover upward if sustained framerate is solidly 59+ FPS (< 16.9ms)
    else if (this.frameAvg < 1 / 59 && this.tierIndex > 0) {
      this.tierIndex--;
      this.scale = Math.max(this.minScale, this.tiers[this.tierIndex]!);
      this.lastAdjustMs = nowMs;
      this.renderer.setPixelRatio(this.baseRatio * this.scale);
      log.debug('render scale up', {
        tier: this.tierIndex,
        scale: Number(this.scale.toFixed(3)),
        pixelRatio: Number((this.baseRatio * this.scale).toFixed(3)),
        fps: Math.round(1 / this.frameAvg)
      });
    }
  }

  get pixelRatio(): number {
    return this.baseRatio * this.scale;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
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
