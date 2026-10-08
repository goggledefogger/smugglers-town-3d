import { describe, it, expect } from 'vitest';
import {
  createHeightField, applyHeightChunk, riseAt, roughAt, heightAt, sampleTerrain, encodeRise, decodeRise, decodeRiseTop,
  HEIGHT_N, HEIGHT_CHUNK_M, KEPT_BIT, ROUGH_BIT, RISE_UNKNOWN, type HeightTerrain
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

  it('quantises the rise to 0.5 m and caps it at 61 m', () => {
    const f = createHeightField();
    const w = chunkOf(0);
    w[0] = 2.2; w[1] = 2.3; w[2] = 100; w[3] = -4;
    applyHeightChunk(f, 0, w, flat(0), KEEP);
    expect(riseAt(f, 0, 0)).toBe(2);
    expect(riseAt(f, 1, 0)).toBe(2.5);
    expect(riseAt(f, 2, 0)).toBe(61);
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
    // the same world Y over flat terrain at 0 would read 90+ m, capped at 61
    const g = createHeightField();
    applyHeightChunk(g, 3, worldY, flat(0), KEEP);
    expect(riseAt(g, 2700, 0)).toBe(61);
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

  it('samples terrain at and beyond the +-1800 edge by clamping to the edge nodes', () => {
    const segs = 360, w = segs + 1, data = new Float32Array(w * w);
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) data[j * w + i] = i * 0.1 + j * 0.01;
    const t: HeightTerrain = { size: 3600, segs, data };
    expect(sampleTerrain(t, -1800, -1800)).toBeCloseTo(0, 5);
    expect(sampleTerrain(t, 1800, 1800)).toBeCloseTo(360 * 0.1 + 360 * 0.01, 4);
    expect(sampleTerrain(t, -5000, -5000)).toBeCloseTo(0, 5);
    expect(sampleTerrain(t, 5000, 1800)).toBeCloseTo(360 * 0.1 + 360 * 0.01, 4);
    expect(sampleTerrain(t, 1799.9, 0)).toBeCloseTo(sampleTerrain(t, 1800, 0), 1);
  });

  it('measures the last texels of the square against the edge terrain', () => {
    const segs = 360, w = segs + 1, data = new Float32Array(w * w);
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) data[j * w + i] = 2;
    const terrain: HeightTerrain = { size: 3600, segs, data };
    const f = createHeightField();
    applyHeightChunk(f, 15, chunkOf(10), terrain, KEEP);
    expect(riseAt(f, HEIGHT_N - 1, HEIGHT_N - 1)).toBe(8);
    expect(riseAt(f, HEIGHT_N - M, HEIGHT_N - M)).toBe(8);
  });

  it('stores unknown, not a rise of 0, where the terrain is NaN', () => {
    const segs = 360, w = segs + 1, data = new Float32Array(w * w).fill(NaN);
    const f = createHeightField();
    const st = applyHeightChunk(f, 0, chunkOf(5), { size: 3600, segs, data }, KEEP);
    expect(Number.isNaN(riseAt(f, 0, 0))).toBe(true);
    expect(f.data[0]).toBe(RISE_UNKNOWN);
    expect(st.known).toBe(0);
    expect(st.kept).toBe(0);
    // and a NaN terrain does not erase a texel that was measured
    applyHeightChunk(f, 0, chunkOf(5), flat(0), KEEP);
    applyHeightChunk(f, 0, chunkOf(5), { size: 3600, segs, data }, KEEP);
    expect(riseAt(f, 0, 0)).toBe(5);
    expect(f.data[0]! & KEPT_BIT).toBe(KEPT_BIT);
  });

  it('lays the rise out as 0.5 m steps to 15.5 m, 1.5 m steps to 61 m, and 63 for unknown', () => {
    expect(encodeRise(0)).toBe(0);
    expect(encodeRise(-3)).toBe(0);
    expect(encodeRise(15.5)).toBe(31);
    expect(encodeRise(15.74)).toBe(31);
    expect(encodeRise(16)).toBe(32);
    expect(encodeRise(61)).toBe(62);
    expect(encodeRise(500)).toBe(62);
    for (let q = 0; q <= 62; q++) expect(encodeRise(decodeRise(q))).toBe(q);
    expect(decodeRise(31)).toBe(15.5);
    expect(decodeRise(32)).toBe(16);
    expect(decodeRise(62)).toBe(61);
    expect(decodeRiseTop(31)).toBe(15.5);
    expect(decodeRiseTop(41)).toBe(decodeRise(41) + 0.75);
    expect(RISE_UNKNOWN).toBe(63);
    const f = createHeightField();
    const w = chunkOf(0);
    w[0] = 30; w[1] = 15.6; w[2] = 16.7;
    applyHeightChunk(f, 0, w, flat(0), KEEP);
    expect(riseAt(f, 0, 0)).toBe(29.5);
    expect(riseAt(f, 1, 0)).toBe(15.5);
    expect(riseAt(f, 2, 0)).toBe(16);
    // the rise bits never leak into the flag bits
    expect(f.data[0]! & (KEPT_BIT | ROUGH_BIT)).toBe(KEPT_BIT | ROUGH_BIT);
  });

  it('keeps the hysteresis in the coarse range too', () => {
    const f = createHeightField();
    applyHeightChunk(f, 0, chunkOf(40), flat(0), KEEP);
    expect(f.data[500]! & KEPT_BIT).toBe(KEPT_BIT);
    applyHeightChunk(f, 0, chunkOf(2), flat(0), KEEP);
    expect(f.data[500]! & KEPT_BIT).toBe(KEPT_BIT);
    applyHeightChunk(f, 0, chunkOf(1), flat(0), KEEP);
    expect(f.data[500]! & KEPT_BIT).toBe(0);
  });

  describe('rough bit', () => {
    /** four 20x20 patches on 0 m ground, stride 30 texels starting at (10, 10) */
    const patches = (): { f: ReturnType<typeof createHeightField>; at: (p: number, i: number, j: number) => [number, number] } => {
      const w = chunkOf(0);
      const at = (p: number, i: number, j: number): [number, number] => [10 + p * 30 + i, 10 + j];
      for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) {
        const set = (p: number, y: number): void => { const [x, z] = at(p, i, j); w[z * M + x] = y; };
        set(0, 20);
        set(1, 10 + i);
        set(2, i < 10 ? 20 : 22);
        set(3, (i + j) % 2 ? 12 : 4);
      }
      const f = createHeightField();
      applyHeightChunk(f, 0, w, flat(0), KEEP);
      return { f, at };
    };
    const roughIn = (f: ReturnType<typeof createHeightField>, p: number, at: (p: number, i: number, j: number) => [number, number]): [number, number][] => {
      const out: [number, number][] = [];
      for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) {
        const [x, z] = at(p, i, j);
        if (roughAt(f, x, z)) out.push([i, j]);
      }
      return out;
    };

    it('marks a flat roof at its corners only', () => {
      const { f, at } = patches();
      expect(roughIn(f, 0, at)).toEqual([[0, 0], [19, 0], [0, 19], [19, 19]]);
    });

    it('treats a 45 degree slope as planar: corners only', () => {
      const { f, at } = patches();
      expect(roughIn(f, 1, at)).toEqual([[0, 0], [19, 0], [0, 19], [19, 19]]);
    });

    it('marks a one-way step only where the step meets the patch edge', () => {
      const { f, at } = patches();
      expect(roughIn(f, 2, at)).toEqual([
        [0, 0], [9, 0], [10, 0], [19, 0], [0, 19], [9, 19], [10, 19], [19, 19]
      ]);
    });

    it('marks a 4/12 m checkerboard rough everywhere', () => {
      const { f, at } = patches();
      expect(roughIn(f, 3, at)).toHaveLength(400);
    });

    it('counts the rough texels in the reply and counts a rough flip as a change', () => {
      const w = chunkOf(0);
      for (let j = 10; j < 30; j++) for (let i = 10; i < 30; i++) w[j * M + i] = 20;
      const f = createHeightField();
      const st = applyHeightChunk(f, 0, w, flat(0), KEEP);
      expect(st.rough).toBe(4);
      expect(st.kept).toBe(400);
      expect(st.changed).toBe(400);
      // the same measurement again: nothing flipped
      expect(applyHeightChunk(f, 0, w, flat(0), KEEP).changed).toBe(0);
      // the roof turns to canopy at the same height: only the rough bits change
      for (let j = 10; j < 30; j++) for (let i = 10; i < 30; i++) w[j * M + i] = (i + j) % 2 ? 24 : 18;
      const st2 = applyHeightChunk(f, 0, w, flat(0), KEEP);
      expect(st2.rough).toBe(400);
      expect(st2.changed).toBe(400 - 4);
    });

    it('reads a neighbour across a chunk seam from the field', () => {
      const f = createHeightField();
      const left = chunkOf(NaN), right = chunkOf(NaN);
      for (let j = 100; j < 120; j++) for (let i = 880; i < 900; i++) left[j * M + i] = 12;
      for (let j = 100; j < 120; j++) for (let i = 0; i < 20; i++) right[j * M + i] = 12;
      applyHeightChunk(f, 0, left, flat(0), KEEP);
      // measured alone, the seam column's right neighbour is unknown: rough at its ends
      expect(roughAt(f, 899, 110)).toBe(false);
      expect(roughAt(f, 899, 100)).toBe(true);
      applyHeightChunk(f, 1, right, flat(0), KEEP);
      // the new chunk's first column sees the old chunk's last, so it is planar on both axes except at the top
      expect(roughAt(f, 900, 110)).toBe(false);
      expect(roughAt(f, 900, 100)).toBe(false);
      expect(roughAt(f, 919, 119)).toBe(true);
      // the old chunk's seam texel is only refreshed when that chunk is measured again
      expect(roughAt(f, 899, 110)).toBe(false);
    });

    it('does not set rough where nothing is kept', () => {
      const f = createHeightField();
      const w = chunkOf(1);
      w[500] = 2.9;
      applyHeightChunk(f, 0, w, flat(0), KEEP);
      expect(f.data[500]! & ROUGH_BIT).toBe(0);
    });
  });
});
