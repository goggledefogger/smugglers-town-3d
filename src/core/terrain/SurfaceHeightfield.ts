/**
 * True Surface: a ~1 m top-surface heightfield captured from the GPU
 * (`render/SurfaceCapture.ts`) and composited over the 10 m base ground, so
 * the wheels ride kerbs, cambers, humps and ramps the player can see.
 *
 * The capture is stored as a *delta* from the base ground, not as heights:
 * `sample(x, z) = base(x, z) + delta(x, z)`. Every rejection (outside the
 * window, a texel nothing was drawn into, a value outside the band) is a delta
 * of 0, so the composite is continuous: a wall cell does not cliff from 1.4 m
 * of accepted kerb down to the base, it blurs to it. On constant inputs this is
 * exactly the rule "captured value inside the band, base outside it".
 *
 * The band (`SURF_BAND_UP_M` above the base, `SURF_BAND_DOWN_M` below) is
 * what keeps walls, canopies, rooftops and parked cars from becoming ground: a
 * facade texel is tens of metres above the base and is rejected, so the box colliders still do their job and
 * this field never creates a wall. On OSM road cells the delta is also capped
 * at `SURF_ROAD_CAP_M`, so a canopy or awning over a street is never a ramp.
 *
 * Processing (band, road cap, 3×3 box blur, edge fade) is amortised over
 * frames by `step(budgetMs)` into a second buffer and swapped in whole, so a
 * half-processed capture is never sampled. DOM-free and testable in node.
 */
import type { HeightSampler } from '../heightfield.ts';

/** Side of the captured square window, metres, centred on the player. */
export const SURF_EXTENT_M = 768;
/** Texels per side: 768 over 768 m is 1 m cells. */
export const SURF_RES = 768;
/**
 * Captured heights more than this above the base ground are not ground. Low
 * enough to reject melted parked cars (~1.5 m) and canopies, high enough for
 * kerbs, humps and ramps.
 */
export const SURF_BAND_UP_M = 0.6;
/** Captured heights more than this below the base ground are not ground (dips and cuts the 10 m grid smoothed over). */
export const SURF_BAND_DOWN_M = 1.5;
/** On road cells the surface never rises more than this above the base (canopy over streets). */
export const SURF_ROAD_CAP_M = 0.5;
/** Texels over which the delta fades to 0 at the window edge, so a recentre cannot step. */
export const SURF_EDGE_FADE = 16;
/** At most one capture per this many ms. */
export const SURF_RECAPTURE_MS = 1000;
/**
 * Added to world Y in the capture shader, so the render target's clear value
 * (0) can never be mistaken for a real surface (world Y here is >= 0: the
 * datum maps the lowest ground to ~0). Float32 near 1 km keeps ~0.1 mm.
 */
export const SURF_ENCODE_OFFSET = 1024;

/** True where (x, z) is an OSM road cell. */
export type RoadLookup = (x: number, z: number) => boolean;

export interface SurfaceOptions {
  readonly extentM?: number;
  readonly res?: number;
  readonly bandUpM?: number;
  readonly bandDownM?: number;
  readonly roadCapM?: number;
  /** Added to every captured height before comparing (the base sits this far above the tile mesh). */
  readonly liftM?: number;
  readonly edgeFade?: number;
  /** Clock for the processing budget; injectable for tests. */
  readonly now?: () => number;
}

export class SurfaceHeightfield implements HeightSampler {
  readonly extentM: number;
  readonly res: number;
  readonly cell: number;
  readonly bandUpM: number;
  readonly bandDownM: number;
  readonly roadCapM: number;
  readonly liftM: number;
  private readonly edgeFade: number;
  private readonly now: () => number;

  /** The capture writes encoded heights here (row r = z ascending, column i = x ascending). */
  readonly readBuffer: Float32Array;
  private active: Float32Array;
  private next: Float32Array;
  private readonly tmp: Float32Array;
  private readonly road: Uint8Array;

  private activeX0 = 0;
  private activeZ0 = 0;
  private hasActive = false;
  private pendX0 = 0;
  private pendZ0 = 0;
  /** -1 idle, 0 band pass, 1 horizontal blur, 2 vertical blur + fade + swap. */
  private phase = -1;
  private row = 0;
  /** Bumps on every swap, so a debug view knows when to redraw. */
  version = 0;
  /** Wall-clock ms the last capture spent being processed, summed over its slices. */
  lastProcessMs = 0;
  private processMs = 0;

