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
  private frameAvg = 1 / 60;
  private lastAdjustMs = 0;

  private computeDisplayLimits(): { baseRatio: number; minScale: number } {
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    // On standard 1x displays (<=1.25): native 1:1 pixel mapping (1.0).
    // Minimum scale is 0.90 to never drop into blurry sub-native pixelation unless under extreme stress.
    if (dpr <= 1.25) {
      return { baseRatio: 1.0, minScale: 0.90 };
    }
    // On high-DPI displays (Retina, mobile, 4K): target up to 1.75x.
    // 1.75x provides 95%+ of 2x crispness while saving ~25% fragment shading fill-rate on mobile/integrated GPUs.
    const baseRatio = Math.min(dpr, 1.75);
    return { baseRatio, minScale: 0.75 };
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
   * scales between 0.75 and 1.0 (effective DPR 1.31–1.75) to preserve 60 FPS
   * without visual degradation.
   */
  adapt(dt: number, nowMs: number): void {
    // Ignore invalid or paused frames (background tab, modal pause, tab switch)
    if (dt > 0.15 || dt <= 0) return;

    // Smooth moving average over ~30 frames
    this.frameAvg += (dt - this.frameAvg) * 0.035;

    // Grace period for initial page load / shader compilation (2.5s)
    if (this.lastAdjustMs === 0) {
      this.lastAdjustMs = nowMs + 2500;
      return;
    }
    if (nowMs - this.lastAdjustMs < 1200) return;

    let next = this.scale;
    // Downscale only if sustained frame rate drops below 35 FPS (28.5ms)
    if (this.frameAvg > 1 / 35 && this.scale > this.minScale) {
      next = Math.max(this.minScale, this.scale - 0.08);
    }
    // Upscale smoothly when frame rate is healthy and comfortably above 48 FPS (20.8ms)
    else if (this.frameAvg < 1 / 48 && this.scale < 1) {
      next = Math.min(1, this.scale + 0.1);
    }

    if (Math.abs(next - this.scale) < 0.005) return;
    this.scale = next;
    this.lastAdjustMs = nowMs;
    this.renderer.setPixelRatio(this.baseRatio * this.scale);
    log.debug('render scale', {
      scale: Number(this.scale.toFixed(3)),
      pixelRatio: Number((this.baseRatio * this.scale).toFixed(3)),
      fps: Math.round(1 / this.frameAvg)
    });
  }

  get pixelRatio(): number {
    return this.baseRatio * this.scale;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  get maxAnisotropy(): number {
    return this.renderer.capabilities.getMaxAnisotropy();
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
