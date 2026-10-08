/**
 * True Surface GPU capture: renders the photogrammetry tiles straight down
 * through an orthographic camera into a float render target whose red channel
 * is world Y, reads it back without stalling, and hands it to a
 * `SurfaceHeightfield` that the wheels sample (see core/terrain/SurfaceHeightfield.ts).
 *
 * Only the tiles are drawn: the tile group is moved into a private scene for
 * the one render call (and put back in a `finally`), so vehicles, props, sky,
 * the HUD and the terrain mesh are excluded by construction with no traversal.
 * Where no tile drew, the texel keeps the clear value and the composite falls
 * back to the base ground, which is what the terrain mesh drapes anyway.
 *
 * Lives in render/ rather than core/terrain/: it owns WebGL objects, and core/
 * stays three-math-only so the simulation tests in node.
 */
import {
  DoubleSide, FloatType, NearestFilter, OrthographicCamera, RedFormat, RGBAFormat, Scene,
  ShaderMaterial, WebGLRenderTarget, Color, Mesh, PlaneGeometry,
  type Object3D, type WebGLRenderer
} from 'three';
import {
  SURF_ENCODE_OFFSET, shouldRecapture, type SurfaceHeightfield
} from '../core/terrain/SurfaceHeightfield.ts';
import type { HeightSampler } from '../core/heightfield.ts';
import { logger } from '../app/log.ts';

const log = logger('surface');

/** Above the highest base ground in the window: anything taller is a roof, rejected by the band anyway. */
const CAMERA_HEADROOM_M = 600;
/** Below the lowest base ground: the depth range must reach under a sunken street. */
const FLOOR_MARGIN_M = 60;

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

export interface SurfaceTimings {
  /** CPU ms to submit the capture render (draw calls + state). */
  renderMs: number;
  /** Latency, ms from submit until the async readback resolved (fence polled every 4 ms, so not a stall). */
  readbackMs: number;
  /** Main-thread ms spent processing the last capture (band, blur, fade), summed over its frame slices. */
  processMs: number;
  captures: number;
}

export class SurfaceCapture {
  private rt: WebGLRenderTarget;
  /** RGBA fallback only: four floats per texel, red is copied out. */
  private rgba: Float32Array | null = null;
  private readonly camera = new OrthographicCamera();
  private readonly scene = new Scene();
  private readonly material = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uOffset: { value: SURF_ENCODE_OFFSET } },
    // the projection is mirrored to get x and z ascending in the buffer, which
    // flips winding; and the top surface is wanted whichever way a triangle faces
    side: DoubleSide,
    toneMapped: false
  });
  private readonly prevClear = new Color();
  private inFlight = false;
  private lastCaptureMs = -Infinity;
  private dirty = false;
  private asyncBroken = false;
  private disposed = false;
  /** False until the capture program has compiled off the frame (compileAsync). */
  private compiled = false;
  /** Bumped by reset(): a readback started before it lands nowhere. */
  private generation = 0;
  readonly timings: SurfaceTimings = { renderMs: 0, readbackMs: 0, processMs: 0, captures: 0 };

  constructor(
    private readonly renderer: WebGLRenderer,
    readonly field: SurfaceHeightfield,
    /** The tile group to capture, or null while there is none. */
    private readonly source: () => Object3D | null,
    /** The base ground, for the camera's depth range. */
    private readonly base: () => HeightSampler
  ) {
    this.rt = this.makeTarget(RedFormat);
    this.scene.overrideMaterial = this.material;
    this.scene.matrixWorldAutoUpdate = false;
    // world x and z ascending along the buffer's columns and rows: camera-local
    // +x is world -x with up = +z, so the projection's left/right swap back
    this.camera.up.set(0, 0, 1);
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
      .catch(e => log.warn('surface program warm-up failed; compiling on first capture', e))
      .finally(() => {
        stand.geometry.dispose();
        this.compiled = true;
      });
  }

  private makeTarget(format: typeof RedFormat | typeof RGBAFormat): WebGLRenderTarget {
    const res = this.field.res;
    return new WebGLRenderTarget(res, res, {
      type: FloatType, format, minFilter: NearestFilter, magFilter: NearestFilter,
      generateMipmaps: false, depthBuffer: true, stencilBuffer: false
    });
  }

  /**
   * Forget the current capture (new world, or the mode was switched off):
   * the field reads as base until a fresh capture lands, and a readback still
   * in flight is dropped. The GPU objects are kept, so switching the mode back
   * on costs no shader compile.
   */
  reset(): void {
    this.generation++;
    this.field.clear();
    this.lastCaptureMs = -Infinity;
    this.dirty = false;
  }

  /** The tiles or the ground under them changed: recapture at the next allowed moment. */
  markDirty(): void {
    this.dirty = true;
  }

  /** Call every frame with the player's position: advances processing, starts a capture when due. */
  update(nowMs: number, px: number, pz: number, budgetMs = 1.5): void {
    if (this.disposed || !this.compiled) return;
    const f = this.field;
    if (f.processing) {
      if (f.step(budgetMs)) this.timings.processMs = f.lastProcessMs;
      return;
    }
    if (!shouldRecapture({
      nowMs, lastCaptureMs: this.lastCaptureMs, hasCapture: f.hasCapture, busy: this.inFlight,
      centerX: f.centerX, centerZ: f.centerZ, playerX: px, playerZ: pz,
      extentM: f.extentM, dirty: this.dirty
    })) return;
    const group = this.source();
    if (!group) return;
    this.lastCaptureMs = nowMs;
    this.dirty = false;
    // whole cells, so successive captures sample the same texel grid
    const cx = Math.round(px / f.cell) * f.cell;
    const cz = Math.round(pz / f.cell) * f.cell;
    this.capture(group, cx, cz);
  }

  private capture(group: Object3D, cx: number, cz: number): void {
    const r = this.renderer;
    const t0 = performance.now();
    const half = this.field.extentM / 2;
    const { lo, hi } = baseRange(this.base(), cx, cz, half);
    const top = hi + CAMERA_HEADROOM_M;
    const cam = this.camera;
    cam.left = half; cam.right = -half; cam.top = half; cam.bottom = -half;
    cam.near = 0.5;
    cam.far = top - lo + FLOOR_MARGIN_M;
    cam.position.set(cx, top, cz);
    cam.lookAt(cx, lo - FLOOR_MARGIN_M, cz);
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
    const t1 = performance.now();
    this.timings.renderMs = t1 - t0;
    this.timings.captures++;
    this.readback(cx, cz, t1);
  }

  private readback(cx: number, cz: number, t1: number): void {
    const res = this.field.res;
    const dst = this.rgba ?? this.field.readBuffer;
    const gen = this.generation;
    const done = (): void => {
      this.inFlight = false;
      if (this.disposed || gen !== this.generation) return;
      const t2 = performance.now();
      if (this.rgba) {
        const out = this.field.readBuffer, src = this.rgba;
        for (let k = 0; k < out.length; k++) out[k] = src[k * 4]!;
      }
      this.timings.readbackMs = t2 - t1;
      this.field.beginProcess(cx, cz);
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
        pending = this.renderer.readRenderTargetPixelsAsync(this.rt, 0, 0, res, res, dst);
      } finally {
        this.renderer.setRenderTarget(prev);
      }
      pending
        .then(done)
        .catch(e => {
          this.inFlight = false;
          this.asyncBroken = true;
          this.fallBack(e);
        });
      return;
    }
    // last resort: a synchronous read stalls the frame on the GPU
    this.renderer.readRenderTargetPixels(this.rt, 0, 0, res, res, dst);
    done();
  }

  /**
   * The async read refused this format (a driver whose implementation read
   * format for R32F is not RED): switch to an RGBA float target, which every
   * WebGL2 implementation must read, and retry on the next capture.
   */
  private fallBack(e: unknown): void {
    if (this.rgba) {
      log.warn('async surface readback unavailable; using a synchronous read (frame stalls)', e);
      return;
    }
    log.warn('R32F surface readback refused; retrying with an RGBA float target', e);
    this.rt.dispose();
    this.rt = this.makeTarget(RGBAFormat);
    this.rgba = new Float32Array(this.field.res * this.field.res * 4);
    this.asyncBroken = false;
    this.lastCaptureMs = -Infinity;
  }

  dispose(): void {
    this.disposed = true;
    this.rt.dispose();
    this.material.dispose();
  }
}

