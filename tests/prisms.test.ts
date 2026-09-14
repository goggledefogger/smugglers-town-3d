import { describe, it, expect } from 'vitest';
import { prismWalls } from '../src/render/PrismMeshView.ts';
import { wallReaches, wallKey, type Wall } from '../src/render/FacadeBaker.ts';
import { pointInRing } from '../src/services/overture/buildings.ts';

// a 20 x 10 m footprint, ring closed, listed either way round
const square = (x0: number, z0: number, x1: number, z1: number, cw = false): number[] =>
  cw ? [x0, z0, x0, z1, x1, z1, x1, z0, x0, z0] : [x0, z0, x1, z0, x1, z1, x0, z1, x0, z0];

describe('prismWalls', () => {
  it('gives every edge an outward normal whichever way the ring runs, and holes face into the hole', () => {
    for (const cw of [false, true]) {
      const walls = prismWalls({ ring: square(0, 0, 20, 10, cw), holes: [square(5, 3, 8, 6, !cw)], y0: 0, y1: 30 });
      expect(walls).toHaveLength(8);
      const cx = 10, cz = 5;
      walls.slice(0, 4).forEach(w => {
        const mx = (w.ax + w.bx) / 2 - cx, mz = (w.az + w.bz) / 2 - cz;
        expect(mx * w.nx + mz * w.nz).toBeGreaterThan(0); // away from the centre
      });
      walls.slice(4).forEach(w => {
        const mx = (w.ax + w.bx) / 2 - 6.5, mz = (w.az + w.bz) / 2 - 4.5;
        expect(mx * w.nx + mz * w.nz).toBeLessThan(0); // into the hole
      });
    }
  });
});

describe('wallReaches', () => {
  const wall = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number, y1 = 30): Wall =>
    ({ ax, az, bx, bz, nx, nz, y0: 0, y1 });

  it('looks half way across the street, nothing at all through a party wall, and full reach into open ground', () => {
    const walls = [
      wall(0, 0, 20, 0, 0, -1),   // faces -z; the wall across the 12 m street at z = -12
      wall(0, -12, 20, -12, 0, 1),
      wall(20, 0, 20, 10, 1, 0),  // faces +x; its neighbour's party wall runs the same line
      wall(20, 10, 20, 0, -1, 0),
      wall(0, 10, 20, 10, 0, 1)   // faces +z; nothing there
    ];
    const r = wallReaches(walls);
    expect(r[0]).toBe(6);
    expect(r[1]).toBe(6);
    expect(r[2]).toBe(0);
    expect(r[3]).toBe(0);
    expect(r[4]).toBe(25);
  });

  it('a building part tracing its building outline (same line, same way) does not hide the wall', () => {
    const walls = [wall(0, 0, 20, 0, 0, -1), wall(0, 0, 20, 0, 0, -1, 60), wall(0, -12, 20, -12, 0, 1)];
    expect(wallReaches(walls)[0]).toBe(6);
    expect(wallReaches(walls)[1]).toBe(6);
  });

  it('ignores a wall that does not rise above its base', () => {
    const walls = [wall(0, 0, 20, 0, 0, -1), { ...wall(0, -12, 20, -12, 0, 1), y0: 40, y1: 60 }];
    expect(wallReaches(walls)[0]).toBe(25);
  });

  it('keys a wall by where it stands', () => {
    expect(wallKey(wall(0, 0, 20, 0, 0, -1))).toBe(wallKey(wall(0, 0, 20, 0, 0, 1)));
    expect(wallKey(wall(0, 0, 20, 0, 0, -1))).not.toBe(wallKey(wall(0, 0, 21, 0, 0, -1)));
  });
});

describe('pointInRing', () => {
  it('is inside the square and outside it, either winding', () => {
    for (const cw of [false, true]) {
      const r = square(0, 0, 20, 10, cw);
      expect(pointInRing(r, 10, 5)).toBe(true);
      expect(pointInRing(r, 25, 5)).toBe(false);
      expect(pointInRing(r, 10, 12)).toBe(false);
    }
  });
});
