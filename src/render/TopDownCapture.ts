/**
 * The render-and-readback core shared by True Surface (SurfaceCapture, for the
 * wheels) and the Cutout height field (HeightCapture): an orthographic camera
 * straight down, the tile group moved into a private scene for one render call
 * under an override material that writes world Y (plus an offset) into the red
 * channel of a square float target, and a non-stalling readback.
 *
 * The override material bypasses the cutout discard in the tile shader, so a
 * footprint the stencil drops can still be measured and come back.
 *
 * Owns the GPU objects only; what the texels mean, and when to capture, is the
 * caller's. Lives in render/ because it holds WebGL objects.
 */
import {
  DoubleSide, FloatType, NearestFilter, OrthographicCamera, RedFormat, RGBAFormat, Scene,
  ShaderMaterial, WebGLRenderTarget, Color, Mesh, PlaneGeometry,
  type Object3D, type WebGLRenderer
} from 'three';
import { logger } from '../app/log.ts';

/** Below the lowest base ground: the depth range must reach under a sunken street. */
export const TOPDOWN_FLOOR_MARGIN_M = 60;

const VERT = /* glsl */`
varying float vWorldY;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldY = wp.y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FRAG = /* glsl */`
uniform float uOffset;
varying float vWorldY;
void main() {
  gl_FragColor = vec4(vWorldY + uOffset, 0.0, 0.0, 1.0);
}`;

export class TopDownCapture {
  private rt: WebGLRenderTarget;
  /** RGBA fallback only: four floats per texel, red is copied out. */
  private rgba: Float32Array | null = null;
  private readonly camera = new OrthographicCamera();
  private readonly scene = new Scene();
  private readonly material: ShaderMaterial;
  private readonly prevClear = new Color();
  private asyncBroken = false;
  private disposed = false;
  /** Tagged by the caller's label, so True Surface still logs as 'surface' and the heights as 'height'. */
  private readonly log: ReturnType<typeof logger>;
  /** False until the capture program has compiled off the frame (compileAsync). */
  compiled = false;
  /** A readback is outstanding. */
  inFlight = false;

  /**
   * @param res target side in texels
   * @param encodeOffset added to world Y in the shader; the clear value is 0, so an offset that keeps every real
   *   surface above 0 lets the caller tell "no tile drew" from a surface
   * @param label for the log line when the warm-up or the read refuses
   */
  constructor(
    private readonly renderer: WebGLRenderer,
    readonly res: number,
    encodeOffset: number,
    label = 'surface'
  ) {
    this.log = logger(label);
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uOffset: { value: encodeOffset } },
      // the projection is mirrored to get x and z ascending in the buffer, which
      // flips winding; and the top surface is wanted whichever way a triangle faces
      side: DoubleSide,
      toneMapped: false
    });
    this.rt = this.makeTarget(RedFormat);
    this.scene.overrideMaterial = this.material;
    this.scene.matrixWorldAutoUpdate = false;
    // world x and z ascending along the buffer's columns and rows: camera-local
    // +x is world -x with up = +z, so the projection's left/right swap back
    this.camera.up.set(0, 0, 1);
    // the tiles draw on their own layer (main.ts sets layer 1 and the view
    // modes switch it on and off on the main camera); this camera sees every
    // layer, since its scene only ever holds the tile group
    this.camera.layers.enableAll();
    // compile the capture program in the background: compiled on first use it
    // cost a ~0.5 s frame. compile() ignores overrideMaterial, so warm it on a
    // stand-in mesh in a scene with the same (absent) lights and fog
    const warm = new Scene();
    const stand = new Mesh(new PlaneGeometry(1, 1), this.material);
    warm.add(stand);
    // with the capture target bound, so the program key (tone mapping, output
    // colour space) matches the real capture and is not compiled a second time
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    let warming: Promise<unknown>;
    try {
      warming = renderer.compileAsync(warm, this.camera);
    } finally {
      renderer.setRenderTarget(prev);
    }
    warming
      .catch(e => this.log.warn('program warm-up failed; compiling on first capture', e))
      .finally(() => {
        stand.geometry.dispose();
        this.compiled = true;
      });
  }

  private makeTarget(format: typeof RedFormat | typeof RGBAFormat): WebGLRenderTarget {
    const res = this.res;
    return new WebGLRenderTarget(res, res, {
      type: FloatType, format, minFilter: NearestFilter, magFilter: NearestFilter,
      generateMipmaps: false, depthBuffer: true, stencilBuffer: false
    });
  }

  /**
   * Render `group` straight down over the square centred (cx, cz), `half` metres to each side, from camera
   * height `topY` to `bottomY`. The group goes back where it was, in a `finally`.
   */
  render(group: Object3D, cx: number, cz: number, half: number, topY: number, bottomY: number): void {
    const r = this.renderer;
    const cam = this.camera;
    cam.left = half; cam.right = -half; cam.top = half; cam.bottom = -half;
    cam.near = 0.5;
    cam.far = topY - bottomY;
    cam.position.set(cx, topY, cz);
    cam.lookAt(cx, bottomY, cz);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const parent = group.parent;
    const visible = group.visible;
    const prevTarget = r.getRenderTarget();
    r.getClearColor(this.prevClear);
    const prevAlpha = r.getClearAlpha();
    const prevAutoClear = r.autoClear;
    try {
      this.scene.add(group);
      group.visible = true;
      r.setRenderTarget(this.rt);
      r.setClearColor(0x000000, 0);
      r.autoClear = false;
      r.clear(true, true, false);
      r.render(this.scene, cam);
    } finally {
      this.scene.remove(group);
      if (parent) parent.add(group);
      group.visible = visible;
      r.setRenderTarget(prevTarget);
      r.setClearColor(this.prevClear, prevAlpha);
      r.autoClear = prevAutoClear;
    }
  }

  /**
   * Read the target's red channel into `dst` (res*res floats). `onDone` runs when `dst` is filled (synchronously on
   * the last-resort path). `onRetry` runs when the async read refused R32F and the target was swapped for an RGBA
   * one: nothing was read, capture again.
   */
  readback(dst: Float32Array, onDone: () => void, onRetry: () => void): void {
    const res = this.res;
    const out = this.rgba ?? dst;
    const done = (): void => {
      this.inFlight = false;
      if (this.disposed) return;
      if (this.rgba) {
        const src = this.rgba;
        for (let k = 0; k < dst.length; k++) dst[k] = src[k * 4]!;
      }
      onDone();
    };
    if (!this.asyncBroken) {
      this.inFlight = true;
      // r169 checks IMPLEMENTATION_COLOR_READ_FORMAT before binding the target,
      // so it asks about whatever framebuffer is bound (the canvas: RGBA) and
      // refuses R32F. Binding ours first makes it ask about the right one; the
      // check runs synchronously, before the method's first await.
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.rt);
      let pending: Promise<unknown>;
      try {
        pending = this.renderer.readRenderTargetPixelsAsync(this.rt, 0, 0, res, res, out);
      } finally {
        this.renderer.setRenderTarget(prev);
      }
      pending
        .then(done)
        .catch(e => {
          this.inFlight = false;
          this.asyncBroken = true;
          if (this.fallBack(e)) onRetry();
        });
      return;
    }
    // last resort: a synchronous read stalls the frame on the GPU
    this.renderer.readRenderTargetPixels(this.rt, 0, 0, res, res, out);
    done();
  }

  /**
   * The async read refused this format (a driver whose implementation read
   * format for R32F is not RED): switch to an RGBA float target, which every
   * WebGL2 implementation must read. True when the target was swapped (retry).
   */
  private fallBack(e: unknown): boolean {
    // a readback that fails after dispose() must not allocate a new target nobody will free
    if (this.disposed) return false;
    if (this.rgba) {
      this.log.warn('async readback unavailable; using a synchronous read (frame stalls)', e);
      return false;
    }
    this.log.warn('R32F readback refused; retrying with an RGBA float target', e);
    this.rt.dispose();
    this.rt = this.makeTarget(RGBAFormat);
    this.rgba = new Float32Array(this.res * this.res * 4);
    this.asyncBroken = false;
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.rt.dispose();
    this.material.dispose();
  }
}
