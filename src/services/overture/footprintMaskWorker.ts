/**
 * Builds the Cutout 3D stencil off the main thread. The game loop pays a
 * pack of the footprints into typed arrays (transferred, not cloned) and
 * gets the finished mask's buffer back the same way; the raster and the
 * dilation (about 100 ms for downtown SF at 1 m) never touch a frame.
 * Its own worker, not the collider worker's: that one reassigns onmessage
 * per collider job, so a second job kind there would race it.
 */
import { footprintMaskPacked, type PackedFootprints, type FootprintMaskOptions, type FootprintMask } from './footprintMask.ts';

export interface FootprintMaskJob {
  readonly id: number;
  readonly packed: PackedFootprints;
  readonly opts: FootprintMaskOptions;
}

export interface FootprintMaskResult {
  readonly id: number;
  readonly mask: FootprintMask;
  /** worker-side build time (ms) */
  readonly buildMs: number;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<FootprintMaskJob>) => void) | null;
  postMessage: (msg: FootprintMaskResult, transfer: Transferable[]) => void;
};

ctx.onmessage = e => {
  const t0 = performance.now();
  const mask = footprintMaskPacked(e.data.packed, e.data.opts);
  ctx.postMessage({ id: e.data.id, mask, buildMs: performance.now() - t0 }, [mask.data.buffer]);
};
