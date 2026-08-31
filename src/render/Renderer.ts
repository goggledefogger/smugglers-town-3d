/**
 * three.js renderer + scene + camera setup. Owns the canvas and resize
 * handling; everything else is added to the scene by the view modules.
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, Color, Fog,
  DirectionalLight, AmbientLight, HemisphereLight,
  SRGBColorSpace, ACESFilmicToneMapping
} from 'three';

export interface RendererDeps {
  readonly canvas: HTMLCanvasElement;
  readonly onResize?: (w: number, h: number) => void;
}

const SKY = 0xbcd8ec;

export class GameRenderer {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  private readonly deps: RendererDeps;

  constructor(deps: RendererDeps) {
    this.deps = deps;
    this.renderer = new WebGLRenderer({ canvas: deps.canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    // sRGB output + ACES filmic so satellite textures read as real daylight
    // instead of washed-out flat Lambert
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = new Color(SKY);
    this.scene.fog = new Fog(SKY, 200, 700);

    this.camera = new PerspectiveCamera(
      62, window.innerWidth / window.innerHeight, 0.5, 2000
    );
    this.camera.position.set(0, 20, 30);

    const sun = new DirectionalLight(0xfff2dd, 1.4);
    sun.position.set(120, 200, 80);
    this.scene.add(sun);
    this.scene.add(new AmbientLight(0x8899bb, 0.6));
    this.scene.add(new HemisphereLight(SKY, 0x6b5a3a, 0.5));

    window.addEventListener('resize', () => this.handleResize());
  }

  private handleResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.deps.onResize?.(window.innerWidth, window.innerHeight);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  get maxAnisotropy(): number {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    this.renderer.dispose();
  }
}
