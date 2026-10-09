import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh } from 'three';

// The capture's GPU half is replaced: a readback finishes when the test says so.
const gpu = vi.hoisted(() => ({ done: [] as Array<() => void> }));
vi.mock('../src/render/TopDownCapture.ts', () => ({
  TOPDOWN_FLOOR_MARGIN_M: 0,
  TopDownCapture: class {
    compiled = true;
    inFlight = false;
    render(): void {}
    readback(_dst: Float32Array, onDone: () => void): void {
      this.inFlight = true;
      gpu.done.push(() => { this.inFlight = false; onDone(); });
    }
    dispose(): void {}
  }
}));

import { HeightCapture, HEIGHT_SETTLE_MS, type HeightSource } from '../src/render/HeightCapture.ts';
import { RemeasureTracker } from '../src/services/overture/remeasureTracker.ts';
import { HEIGHT_CHUNK_M, HEIGHT_ORIGIN } from '../src/services/overture/heightField.ts';

function tileOver(c: number): Mesh {
  const m = new Mesh(new BoxGeometry(HEIGHT_CHUNK_M - 2, 10, HEIGHT_CHUNK_M - 2));
  m.position.set(HEIGHT_ORIGIN + (c % 4) * HEIGHT_CHUNK_M + HEIGHT_CHUNK_M / 2, 0, HEIGHT_ORIGIN + Math.floor(c / 4) * HEIGHT_CHUNK_M + HEIGHT_CHUNK_M / 2);
  m.updateMatrixWorld(true);
  return m;
}

/** main.ts in miniature: updateHeights runs first in a frame, a refinement lands after it, the worker answers in order. */
function rig(chunksWithTiles: number[]) {
  const tiles = new Map(chunksWithTiles.map(c => [c, tileOver(c)]));
  const src: HeightSource = {
    group: new Group(), trackDirty: false, takeDirtyRect: () => null,
    forEachTile: cb => { for (const m of tiles.values()) cb(m as unknown as Group, 1); }
  };
  const tracker = new RemeasureTracker();
  const inWorker: number[] = [];
  const r = { drains: 0, refined: false, t: 0 };
  const cap = new HeightCapture({} as never, () => src, () => ({ sample: () => 0 }) as never,
    chunk => { tracker.posted(chunk); inWorker.push(chunk); },
    chunk => { if (tracker.skipped(chunk)) r.drains++; });
  gpu.done.length = 0;
  return {
    tiles, tracker, r, inWorker,
    /** a frame: updateHeights (the flagged refinement posts terrainUpdate, begin, reset), then maybe the ground lands */
    frame(lands = false): void {
      r.t += 16;
      if (r.refined) { r.refined = false; tracker.begin(); cap.reset(); }
      cap.update(r.t, true);
      if (lands) r.refined = true;
    },
    quiet(): void { r.t += HEIGHT_SETTLE_MS + 1; },
    readback(): void { gpu.done.shift()?.(); },
    reply(): void { const c = inWorker.shift(); if (c !== undefined && tracker.applied(c)) r.drains++; },
    /** capture every due chunk, one per frame, replying as the worker would */
    drive(): void {
      for (let i = 0; i < 40; i++) { this.frame(); this.readback(); this.reply(); this.quiet(); }
    }
  };
}

describe('refinement lands in the same frame as updateHeights (main.ts order)', () => {
  it('drains once after every seen chunk is re-measured', () => {
    const g = rig([0, 1, 5, 6]);
    g.drive();
    expect(g.tracker.pendingCount).toBe(0);
    expect(g.r.drains).toBe(0);
    g.frame(true);          // frame N: the ground lands after updateHeights
    g.drive();              // frame N+1 on: terrainUpdate + reset, mark all, settle, one chunk per update
    expect(g.tracker.pendingCount).toBe(0);
    expect(g.r.drains).toBe(1);
    g.frame(true); g.drive();   // a second refinement drains again
    expect(g.r.drains).toBe(2);
  });

  it('a readback finishing between the landing and the next updateHeights is measured on old ground: not counted', () => {
    const g = rig([0, 1]);
    g.drive();
    g.frame(); g.quiet(); g.frame();         // a capture of chunk 0 is submitted and in flight
    // the ground lands in this frame; begin() comes with the next updateHeights, after the old readback finished
    g.frame(true);
    g.readback(); g.reply();                 // delivered before begin: posted pre-begin, reply is stale
    g.drive();
    expect(g.tracker.pendingCount).toBe(0);
    expect(g.r.drains).toBe(1);
  });

  it('a chunk that lost its fine tiles after it was seen is dropped, and the drop drains the set', () => {
    const g = rig([0, 1, 5]);
    g.drive();
    g.tiles.delete(5);                       // the car drove away: its detail tiles unloaded
    g.frame(true);
    g.drive();
    expect(g.tracker.pendingCount).toBe(0);
    expect(g.r.drains).toBe(1);              // once: by whichever of the skip or the last reply came last
  });

  it('a skip of the only owed chunk drains at the skip', () => {
    const g = rig([2]);
    g.drive();
    g.tiles.delete(2);
    g.frame(true);
    g.frame(); g.quiet();                   // markAll, settled: every chunk due, one per frame
    for (let i = 0; i < 16; i++) g.frame();  // chunk 2 has no tile: turned away
    expect(g.r.drains).toBe(1);
    expect(g.tracker.pendingCount).toBe(0);
  });
});

describe('RemeasureTracker.skipped', () => {
  it('drops an owed chunk, drains on the last, and ignores a chunk not owed', () => {
    const t = new RemeasureTracker();
    t.posted(1); t.applied(1); t.posted(2); t.applied(2);
    t.begin();
    expect(t.skipped(9)).toBe(false);
    expect(t.skipped(1)).toBe(false);
    expect(t.pendingCount).toBe(1);
    expect(t.skipped(1)).toBe(false);        // already gone
    t.posted(2);
    expect(t.skipped(2)).toBe(true);         // dropped by the skip, so the reply that follows drains nothing
    expect(t.applied(2)).toBe(false);
  });
  it('is quiet with no refinement', () => {
    const t = new RemeasureTracker();
    t.posted(1);
    expect(t.skipped(1)).toBe(false);
  });
});
