/**
 * Cutout height field producer (stage 1). Measures the loaded photogrammetry top-down in 900 m chunks and hands
 * each finished chunk to a callback (main posts it, transferred, to the cutout worker, which folds it into the
 * persistent byte field: services/overture/heightField.ts).
 *
 * Lattice: a fixed 4x4 of 900 m chunks over the 3600 m stencil square starting at x,z = -1800, 1 m texels, so one
 * 900x900 R32F target (TopDownCapture, shared with True Surface). Chunk index = cj * 4 + ci, ci along x.
 *
 * Unknown texels: the target is cleared to 0 and the shader adds HEIGHT_ENCODE_OFFSET to world Y, so a texel no
 * tile drew stays <= 0. The delivered Float32Array is decoded back to world Y with NaN where nothing drew. NaN is
 * the one unknown sentinel on the wire. Tiles coarser than RASTER_MAX_ERROR_M are hidden for the render so their
 * texels are NaN too (the stencil's classifier already ignores them; far buildings keep the 10 m rule).
 *
 * Schedule, never per frame: the tile streamer widens `dirtyRect` on every add/remove/refine; a chunk under it is
 * dirty, and is captured only once no tile in it changed for SETTLE_MS. `update` submits at most one chunk per
 * frame with one readback in flight, and only while `active` (the view cuts to footprints).
 */
import { Box3, type Group, type Object3D, type WebGLRenderer } from 'three';
import type { HeightSampler } from '../core/heightfield.ts';
import { TopDownCapture, TOPDOWN_FLOOR_MARGIN_M } from './TopDownCapture.ts';
import { baseRange } from './SurfaceCapture.ts';
import { HEIGHT_CHUNKS, HEIGHT_CHUNK_M, HEIGHT_ORIGIN } from '../services/overture/heightField.ts';

/** Tiles with a geometric error above this are hidden for the capture (Tileset.ts RASTER_MAX_ERROR_M). */
export const HEIGHT_MAX_ERROR_M = 8;
/** Quiet time (ms) a dirty chunk needs, since the last tile change in it, before it is captured. */
export const HEIGHT_SETTLE_MS = 1000;
/** Added to world Y in the shader so that the clear value 0 means "no tile drew". */
export const HEIGHT_ENCODE_OFFSET = 1024;
const CAMERA_HEADROOM_M = 600;

/** What the capture needs of the tile streamer (TileStreamer satisfies it). */
export interface HeightSource {
  readonly group: Group;
  forEachTile(cb: (group: Group, geometricError: number) => void): void;
  takeDirtyRect(): { minX: number; maxX: number; minZ: number; maxZ: number } | null;
}

export interface HeightTimings {
  /** CPU ms to submit the last chunk render */
  renderMs: number;
  /** ms from submit until the last readback resolved */
  readbackMs: number;
  /** chunks captured so far */
  captured: number;
}

const _box = new Box3();

export class HeightCapture {
  private readonly core: TopDownCapture;
  private readonly changedAt = new Float64Array(HEIGHT_CHUNKS * HEIGHT_CHUNKS).fill(-Infinity);
  private readonly dirty = new Uint8Array(HEIGHT_CHUNKS * HEIGHT_CHUNKS);
  /** chunks delivered at least once */
  private readonly delivered = new Uint8Array(HEIGHT_CHUNKS * HEIGHT_CHUNKS);
  private allPending = true;
  private generation = 0;
  private disposed = false;
  readonly timings: HeightTimings = { renderMs: 0, readbackMs: 0, captured: 0 };

  constructor(
    renderer: WebGLRenderer,
    private readonly source: () => HeightSource | null,
    /** The base ground, for the camera's depth range. */
    private readonly base: () => HeightSampler,
    /** A finished chunk: world Y per texel, NaN unknown. The array is the callee's to keep or transfer. */
    private readonly onChunk: (chunk: number, worldY: Float32Array) => void
  ) {
    this.core = new TopDownCapture(renderer, HEIGHT_CHUNK_M, HEIGHT_ENCODE_OFFSET, 'height');
  }

  /** How many chunks have been delivered at least once. */
  get chunksDelivered(): number {
    let n = 0;
    for (const d of this.delivered) n += d;
    return n;
  }

  /** A new tileset or world: everything measured so far is void, and the next active update re-measures. */
  reset(): void {
    this.generation++;
    this.changedAt.fill(-Infinity);
    this.dirty.fill(0);
    this.delivered.fill(0);
    this.allPending = true;
  }

