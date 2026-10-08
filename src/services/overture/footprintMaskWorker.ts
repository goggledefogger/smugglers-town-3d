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
import {
  applyHeightChunk, chunkAt, createHeightField, heightAt,
  type HeightChunkStats, type HeightField, type HeightState, type HeightTerrain
} from './heightField.ts';

export interface FootprintMaskJob extends CutoutJob {
  readonly id: number;
}

/**
 * The height field rides the same worker (it will feed the stencil build in stage 2). Messages without a
 * `kind` are stencil jobs, as before.
 */
export type HeightMessage =
  /** once per tileset: the 10 m terrain the rise is measured from; starts a fresh, all-unknown field */
  | { readonly kind: 'terrain'; readonly terrain: HeightTerrain }
  /** one measured 900 m chunk (transferred); NaN texels are unknown */
  | { readonly kind: 'heights'; readonly chunk: number; readonly data: Float32Array; readonly keepRiseM: number }
  /** debug: what the field says at world (x, z) */
  | { readonly kind: 'heightAt'; readonly req: number; readonly x: number; readonly z: number };

export type HeightReply =
  | ({ readonly kind: 'heightsApplied'; readonly chunk: number } & HeightChunkStats)
  /** a heights or terrain message threw (a bad chunk size, say): the field is as it was; this is not a stencil job */
  | { readonly kind: 'heightsError'; readonly message: string }
  | { readonly kind: 'heightAtResult'; readonly req: number; readonly rise: number; readonly state: HeightState; readonly chunk: number };

export type FootprintMaskResult =
  | { readonly id: number; readonly build: CutoutBuild; /** worker-side build time (ms) */ readonly buildMs: number; readonly error?: undefined; readonly kind?: undefined }
  | { readonly id: number; readonly error: string; readonly kind?: undefined };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<FootprintMaskJob | HeightMessage>) => void) | null;
  postMessage: (msg: FootprintMaskResult | HeightReply, transfer?: Transferable[]) => void;
};

const builder = new CutoutStencilBuilder();
let heightField: HeightField | null = null;
let heightTerrain: HeightTerrain | null = null;

ctx.onmessage = e => {
  const m = e.data;
  if ('kind' in m) {
    try {
      if (m.kind === 'terrain') {
        heightTerrain = m.terrain;
        heightField = createHeightField();
      } else if (m.kind === 'heights') {
        if (!heightField || !heightTerrain) return;
        const stats = applyHeightChunk(heightField, m.chunk, m.data, heightTerrain, m.keepRiseM);
        ctx.postMessage({ kind: 'heightsApplied', chunk: m.chunk, ...stats });
      } else if (heightField) {
        ctx.postMessage({ kind: 'heightAtResult', req: m.req, ...heightAt(heightField, m.x, m.z) });
      } else {
        ctx.postMessage({ kind: 'heightAtResult', req: m.req, rise: NaN, state: 'never', chunk: chunkAt(m.x, m.z) });
      }
    } catch (err) {
      ctx.postMessage({ kind: 'heightsError', message: String(err) });
    }
    return;
  }
  const t0 = performance.now();
  try {
    const build = builder.build(m);
    ctx.postMessage({ id: m.id, build, buildMs: performance.now() - t0 }, build.changed ? [build.mask.data.buffer, build.segments.buffer] : []);
  } catch (err) {
    ctx.postMessage({ id: m.id, error: String(err) });
  }
};