  constructor(
    public base: HeightSampler,
    private roads: RoadLookup | null = null,
    opts: SurfaceOptions = {}
  ) {
    this.extentM = opts.extentM ?? SURF_EXTENT_M;
    this.res = opts.res ?? SURF_RES;
    this.cell = this.extentM / this.res;
    this.bandUpM = opts.bandUpM ?? SURF_BAND_UP_M;
    this.bandDownM = opts.bandDownM ?? SURF_BAND_DOWN_M;
    this.roadCapM = opts.roadCapM ?? SURF_ROAD_CAP_M;
    this.liftM = opts.liftM ?? 0;
    this.edgeFade = opts.edgeFade ?? SURF_EDGE_FADE;
    this.now = opts.now ?? (() => performance.now());
    const n = this.res * this.res;
    this.readBuffer = new Float32Array(n);
    this.active = new Float32Array(n);
    this.next = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.road = new Uint8Array(n);
  }

  get hasCapture(): boolean {
    return this.hasActive;
  }

  /** True while a capture is being processed; the next one must wait. */
  get processing(): boolean {
    return this.phase >= 0;
  }

  /** World centre of the window `sample` currently reads. */
  get centerX(): number {
    return this.activeX0 + this.extentM / 2;
  }

  get centerZ(): number {
    return this.activeZ0 + this.extentM / 2;
  }

  /** The live delta grid (res², row = z), for the debug view. Read only. */
  get activeDelta(): Float32Array {
    return this.active;
  }

  setRoads(roads: RoadLookup | null): void {
    this.roads = roads;
  }

  /** Drop the capture: sample returns the base until the next one lands. */
  clear(): void {
    this.hasActive = false;
    this.phase = -1;
  }

  /** `readBuffer` now holds a capture centred on (cx, cz): process it over the next frames. */
  beginProcess(cx: number, cz: number): void {
    this.pendX0 = cx - this.extentM / 2;
    this.pendZ0 = cz - this.extentM / 2;
    this.phase = 0;
    this.row = 0;
    this.processMs = 0;
  }

  /** Synchronous ingest (tests, sync fallback): copy, process to completion, swap. */
  ingest(cx: number, cz: number, encoded: Float32Array): void {
    this.readBuffer.set(encoded);
    this.beginProcess(cx, cz);
    this.step(Infinity);
  }

  /**
   * Advance processing by about `budgetMs`. Returns true on the call that
   * swaps the finished capture in.
   */
  step(budgetMs: number): boolean {
    if (this.phase < 0) return false;
    const t0 = this.now();
    const res = this.res;
    let rows = 0;
    while (this.phase >= 0) {
      if (this.phase === 0) this.bandRow(this.row);
      else if (this.phase === 1) this.blurRowH(this.row);
      else this.blurRowV(this.row);
      this.row++;
      if (this.row >= res) {
        this.row = 0;
        this.phase++;
        if (this.phase > 2) {
          this.phase = -1;
          this.swap();
          this.processMs += this.now() - t0;
          this.lastProcessMs = this.processMs;
          return true;
        }
      }
      // checking the clock every row costs more than the row; every 16 is ~0.1 ms
      if (++rows % 16 === 0 && this.now() - t0 >= budgetMs) break;
    }
    this.processMs += this.now() - t0;
    return false;
  }

  /** Base ground plus the captured delta inside the window. */
  sample(x: number, z: number): number {
    const g = this.base.sample(x, z);
    if (!this.hasActive) return g;
    return g + this.deltaAt(x, z);
  }

  /** Bilinear delta at world (x, z); 0 outside the window. */
  deltaAt(x: number, z: number): number {
    if (!this.hasActive) return 0;
    const res = this.res;
    const u = (x - this.activeX0) / this.cell - 0.5;
    const v = (z - this.activeZ0) / this.cell - 0.5;
    if (!(u >= 0 && v >= 0 && u <= res - 1 && v <= res - 1)) return 0;
    const i0 = Math.min(res - 2, Math.floor(u));
    const j0 = Math.min(res - 2, Math.floor(v));
    const tx = u - i0, tz = v - j0;
    const d = this.active;
    const k = j0 * res + i0;
    const a = d[k]! + (d[k + 1]! - d[k]!) * tx;
    const b = d[k + res]! + (d[k + res + 1]! - d[k + res]!) * tx;
    return a + (b - a) * tz;
  }