  /** Mark every chunk dirty at `nowMs` (the settle clock starts now). */
  markAllDirty(nowMs: number): void {
    this.dirty.fill(1);
    this.changedAt.fill(nowMs);
    this.allPending = false;
  }

  /** Call every frame. `active`: the view cuts to footprints. Submits at most one chunk. */
  update(nowMs: number, active: boolean): void {
    if (this.disposed || !active || !this.core.compiled) return;
    const src = this.source();
    if (!src) return;
    if (this.allPending) this.markAllDirty(nowMs);
    const r = src.takeDirtyRect();
    if (r) this.markRect(r, nowMs);
    if (this.core.inFlight) return;
    let pick = -1;
    for (let c = 0; c < this.dirty.length; c++) {
      if (!this.dirty[c] || nowMs - this.changedAt[c]! < HEIGHT_SETTLE_MS) continue;
      if (pick < 0 || this.changedAt[c]! < this.changedAt[pick]!) pick = c;
    }
    if (pick < 0) return;
    this.dirty[pick] = 0;
    if (!this.holdsFineTile(src, pick)) return;
    this.capture(src, pick);
  }

  private markRect(r: { minX: number; maxX: number; minZ: number; maxZ: number }, nowMs: number): void {
    const m = HEIGHT_CHUNK_M, n = HEIGHT_CHUNKS;
    const lo = (v: number): number => Math.max(0, Math.floor((v - HEIGHT_ORIGIN) / m));
    const hi = (v: number): number => Math.min(n - 1, Math.floor((v - HEIGHT_ORIGIN) / m));
    for (let cj = lo(r.minZ); cj <= hi(r.maxZ); cj++) {
      for (let ci = lo(r.minX); ci <= hi(r.maxX); ci++) {
        this.dirty[cj * n + ci] = 1;
        this.changedAt[cj * n + ci] = nowMs;
      }
    }
  }

  private holdsFineTile(src: HeightSource, chunk: number): boolean {
    const m = HEIGHT_CHUNK_M;
    const x0 = HEIGHT_ORIGIN + (chunk % HEIGHT_CHUNKS) * m, z0 = HEIGHT_ORIGIN + Math.floor(chunk / HEIGHT_CHUNKS) * m;
    let found = false;
    src.forEachTile((g, err) => {
      if (found || err > HEIGHT_MAX_ERROR_M) return;
      const b = _box.setFromObject(g);
      if (!b.isEmpty() && b.max.x > x0 && b.min.x < x0 + m && b.max.z > z0 && b.min.z < z0 + m) found = true;
    });
    return found;
  }

  private capture(src: HeightSource, chunk: number): void {
    const m = HEIGHT_CHUNK_M, half = m / 2;
    const cx = HEIGHT_ORIGIN + (chunk % HEIGHT_CHUNKS) * m + half;
    const cz = HEIGHT_ORIGIN + Math.floor(chunk / HEIGHT_CHUNKS) * m + half;
    const t0 = performance.now();
    const { lo, hi } = baseRange(this.base(), cx, cz, half);
    const hidden: Object3D[] = [];
    src.forEachTile((g, err) => {
      if (err > HEIGHT_MAX_ERROR_M && g.visible) {
        g.visible = false;
        hidden.push(g);
      }
    });
    try {
      this.core.render(src.group, cx, cz, half, hi + CAMERA_HEADROOM_M, lo - TOPDOWN_FLOOR_MARGIN_M);
    } finally {
      for (const g of hidden) g.visible = true;
    }
    const t1 = performance.now();
    this.timings.renderMs = t1 - t0;
    const gen = this.generation;
    const data = new Float32Array(m * m);
    this.core.readback(data, () => {
      if (this.disposed || gen !== this.generation) return;
      this.timings.readbackMs = performance.now() - t1;
      this.timings.captured++;
      // decode in place: 0 (cleared, no tile drew) -> NaN, else world Y
      for (let k = 0; k < data.length; k++) {
        const v = data[k]!;
        data[k] = v > 0 ? v - HEIGHT_ENCODE_OFFSET : NaN;
      }
      this.delivered[chunk] = 1;
      this.onChunk(chunk, data);
    }, () => {
      // the target was swapped for an RGBA one: this chunk again, now
      if (this.disposed || gen !== this.generation) return;
      this.dirty[chunk] = 1;
      this.changedAt[chunk] = -Infinity;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.core.dispose();
  }
}