/**
 * Min and max of the base ground over the window, on a 24 m lattice (the
 * base is a smoothed 10 m field, and the camera range has tens of metres of
 * margin either way): ~1k samples rather than the whole 315k-node field.
 */
const _range = { lo: 0, hi: 0 };
function baseRange(hf: HeightSampler, cx: number, cz: number, half: number): { lo: number; hi: number } {
  let lo = Infinity, hi = -Infinity;
  const n = 32, step = (2 * half) / n;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const v = hf.sample(cx - half + i * step, cz - half + j * step);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  _range.lo = lo;
  _range.hi = hi;
  return _range;
}

/**
 * The F8 corner view of what the wheels see: the captured delta from the base
 * ground, grey 128 = on the base, lighter = above, darker = below (±the lower
 * band maps to white/black), with the player as a dot. Redrawn on each new capture; the
 * dot moves at the caller's pace.
 */
export class SurfacePreview {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly img: ImageData;
  private version = -1;

  constructor(private readonly size = 192) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.canvas.style.cssText = `position:fixed;left:12px;bottom:12px;width:${size}px;height:${size}px;z-index:9999;border:1px solid #ff5500;border-radius:4px;image-rendering:pixelated;pointer-events:none;display:none;`;
    this.canvas.title = 'True Surface: captured delta from base ground';
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(size, size);
  }

  set visible(v: boolean) {
    this.canvas.style.display = v ? 'block' : 'none';
  }

  draw(field: SurfaceHeightfield, px: number, pz: number): void {
    if (!field.hasCapture) return;
    const size = this.size, res = field.res;
    if (field.version !== this.version) {
      this.version = field.version;
      const d = field.activeDelta, px8 = this.img.data;
      const step = res / size, k = 127 / field.bandDownM;
      for (let y = 0; y < size; y++) {
        // canvas y down = world z ascending: north (-z) is up, as on the radar's north tick
        const r = Math.floor((y + 0.5) * step);
        for (let x = 0; x < size; x++) {
          const v = d[r * res + Math.floor((x + 0.5) * step)]!;
          const g = Math.max(0, Math.min(255, 128 + v * k));
          const o = (y * size + x) * 4;
          px8[o] = px8[o + 1] = px8[o + 2] = g;
          px8[o + 3] = 255;
        }
      }
    }
    this.ctx.putImageData(this.img, 0, 0);
    const s = size / field.extentM;
    const cx = (px - (field.centerX - field.extentM / 2)) * s;
    const cy = (pz - (field.centerZ - field.extentM / 2)) * s;
    this.ctx.fillStyle = '#ff2d55';
    this.ctx.fillRect(cx - 2, cy - 2, 4, 4);
  }

  dispose(): void {
    this.canvas.remove();
  }
}
