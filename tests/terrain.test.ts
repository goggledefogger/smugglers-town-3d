import { describe, it, expect } from 'vitest';
import { sampleGridSmooth, type ElevationGrid } from '../src/core/terrain/RealTerrain.ts';

function gridOf(n: number, f: (i: number, j: number) => number): ElevationGrid {
  const samples: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) samples.push(f(i, j));
  return { samples, gridN: n };
}

describe('sampleGridSmooth', () => {
  it('reproduces grid values at the nodes', () => {
    const g = gridOf(6, (i, j) => i * 3 + j * j);
    expect(sampleGridSmooth(g, 2, 3)).toBeCloseTo(2 * 3 + 9, 9);
    expect(sampleGridSmooth(g, 0, 0)).toBeCloseTo(0, 9);
  });

  it('is exact on a quadratic hill away from the edges, so slopes are continuous', () => {
    const g = gridOf(8, (i, j) => i * i + 2 * j);
    expect(sampleGridSmooth(g, 2.5, 3.25)).toBeCloseTo(2.5 * 2.5 + 6.5, 9);
    // slope across a grid edge does not jump: finite differences either side agree
    const d = 1e-3;
    const left = (sampleGridSmooth(g, 3, 3) - sampleGridSmooth(g, 3 - d, 3)) / d;
    const right = (sampleGridSmooth(g, 3 + d, 3) - sampleGridSmooth(g, 3, 3)) / d;
    expect(Math.abs(left - right)).toBeLessThan(0.01);
  });
});
