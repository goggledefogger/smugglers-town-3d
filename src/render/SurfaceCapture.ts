/**
 * True Surface GPU capture: renders the photogrammetry tiles straight down
 * through an orthographic camera into a float render target whose red channel
 * is world Y, reads it back without stalling, and hands it to a
 * `SurfaceHeightfield` that the wheels sample (see core/terrain/SurfaceHeightfield.ts).
 * The render-and-readback itself is TopDownCapture, shared with the Cutout
 * height field; this class owns the schedule and the hand-over to the field.
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
import type { Object3D, WebGLRenderer } from 'three';
import {
  SURF_ENCODE_OFFSET, shouldRecapture, type SurfaceHeightfield
} from '../core/terrain/SurfaceHeightfield.ts';
import type { HeightSampler } from '../core/heightfield.ts';
import { TopDownCapture, TOPDOWN_FLOOR_MARGIN_M } from './TopDownCapture.ts';

/** Above the highest base ground in the window: anything taller is a roof, rejected by the band anyway. */
const CAMERA_HEADROOM_M = 600;

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
  private readonly core: TopDownCapture;
  private lastCaptureMs = -Infinity;
  private dirty = false;
  private disposed = false;
  /** Bumped by reset(): a readback started before it lands nowhere. */
  private generation = 0;
  readonly timings: SurfaceTimings = { renderMs: 0, readbackMs: 0, processMs: 0, captures: 0 };

  constructor(
    renderer: WebGLRenderer,
    readonly field: SurfaceHeightfield,
    /** The tile group to capture, or null while there is none. */
    private readonly source: () => Object3D | null,
    /** The base ground, for the camera's depth range. */
    private readonly base: () => HeightSampler
  ) {
    this.core = new TopDownCapture(renderer, field.res, SURF_ENCODE_OFFSET, 'surface');
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
    if (this.disposed || !this.core.compiled) return;
    const f = this.field;
    if (f.processing) {
      if (f.step(budgetMs)) this.timings.processMs = f.lastProcessMs;
      return;
    }
    if (!shouldRecapture({
      nowMs, lastCaptureMs: this.lastCaptureMs, hasCapture: f.hasCapture, busy: this.core.inFlight,
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
    const t0 = performance.now();
    const half = this.field.extentM / 2;
    const { lo, hi } = baseRange(this.base(), cx, cz, half);
    this.core.render(group, cx, cz, half, hi + CAMERA_HEADROOM_M, lo - TOPDOWN_FLOOR_MARGIN_M);
    const t1 = performance.now();
    this.timings.renderMs = t1 - t0;
    this.timings.captures++;
    const gen = this.generation;
    this.core.readback(this.field.readBuffer, () => {
      if (this.disposed || gen !== this.generation) return;
      this.timings.readbackMs = performance.now() - t1;
      this.field.beginProcess(cx, cz);
    }, () => {
      // the target was swapped for an RGBA one: capture again at the next allowed moment
      if (!this.disposed && gen === this.generation) this.lastCaptureMs = -Infinity;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.core.dispose();
  }
}

/**
 * Min and max of the base ground over the window, on a 24 m lattice (the
 * base is a smoothed 10 m field, and the camera range has tens of metres of
 * margin either way): ~1k samples rather than the whole 315k-node field.
 */
const _range = { lo: 0, hi: 0 };
export function baseRange(hf: HeightSampler, cx: number, cz: number, half: number): { lo: number; hi: number } {
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
