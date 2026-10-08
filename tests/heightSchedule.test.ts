import { describe, it, expect } from 'vitest';
import { ChunkSchedule, pickChunk } from '../src/render/heightSchedule.ts';
import { HEIGHT_CHUNKS } from '../src/services/overture/heightField.ts';

const SETTLE = 1000;
const N = HEIGHT_CHUNKS * HEIGHT_CHUNKS;

describe('height capture schedule', () => {
  it('waits for the 1 s settle since the last change in the chunk', () => {
    const s = new ChunkSchedule(SETTLE);
    s.markRect({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, 5000);
    expect(s.take(5999, false)).toBe(-1);
    // a later change in the same chunk restarts the clock
    s.markRect({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, 5900);
    expect(s.take(6500, false)).toBe(-1);
    expect(s.take(6900, false)).toBe(2 * HEIGHT_CHUNKS + 2);
  });

  it('hands out one chunk per call, the longest-waiting first', () => {
    const s = new ChunkSchedule(SETTLE);
    s.markRect({ minX: -1790, maxX: -1790, minZ: -1790, maxZ: -1790 }, 3000);
    s.markRect({ minX: 1790, maxX: 1790, minZ: 1790, maxZ: 1790 }, 1000);
    expect(s.take(9000, false)).toBe(N - 1);
    expect(s.take(9000, false)).toBe(0);
    expect(s.take(9000, false)).toBe(-1);
  });

  it('submits nothing while a readback is in flight, and keeps the chunk dirty', () => {
    const s = new ChunkSchedule(SETTLE);
    s.markAll(0);
    expect(s.take(5000, true)).toBe(-1);
    expect(s.dirty.every(d => d === 1)).toBe(true);
    expect(s.take(5000, false)).toBeGreaterThanOrEqual(0);
  });

  it('marks every chunk on the first update only', () => {
    const s = new ChunkSchedule(SETTLE);
    expect(s.allPending).toBe(true);
    s.markAll(100);
    expect(s.allPending).toBe(false);
    expect(s.take(1100, false)).toBe(0);
  });

  it('drops a stale chunk on reset: nothing is due and an old readback is not current', () => {
    const s = new ChunkSchedule(SETTLE);
    s.markAll(0);
    const gen = s.generation;
    expect(s.isCurrent(gen)).toBe(true);
    s.reset();
    expect(s.isCurrent(gen)).toBe(false);
    expect(s.take(9e6, false)).toBe(-1);
    expect(s.allPending).toBe(true);
  });

  it('requeues an abandoned chunk as due at once', () => {
    const s = new ChunkSchedule(SETTLE);
    s.requeue(7);
    expect(s.take(0, false)).toBe(7);
  });

  it('pickChunk is pure: the same arrays give the same answer', () => {
    const dirty = new Uint8Array(N), at = new Float64Array(N).fill(-Infinity);
    dirty[3] = 1; at[3] = 100;
    expect(pickChunk(dirty, at, 1100, false, SETTLE)).toBe(3);
    expect(pickChunk(dirty, at, 1099, false, SETTLE)).toBe(-1);
    expect(dirty[3]).toBe(1);
  });
});
