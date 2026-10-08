/**
 * Cutout 3D collision from the stencil itself: the R channel of the
 * finished mask traced into wall segments, so what the car hits is exactly
 * the outline the shader cuts to (the one-source principle). Marching
 * squares on the texel centres with the iso line halfway between them,
 * which is where the linear-filtered R reads 0.5, the shader's cut, so a
 * 45 degree staircase traces as one diagonal rather than 1 m steps. Each
 * closed contour is simplified with Douglas-Peucker so a straight wall is
 * one segment. Pure data; runs in the stencil worker.
 */
import type { FootprintMask } from './footprintMask.ts';

/** Floats per traced segment: ax, az, bx, bz, cap (G byte, 255 = no cap / full height), source (SEG_SRC_*). */
export const SEG_STRIDE = 6;
/** Segment source unknown (no Overture raster given). */
export const SEG_SRC_UNKNOWN = 0;
/** The solid behind the segment is Overture (a footprint or its dilation band). */
export const SEG_SRC_OVERTURE = 1;
/** The solid behind the segment is a classifier gap cell (no Overture there). */
export const SEG_SRC_GAP = 2;

/**
 * Segments around every filled region of the mask, oriented with the solid
 * on the left walking a to b, so the outward normal is (dz, -dx) / len.
 * Holes (courtyards) trace too, their walls facing into the hole. `cap` is
 * the highest G byte of the solid texels along the segment (255 for an R8
 * mask). `overture`, the Overture-only raster the stencil started from,
 * tells each segment's source: the solid just behind its midpoint is in it
 * (SEG_SRC_OVERTURE) or not (SEG_SRC_GAP). Returns a flat Float32Array,
 * SEG_STRIDE per segment.
 */
export function traceStencil(m: FootprintMask, toleranceM = 0.5, overture: FootprintMask | null = null): Float32Array {
  const { n, cell, channels: ch, data } = m;
  const x0 = m.cx - m.size / 2, z0 = m.cz - m.size / 2;
  // crossing ids: the horizontal edge from corner (i,j) to (i+1,j) is 2k, the vertical edge
  // from (i,j) to (i,j+1) is 2k+1, k = j * n + i (corners = texel centres). The links live in
  // an open-addressing hash of typed arrays: a city has a million or more crossings, and a
  // Map of them cost most of a second
  const h = new CrossingHash(1 << 20);
  const ids = [0, 0, 0, 0], ins = [false, false, false, false], caps = [0, 0, 0, 0];
  for (let j = 0; j + 1 < n; j++) {
    for (let i = 0; i + 1 < n; i++) {
      const k = j * n + i;
      // corners counter-clockwise in x,z: (i,j) (i+1,j) (i+1,j+1) (i,j+1)
      const a = data[k * ch] !== 0, b = data[(k + 1) * ch] !== 0;
      const c = data[(k + n + 1) * ch] !== 0, d = data[(k + n) * ch] !== 0;
      if (a === b && b === c && c === d) continue;
      ins[0] = a; ins[1] = b; ins[2] = c; ins[3] = d;
      // the edge leaving corner q counter-clockwise
      ids[0] = 2 * k; ids[1] = 2 * (k + 1) + 1; ids[2] = 2 * (k + n); ids[3] = 2 * k + 1;
      if (ch === 2) {
        caps[0] = a ? data[k * 2 + 1]! : 0; caps[1] = b ? data[(k + 1) * 2 + 1]! : 0;
        caps[2] = c ? data[(k + n + 1) * 2 + 1]! : 0; caps[3] = d ? data[(k + n) * 2 + 1]! : 0;
      } else {
        caps[0] = caps[1] = caps[2] = caps[3] = 255;
      }
      // walking the cell boundary counter-clockwise, an exit (solid to empty) joins the next
      // entry (empty to solid) with the solid on its left; saddles join (8-connected solid)
      for (let q = 0; q < 4; q++) {
        if (!(ins[q] && !ins[(q + 1) & 3])) continue;
        for (let r = 1; r < 4; r++) {
          const e = (q + r) & 3;
          if (!ins[e] && ins[(e + 1) & 3]) {
            const cp = Math.max(caps[q]!, caps[(e + 1) & 3]!);
            h.link(ids[q]!, ids[e]!, cp);
            h.link(ids[e]!, -1, cp);
            break;
          }
        }
      }
    }
  }
  const out: number[] = [];
  const xs: number[] = [], zs: number[] = [], cs: number[] = [];
  const keep: boolean[] = [];
  const { keys, next, cap, used } = h;
  for (let s0 = 0; s0 < keys.length; s0++) {
    if (keys[s0] === -1 || used[s0] || next[s0] === -1) continue;
    xs.length = zs.length = cs.length = 0;
    let slot = s0;
    while (slot >= 0 && !used[slot]) {
      used[slot] = 1;
      const id = keys[slot]!, kk = id >> 1, odd = id & 1;
      xs.push(x0 + ((kk % n) + 0.5 + (odd ? 0 : 0.5)) * cell);
      zs.push(z0 + (Math.floor(kk / n) + 0.5 + (odd ? 0.5 : 0)) * cell);
      cs.push(cap[slot]!);
      slot = next[slot] === -1 ? -1 : h.find(next[slot]!);
    }
    const m2 = xs.length;
    if (m2 < 3) continue;
    // Douglas-Peucker on the closed ring, from a hull vertex (the point farthest from an
    // arbitrary one, so a true corner, never mid-wall) split at the point farthest from it
    let start = 0, best = -1;
    for (let k = 1; k < m2; k++) {
      const dd = (xs[k]! - xs[0]!) ** 2 + (zs[k]! - zs[0]!) ** 2;
      if (dd > best) { best = dd; start = k; }
    }
    if (start > 0) {
      rotate(xs, start); rotate(zs, start); rotate(cs, start);
    }
    let far = 0;
    best = -1;
    for (let k = 1; k < m2; k++) {
      const dd = (xs[k]! - xs[0]!) ** 2 + (zs[k]! - zs[0]!) ** 2;
      if (dd > best) { best = dd; far = k; }
    }
    keep.length = m2;
    keep.fill(false);
    keep[0] = keep[far] = true;
    simplify(xs, zs, 0, far, toleranceM, keep);
    simplify(xs, zs, far, m2, toleranceM, keep);
    let prev = 0;
    for (let k = 1; k <= m2; k++) {
      const kk = k % m2;
      if (!keep[kk]) continue;
      let c = cs[kk]!;
      for (let t = prev; t !== kk; t = (t + 1) % m2) if (cs[t]! > c) c = cs[t]!;
      let src = SEG_SRC_UNKNOWN;
      if (overture) {
        // a texel behind the midpoint, on the solid (left) side
        const dx = xs[kk]! - xs[prev]!, dz = zs[kk]! - zs[prev]!, l = Math.hypot(dx, dz) || 1;
        const sx = (xs[prev]! + xs[kk]!) / 2 - (dz / l) * 0.75 * cell, sz = (zs[prev]! + zs[kk]!) / 2 + (dx / l) * 0.75 * cell;
        const oi = Math.floor((sx - (overture.cx - overture.size / 2)) / overture.cell);
        const oj = Math.floor((sz - (overture.cz - overture.size / 2)) / overture.cell);
        const inO = oi >= 0 && oj >= 0 && oi < overture.n && oj < overture.n
          && overture.data[(oj * overture.n + oi) * overture.channels] !== 0;
        src = inO ? SEG_SRC_OVERTURE : SEG_SRC_GAP;
      }
      out.push(xs[prev]!, zs[prev]!, xs[kk]!, zs[kk]!, c, src);
      prev = kk;
    }
  }
  return Float32Array.from(out);
}

