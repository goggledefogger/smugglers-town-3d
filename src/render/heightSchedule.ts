/**
 * When the Cutout height capture measures which chunk: the pure half of HeightCapture, so the schedule runs
 * (and is tested) without a renderer. A chunk is dirty once a tile changed under it; it is picked only after
 * `settleMs` of quiet since the last change, at most one per call, never while a readback is in flight, and the
 * longest-waiting one first. `reset` bumps the generation, so a readback submitted before it is stale.
 */
import { HEIGHT_CHUNKS, HEIGHT_CHUNK_M, HEIGHT_ORIGIN } from '../services/overture/heightField.ts';

export interface DirtyRect { minX: number; maxX: number; minZ: number; maxZ: number }

/**
 * The chunk to submit now, or -1: dirty, quiet for `settleMs`, oldest change first; -1 whenever a readback is
 * in flight.
 */
export function pickChunk(
  dirty: ArrayLike<number>, changedAt: ArrayLike<number>, nowMs: number, inFlight: boolean, settleMs: number
): number {
  if (inFlight) return -1;
  let pick = -1;
  for (let c = 0; c < dirty.length; c++) {
    if (!dirty[c] || nowMs - changedAt[c]! < settleMs) continue;
    if (pick < 0 || changedAt[c]! < changedAt[pick]!) pick = c;
  }
  return pick;
}

export class ChunkSchedule {
  readonly dirty = new Uint8Array(HEIGHT_CHUNKS * HEIGHT_CHUNKS);
  readonly changedAt = new Float64Array(HEIGHT_CHUNKS * HEIGHT_CHUNKS).fill(-Infinity);
  /** nothing has been marked yet: the first active update marks every chunk */
  allPending = true;
  generation = 0;

  constructor(private readonly settleMs: number) {}

  /** A new tileset or world: everything measured so far is void, and the next active update re-measures. */
  reset(): void {
    this.generation++;
    this.changedAt.fill(-Infinity);
    this.dirty.fill(0);
    this.allPending = true;
  }

  markAll(nowMs: number): void {
    this.dirty.fill(1);
    this.changedAt.fill(nowMs);
    this.allPending = false;
  }

  markRect(r: DirtyRect, nowMs: number): void {
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

  /** Pick the chunk to submit (clearing its dirty flag), or -1. */
  take(nowMs: number, inFlight: boolean): number {
    const c = pickChunk(this.dirty, this.changedAt, nowMs, inFlight, this.settleMs);
    if (c >= 0) this.dirty[c] = 0;
    return c;
  }

  /** Put a chunk back, due at once (its readback was abandoned for a retry). */
  requeue(chunk: number): void {
    this.dirty[chunk] = 1;
    this.changedAt[chunk] = -Infinity;
  }

  /** Whether a readback submitted at generation `gen` still belongs to this schedule. */
  isCurrent(gen: number): boolean {
    return gen === this.generation;
  }
}