  private swap(): void {
    const t = this.active;
    this.active = this.next;
    this.next = t;
    this.activeX0 = this.pendX0;
    this.activeZ0 = this.pendZ0;
    this.hasActive = true;
    this.version++;
  }

  /** Decode, compare with the base, reject outside the band, cap on roads. Writes `next`. */
  private bandRow(r: number): void {
    const res = this.res, cell = this.cell;
    const z = this.pendZ0 + (r + 0.5) * cell;
    const raw = this.readBuffer, out = this.next, road = this.road;
    const up = this.bandUpM, down = this.bandDownM, cap = this.roadCapM;
    const shift = this.liftM - SURF_ENCODE_OFFSET;
    const roads = this.roads;
    for (let i = 0; i < res; i++) {
      const k = r * res + i;
      const v = raw[k]!;
      const x = this.pendX0 + (i + 0.5) * cell;
      const isRoad = roads !== null && roads(x, z);
      road[k] = isRoad ? 1 : 0;
      // the clear value is 0 and every real surface encodes to ~SURF_ENCODE_OFFSET
      if (!(v > 1)) { out[k] = 0; continue; }
      let d = v + shift - this.base.sample(x, z);
      if (d > up || d < -down) d = 0;
      else if (isRoad && d > cap) d = cap;
      out[k] = d;
    }
  }

  private blurRowH(r: number): void {
    const res = this.res, src = this.next, dst = this.tmp;
    const o = r * res;
    dst[o] = (src[o]! + src[o + 1]!) / 2;
    for (let i = 1; i < res - 1; i++) dst[o + i] = (src[o + i - 1]! + src[o + i]! + src[o + i + 1]!) / 3;
    dst[o + res - 1] = (src[o + res - 2]! + src[o + res - 1]!) / 2;
  }

  /** Vertical half of the 3×3 box, then the road cap again (the blur can lift a road texel past it) and the edge fade. */
  private blurRowV(r: number): void {
    const res = this.res, src = this.tmp, dst = this.next, road = this.road;
    const up = r > 0 ? r - 1 : r, dn = r < res - 1 ? r + 1 : r;
    const count = (up === r || dn === r) ? 2 : 3;
    const cap = this.roadCapM, fade = this.edgeFade;
    const fr = Math.min(r, res - 1 - r);
    for (let i = 0; i < res; i++) {
      const k = r * res + i;
      let d = (up === r ? 0 : src[up * res + i]!) + src[k]! + (dn === r ? 0 : src[dn * res + i]!);
      d /= count;
      if (road[k] && d > cap) d = cap;
      const e = Math.min(fr, i, res - 1 - i);
      if (e < fade) d *= e / fade;
      dst[k] = d;
    }
  }
}

export interface RecaptureState {
  readonly nowMs: number;
  readonly lastCaptureMs: number;
  readonly hasCapture: boolean;
  /** A capture is rendering, reading back or processing. */
  readonly busy: boolean;
  readonly centerX: number;
  readonly centerZ: number;
  readonly playerX: number;
  readonly playerZ: number;
  readonly extentM: number;
  /** The loaded tile set or the base ground changed since the last capture. */
  readonly dirty: boolean;
}

/**
 * Whether to start a capture now: never while one is busy or within
 * `SURF_RECAPTURE_MS` of the last, always when there is none, otherwise when
 * the player is more than a quarter of the window from its centre or the
 * world under it changed.
 */
export function shouldRecapture(s: RecaptureState): boolean {
  if (s.busy) return false;
  if (s.nowMs - s.lastCaptureMs < SURF_RECAPTURE_MS) return false;
  if (!s.hasCapture) return true;
  if (Math.hypot(s.playerX - s.centerX, s.playerZ - s.centerZ) > s.extentM / 4) return true;
  return s.dirty;
}