/**
 * Crossing id -> next crossing id and the highest cap seen at it, open
 * addressing with linear probing, grown at half load. `next` -1 = not yet
 * known (the cell that starts a segment there has not been visited).
 */
class CrossingHash {
  keys: Int32Array;
  next: Int32Array;
  cap: Uint8Array;
  used: Uint8Array;
  private count = 0;

  constructor(size: number) {
    this.keys = new Int32Array(size).fill(-1);
    this.next = new Int32Array(size).fill(-1);
    this.cap = new Uint8Array(size);
    this.used = new Uint8Array(size);
  }

  private slotOf(id: number): number {
    const mask = this.keys.length - 1;
    let s = Math.imul(id, 0x9e3779b1) >>> 0 & mask;
    while (this.keys[s] !== -1 && this.keys[s] !== id) s = (s + 1) & mask;
    return s;
  }

  find(id: number): number {
    const s = this.slotOf(id);
    return this.keys[s] === id ? s : -1;
  }

  link(id: number, to: number, c: number): void {
    let s = this.slotOf(id);
    if (this.keys[s] === -1) {
      if ((this.count + 1) * 2 > this.keys.length) {
        this.grow();
        s = this.slotOf(id);
      }
      this.keys[s] = id;
      this.count++;
    }
    if (to !== -1) this.next[s] = to;
    if (this.cap[s]! < c) this.cap[s] = c;
  }

  private grow(): void {
    const { keys, next, cap } = this;
    const size = keys.length * 2;
    this.keys = new Int32Array(size).fill(-1);
    this.next = new Int32Array(size).fill(-1);
    this.cap = new Uint8Array(size);
    this.used = new Uint8Array(size);
    for (let s = 0; s < keys.length; s++) {
      if (keys[s] === -1) continue;
      const t = this.slotOf(keys[s]!);
      this.keys[t] = keys[s]!;
      this.next[t] = next[s]!;
      this.cap[t] = cap[s]!;
    }
  }
}

/** Rotate an array left by k in place. */
function rotate(a: number[], k: number): void {
  const head = a.splice(0, k);
  a.push(...head);
}

/** Keep the points of a..b (b may equal the ring length, meaning point 0) farther than tol from the chord. */
function simplify(xs: number[], zs: number[], a: number, b: number, tol: number, keep: boolean[]): void {
  const m = xs.length;
  const stack = [a, b];
  while (stack.length) {
    const hi = stack.pop()!, lo = stack.pop()!;
    if (hi - lo < 2) continue;
    const ax = xs[lo]!, az = zs[lo]!, bx = xs[hi % m]!, bz = zs[hi % m]!;
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    let worst = -1, at = -1;
    for (let k = lo + 1; k < hi; k++) {
      const d = len > 1e-9
        ? Math.abs((xs[k]! - ax) * dz - (zs[k]! - az) * dx) / len
        : Math.hypot(xs[k]! - ax, zs[k]! - az);
      if (d > worst) { worst = d; at = k; }
    }
    if (worst > tol) {
      keep[at] = true;
      stack.push(lo, at, at, hi);
    }
  }
}
