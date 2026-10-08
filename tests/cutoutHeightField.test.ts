import { describe, it, expect } from 'vitest';
import {
  createHeightField, applyHeightChunk, riseAt, heightAt, sampleTerrain,
  HEIGHT_N, HEIGHT_CHUNK_M, KEPT_BIT, RISE_UNKNOWN, type HeightTerrain
} from '../src/services/overture/heightField.ts';

const M = HEIGHT_CHUNK_M;
/** a flat terrain at height h over the whole square */
const flat = (h: number): HeightTerrain => ({ size: 3600, segs: 360, data: new Float32Array(361 * 361).fill(h) });
const chunkOf = (v: number): Float32Array => new Float32Array(M * M).fill(v);
const KEEP = 3;

describe('height field', () => {
  it('starts unknown everywhere', () => {
    const f = createHeightField();
    expect(f.data.length).toBe(HEIGHT_N * HEIGHT_N);
    expect(Number.isNaN(riseAt(f, 10, 10))).toBe(true);
    expect(heightAt(f, 0, 0).state).toBe('never');
  });

  it('quantises the rise to 0.5 m and caps it at 63 m', () => {
    const f = createHeightField();
    const w = chunkOf(0);
    w[0] = 2.2; w[1] = 2.3; w[2] = 100; w[3] = -4;
    applyHeightChunk(f, 0, w, flat(0), KEEP);
    expect(riseAt(f, 0, 0)).toBe(2);
    expect(riseAt(f, 1, 0)).toBe(2.5);
    expect(riseAt(f, 2, 0)).toBe(63);
    expect(riseAt(f, 3, 0)).toBe(0);
    expect(f.data[2]! & KEPT_BIT).toBe(KEPT_BIT);
  });

  it('puts a chunk where its index says', () => {
    const f = createHeightField();
    applyHeightChunk(f, 1 * 4 + 2, chunkOf(5), flat(0), KEEP);
    // chunk (ci 2, cj 1) starts at x = -1800 + 1800 = 0, z = -900
    expect(riseAt(f, 1800, 900)).toBe(5);
    expect(riseAt(f, 1799, 900)).toBeNaN();
    expect(heightAt(f, 10.5, -890.5)).toMatchObject({ state: 'kept', rise: 5, chunk: 6 });
    expect(heightAt(f, -10, -890).state).toBe('never');
  });

  it('keeps the previous byte where the new measurement is unknown', () => {
    const f = createHeightField();
    applyHeightChunk(f, 0, chunkOf(6), flat(0), KEEP);
    const w = chunkOf(NaN);
    w[5] = 1;
    const st = applyHeightChunk(f, 0, w, flat(0), KEEP);
    expect(riseAt(f, 0, 0)).toBe(6);
    expect(f.data[0]! & KEPT_BIT).toBe(KEPT_BIT);
    expect(riseAt(f, 5, 0)).toBe(1);
    expect(st.known).toBe(M * M);
    expect(heightAt(f, -1799.5, -1799.5).state).toBe('kept');
  });

  it('reports unknown for a captured chunk no tile drew in', () => {
    const f = createHeightField();
    applyHeightChunk(f, 0, chunkOf(NaN), flat(0), KEEP);
    expect(heightAt(f, -1790, -1790)).toMatchObject({ state: 'unknown', chunk: 0 });
    expect(f.data[0]).toBe(RISE_UNKNOWN);
  });

  it('applies hysteresis: kept at 3.2 m stays at 2.0 m, drops at 1.0 m', () => {
    const f = createHeightField();
    const at = (rise: number) => applyHeightChunk(f, 0, chunkOf(rise), flat(0), KEEP);
    expect(at(3.2).changed).toBe(M * M);
    expect(f.data[0]! & KEPT_BIT).toBe(KEPT_BIT);
    expect(at(2.0).changed).toBe(0);
    expect(f.data[0]! & KEPT_BIT).toBe(KEPT_BIT);
    expect(riseAt(f, 0, 0)).toBe(2);
    const down = at(1.0);
    expect(down.changed).toBe(M * M);
    expect(down.kept).toBe(0);
    expect(f.data[0]! & KEPT_BIT).toBe(0);
    // and a texel between the thresholds that was never kept does not turn on
    expect(at(2.0).kept).toBe(0);
    expect(at(3.0).kept).toBe(M * M);
  });

  it('subtracts a sloped 10 m terrain, bilinearly, per texel', () => {
    // terrain height = x / 10 (a 10% slope east), nodes every 10 m
    const segs = 360, w = segs + 1, data = new Float32Array(w * w);
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) data[j * w + i] = (i * 10 - 1800) / 10;
    const terrain: HeightTerrain = { size: 3600, segs, data };
    expect(sampleTerrain(terrain, 100, 5)).toBeCloseTo(10, 4);
    expect(sampleTerrain(terrain, 104, 5)).toBeCloseTo(10.4, 4);
    // the surface is a roof 12 m above the slope at every texel of chunk 3 (x from 900 to 1800)
    const worldY = new Float32Array(M * M);
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) worldY[j * M + i] = (900 + i + 0.5) / 10 + 12;
    const f = createHeightField();
    applyHeightChunk(f, 3, worldY, terrain, KEEP);
    expect(riseAt(f, 2700, 0)).toBe(12);
    expect(riseAt(f, 3599, 0)).toBe(12);
    // the same world Y over flat terrain at 0 would read 90+ m, capped at 63
    const g = createHeightField();
    applyHeightChunk(g, 3, worldY, flat(0), KEEP);
    expect(riseAt(g, 2700, 0)).toBe(63);
  });

  it('thresholds scale with the relief boost the caller passes', () => {
    const f = createHeightField();
    applyHeightChunk(f, 0, chunkOf(4), flat(0), 6);
    expect(f.data[0]! & KEPT_BIT).toBe(0);
    applyHeightChunk(f, 0, chunkOf(6), flat(0), 6);
    expect(f.data[0]! & KEPT_BIT).toBe(KEPT_BIT);
    applyHeightChunk(f, 0, chunkOf(3.5), flat(0), 6);
    expect(f.data[0]! & KEPT_BIT).toBe(KEPT_BIT);
    applyHeightChunk(f, 0, chunkOf(2.5), flat(0), 6);
    expect(f.data[0]! & KEPT_BIT).toBe(0);
  });
});
