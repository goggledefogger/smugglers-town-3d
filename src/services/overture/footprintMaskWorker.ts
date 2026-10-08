/**
 * Builds the Cutout 3D stencil off the main thread. The game loop sends the
 * footprints once per set (packed into typed arrays and transferred, not
 * cloned) and then only a copy of the classifier grid per rebuild; the
 * worker keeps the dilated Overture raster, so a classifier update costs
 * the gap scan and a copy, and the Overture raster (about 100 ms for
 * downtown SF at 1 m) runs once per set. The finished mask's buffer comes
 * back transferred; an unchanged result sends no mask at all.
 * Its own worker, not the collider worker's: that one reassigns onmessage
 * per collider job, so a second job kind there would race it.
 */
import { CutoutStencilBuilder, type CutoutJob, type CutoutBuild } from './footprintMask.ts';

export interface FootprintMaskJob extends CutoutJob {
  readonly id: number;
}

export type FootprintMaskResult =
  | { readonly id: number; readonly build: CutoutBuild; /** worker-side build time (ms) */ readonly buildMs: number; readonly error?: undefined }
  | { readonly id: number; readonly error: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<FootprintMaskJob>) => void) | null;
  postMessage: (msg: FootprintMaskResult, transfer?: Transferable[]) => void;
};

const builder = new CutoutStencilBuilder();

ctx.onmessage = e => {
  const t0 = performance.now();
  try {
    const build = builder.build(e.data);
    ctx.postMessage({ id: e.data.id, build, buildMs: performance.now() - t0 }, build.changed ? [build.mask.data.buffer] : []);
  } catch (err) {
    ctx.postMessage({ id: e.data.id, error: String(err) });
  }
};
