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
  private readonly maxRatio = Math.min(2, window.devicePixelRatio);
  private scale = 1;
  private frameAvg = 1 / 60;
  private lastAdjustMs = 0;

  constructor(deps: RendererDeps) {
    this.deps = deps;
    this.renderer = new WebGLRenderer({ canvas: deps.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(this.maxRatio);
    // sRGB output + ACES filmic so satellite textures read as real daylight
    // instead of washed-out flat Lambert
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = makeSkyTexture(SUN_POS);
    this.scene.fog = new Fog(SKY_HORIZON, 1500, 5000);

    this.camera = new PerspectiveCamera(
      62, window.innerWidth / window.innerHeight, 0.5, 8000
    );
    this.camera.position.set(0, 20, 30);

    const sun = new DirectionalLight(0xfff2dd, 1.4);
    sun.position.copy(SUN_POS);
    this.scene.add(sun);
    this.scene.add(new AmbientLight(0x8899bb, 0.6));
    this.scene.add(new HemisphereLight(SKY_MID_LIGHT, 0x6b5a3a, 0.5));

    window.addEventListener('resize', () => this.handleResize());
  }

  private handleResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.deps.onResize?.(window.innerWidth, window.innerHeight);
  }

  /**
   * Adaptive resolution: call once per frame with the raw frame delta. When
   * frames average slower than 45 fps the pixel ratio steps down (to half
   * the display's at worst); when they run comfortably it steps back up.
   * Resolution is the one knob that scales GPU cost on every machine
   * without touching what the game looks like up close.
   */
  adapt(dt: number, nowMs: number): void {
    this.frameAvg += (Math.min(dt, 0.1) - this.frameAvg) * 0.05;
    if (nowMs - this.lastAdjustMs < 1000) return;
    let next = this.scale;
    if (this.frameAvg > 1 / 40 && this.scale > 0.75) next = Math.max(0.75, this.scale - 0.1);
    else if (this.frameAvg < 1 / 52 && this.scale < 1) next = Math.min(1, this.scale + 0.15);
    if (next === this.scale) return;
    this.scale = next;
    this.lastAdjustMs = nowMs;
    this.renderer.setPixelRatio(this.maxRatio * this.scale);
    log.debug('render scale', { scale: Number(this.scale.toFixed(3)), fps: Math.round(1 / this.frameAvg) });
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
    window.removeEventListener('resize', this.handleResize);
    this.renderer.dispose();
  }
}
