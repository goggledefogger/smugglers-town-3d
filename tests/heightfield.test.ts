import { describe, it, expect } from 'vitest';
import { Heightfield } from '../src/core/heightfield.ts';
import { generateDesertHeightfieldData } from '../src/core/terrain/ProceduralTerrain.ts';

function makeField(values: number[], segs: number, size: number): Heightfield {
  return new Heightfield(size, segs, new Float32Array(values));
}

describe('Heightfield', () => {
  it('returns exact grid values at grid points', () => {
    // 2x2 cells, 3x3 grid: value = 10*i + j
    const vals: number[] = [];
    for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) vals.push(10 * i + j);
    const hf = makeField(vals, 2, 4);
    // grid point (i=1, j=1) is at world x = (1/2*4 - 2) = 0, z = 0
    expect(hf.sample(0, 0)).toBeCloseTo(11, 9);
    // corner (0,0) maps to world (-2,-2)
    expect(hf.sample(-2, -2)).toBeCloseTo(0, 9);
    // corner (2,2) maps to world (2,2)
    expect(hf.sample(2, 2)).toBeCloseTo(22, 9);
  });

  it('interpolates bilinearly at cell centers', () => {
    const vals: number[] = [];
    for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) vals.push(10 * i + j);
    const hf = makeField(vals, 2, 4);
    // center of cell (0,0) is world (-1,-1): avg of 0,10,1,11 = 5.5
    expect(hf.sample(-1, -1)).toBeCloseTo(5.5, 9);
    // midpoint along x at z=-2: avg of 0 and 10 = 5
    expect(hf.sample(-1, -2)).toBeCloseTo(5, 9);
  });

  it('clamps queries outside the field to edge values', () => {
    const vals: number[] = [];
    for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) vals.push(10 * i + j);
    const hf = makeField(vals, 2, 4);
    expect(hf.sample(-100, 0)).toBeCloseTo(hf.sample(-2, 0), 9);
    expect(hf.sample(100, 100)).toBeCloseTo(hf.sample(2, 2), 9);
  });

  it('rejects mismatched data length', () => {
    expect(() => new Heightfield(4, 2, new Float32Array(4))).toThrow();
  });

  it('generates desert data within the designed range', () => {
    const data = generateDesertHeightfieldData(3);
    expect(data.length).toBe(257 * 257);
    let min = Infinity, max = -Infinity;
    for (const h of data) { if (h < min) min = h; if (h > max) max = h; }
    expect(min).toBeGreaterThanOrEqual(-93);
    expect(max).toBeLessThanOrEqual(107 + 267);
  });
});
