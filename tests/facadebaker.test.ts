import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { faceReach, ShelfPacker, boxKey } from '../src/render/FacadeBaker.ts';
import type { BuildingCollider } from '../src/core/physics/VehicleBody.ts';

const box = (x0: number, z0: number, x1: number, z1: number, h = 30): BuildingCollider =>
  ({ min: new Vector3(x0, 0, z0), max: new Vector3(x1, h, z1) });

describe('faceReach', () => {
  it('looks half way across the street to the box opposite, and not at all into a flush neighbour', () => {
    const boxes = [box(0, 0, 20, 20), box(40, 0, 60, 20), box(20, 0, 30, 20)];
    expect(faceReach(boxes, 0, 1)).toBe(0); // +x face: box 2 is flush against it
    expect(faceReach(boxes, 2, 1)).toBe(5); // +x face of box 2: 10 m gap to box 1, half of it
    expect(faceReach(boxes, 1, 0)).toBe(5); // -x face of box 1 looks back across the same gap
    expect(faceReach(boxes, 0, 2)).toBe(25); // -z face: nothing across, capped reach
  });

  it('ignores boxes that do not overlap the face sideways', () => {
    const boxes = [box(0, 0, 20, 20), box(30, 40, 50, 60)];
    expect(faceReach(boxes, 0, 1)).toBe(25);
  });

  it('a sliver touching a wide face does not make the face internal', () => {
    // a 4 m column flush against a 60 m wall, and a narrower strip of the same building
    const boxes = [box(0, 0, 60, 10), box(28, 10, 32, 14), box(0, -10, 40, 0)];
    expect(faceReach(boxes, 0, 3)).toBe(25); // +z face: the column covers 4 of 60 m
    expect(faceReach(boxes, 0, 2)).toBe(0);  // -z face: the strip covers 40 of 60 m, flush
  });
});

describe('ShelfPacker', () => {
  it('fills a shelf left to right, opens new shelves by height, and reports full', () => {
    const p = new ShelfPacker(128);
    expect(p.alloc(60, 10)).toEqual({ x: 0, y: 0, w: 60, h: 10 });
    expect(p.alloc(60, 12)).toEqual({ x: 60, y: 0, w: 60, h: 12 }); // same 16 px shelf
    expect(p.alloc(30, 10)).toEqual({ x: 0, y: 16, w: 30, h: 10 }); // no room left on the first shelf
    expect(p.alloc(10, 40)).toEqual({ x: 0, y: 32, w: 10, h: 40 }); // a 48 px shelf
    expect(p.alloc(10, 40)).toEqual({ x: 10, y: 32, w: 10, h: 40 });
    expect(p.alloc(10, 60)).toBeNull(); // 80 + 64 > 128
    expect(p.used).toBeCloseTo(80 / 128);
  });
});

describe('boxKey', () => {
  it('is stable for equal bounds and differs when a bound moves', () => {
    expect(boxKey(box(0, 0, 20, 20))).toBe(boxKey(box(0, 0, 20, 20)));
    expect(boxKey(box(0, 0, 20, 20))).not.toBe(boxKey(box(0, 0, 21, 20)));
  });
});
