import { describe, it, expect } from 'vitest';
import { RGFormat } from 'three';
import { Heightfield } from '../src/core/heightfield.ts';
import { TileClutterFilter, CLUTTER_MODES } from '../src/render/TileClutterFilter.ts';
import {
  footprintMask1m, maskAt, dilateMask, classifierGap, MASK_ON, packFootprints, classifierCells, paintGapCells, selectGapBoxes,
  CutoutStencilBuilder, CELL_GAP, CELL_COVERED, CELL_NONE, encodeRoofCap, decodeRoofCap, ROOF_NO_CAP, roofCapAt,
  footprintMaskPacked, polygonRoofCaps, digestBytes, cutoutInputDigest
} from '../src/services/overture/footprintMask.ts';
import { CoalescedRebuild } from '../src/services/overture/coalescedRebuild.ts';
import { VIEW_MODES, VIEW_MODE_CYCLE, traits, parseViewMode } from '../src/render/viewModes.ts';

/** closed square ring, world x,z */
const square = (x0: number, z0: number, x1: number, z1: number) => [x0, z0, x1, z0, x1, z1, x0, z1, x0, z0];
const count = (d: Uint8Array) => d.reduce((a, v) => a + (v ? 1 : 0), 0);

describe('footprintMask1m', () => {
  // 64 m mask at 1 m, centred on the origin: texel i covers x in [-32 + i, -31 + i)
  const opts = { size: 64, cell: 1, dilateM: 0 };

  it('fills exactly the cells of a square footprint', () => {
    const m = footprintMask1m([{ ring: square(0, 0, 10, 10), holes: [] }], opts);
    expect(count(m.data)).toBe(100);
    expect(maskAt(m, 0.5, 0.5)).toBe(true);
    expect(maskAt(m, 9.5, 9.5)).toBe(true);
    expect(m.data[32 * 64 + 32]).toBe(MASK_ON);
    expect(m.data[41 * 64 + 41]).toBe(MASK_ON);
    expect(m.data[42 * 64 + 42]).toBe(0);
  });

  it('reads 0 just outside the footprint and beyond the extent', () => {
    const m = footprintMask1m([{ ring: square(0, 0, 10, 10), holes: [] }], opts);
    expect(maskAt(m, 10.2, 5)).toBe(false);
    expect(maskAt(m, -0.2, 5)).toBe(false);
    expect(maskAt(m, 5, 10.2)).toBe(false);
    expect(maskAt(m, 500, 5)).toBe(false);
  });

  it('keeps holes empty', () => {
    const m = footprintMask1m([{ ring: square(0, 0, 10, 10), holes: [square(3, 3, 7, 7)] }], opts);
    expect(count(m.data)).toBe(100 - 16);
    expect(maskAt(m, 5, 5)).toBe(false);
    expect(maskAt(m, 1, 1)).toBe(true);
  });

  it('unions a building part over its building instead of cancelling it', () => {
    const m = footprintMask1m([
      { ring: square(0, 0, 10, 10), holes: [] },
      { ring: square(2, 2, 6, 6), holes: [] }
    ], opts);
    expect(count(m.data)).toBe(100);
    expect(maskAt(m, 4, 4)).toBe(true);
  });

  it('dilation grows the square by the radius', () => {
    const r1 = footprintMask1m([{ ring: square(0, 0, 10, 10), holes: [] }], { ...opts, dilateM: 1.5 });
    // Euclidean 1.5: one texel on every side including the diagonal corners
    expect(count(r1.data)).toBe(12 * 12);
    expect(maskAt(r1, -0.5, 5)).toBe(true);
    expect(maskAt(r1, -1.5, 5)).toBe(false);
    const r2 = footprintMask1m([{ ring: square(0, 0, 10, 10), holes: [] }], { ...opts, dilateM: 2 });
    expect(maskAt(r2, -1.5, 5)).toBe(true);
    expect(maskAt(r2, -2.5, 5)).toBe(false);
    // the corner is rounded: (2,2) away is sqrt 8 > 2
    expect(maskAt(r2, -1.5, -1.5)).toBe(false);
    expect(maskAt(r2, -0.5, -0.5)).toBe(true);
  });

  it('clears the outer texel ring so a clamped lookup past the extent reads 0', () => {
    const m = footprintMask1m([{ ring: square(-40, -40, 40, 40), holes: [] }], opts);
    expect(m.data[0]).toBe(0);
    expect(m.data[63 * 64 + 10]).toBe(0);
    expect(m.data[10 * 64 + 63]).toBe(0);
    expect(m.data[1 * 64 + 1]).toBe(MASK_ON);
  });

  it('2 m texels quarter the mask and still cover the square', () => {
    const m = footprintMask1m([{ ring: square(0, 0, 10, 10), holes: [] }], { size: 64, cell: 2, dilateM: 0 });
    expect(m.n).toBe(32);
    expect(m.size).toBe(64);
    expect(count(m.data)).toBe(25);
    expect(maskAt(m, 5, 5)).toBe(true);
    expect(maskAt(m, 11, 5)).toBe(false);
  });

  it('defaults to 3600 m at 1 m texels, dilated 2 m', () => {
    const m = footprintMask1m([{ ring: square(0, 0, 10, 10), holes: [] }]);
    expect(m.n).toBe(3600);
    expect(maskAt(m, -1.5, 5)).toBe(true);
    expect(maskAt(m, -2.5, 5)).toBe(false);
  });

  it('bounding-box dilation matches a whole-grid dilation', () => {
    const polys = [
      { ring: square(-20, -5, -3, 9), holes: [square(-15, 0, -10, 4)] },
      { ring: [4, 4, 20, 6, 12, 25, 4, 4], holes: [] }
    ];
    const local = footprintMask1m(polys, { size: 64, dilateM: 2.5 });
    const ref = dilateMask(footprintMask1m(polys, { size: 64, dilateM: 0 }).data, 64, 2.5);
    expect(Array.from(local.data)).toEqual(Array.from(ref));
  });

  it('dilation leaves a mask alone below one texel', () => {
    const d = new Uint8Array(9);
    d[4] = MASK_ON;
    expect(dilateMask(d, 3, 0.5)).toBe(d);
    expect(count(dilateMask(d, 3, 1))).toBe(5);
  });
});

describe('classifierGap', () => {
  const grid = { n: 8, cell: 10, half: 40 };
  it('counts structure groups with no footprint near them', () => {
    const s = new Uint8Array(64);
    // group A: cells (4,4),(5,4) = world x 0..20, z 0..10, covered by a footprint
    s[4 * 8 + 4] = 1; s[4 * 8 + 5] = 1;
    // group B: cell (1,1) = world x -30..-20, z -30..-20, nothing there
    s[1 * 8 + 1] = 1;
    const m = footprintMask1m([{ ring: square(2, 2, 8, 8), holes: [] }], { size: 128, cell: 1, dilateM: 0 });
    expect(classifierGap(s, grid, m, 3)).toEqual({ classifierBuildings: 2, withoutFootprint: 1 });
  });
  it('ignores groups outside the mask extent', () => {
    const s = new Uint8Array(64);
    s[0] = 1;
    const m = footprintMask1m([], { size: 20, cell: 1, dilateM: 0 });
    expect(classifierGap(s, grid, m, 3)).toEqual({ classifierBuildings: 0, withoutFootprint: 0 });
  });
});

describe('hybrid stencil: Overture union the classifier gap cells', () => {
  // classifier: 8 x 10 m cells over x,z in [-40, 40); mask 128 m at 1 m
  const grid = { n: 8, cell: 10, half: 40 };
  const opts = { size: 128, cell: 1, dilateM: 2 };
  const cellAt = (i: number, j: number) => j * 8 + i;
  // cell (4,4) = world x,z 0..10 holds an Overture square; cell (1,1) = -30..-20 has no footprint
  const structure = () => {
    const s = new Uint8Array(64);
    s[cellAt(4, 4)] = 1; s[cellAt(1, 1)] = 1; s[cellAt(5, 4)] = 1;
    return s;
  };
  const polys = [{ ring: square(2, 2, 8, 8), holes: [] }];

  it('marks a cell with an Overture texel in reach covered and a far one a gap', () => {
    const m = footprintMask1m(polys, opts);
    const cells = classifierCells(structure(), grid, m, 3);
    expect(cells[cellAt(4, 4)]).toBe(CELL_COVERED);
    // (5,4) = x 10..20: the dilated square reaches x 10, inside 3 m
    expect(cells[cellAt(5, 4)]).toBe(CELL_COVERED);
    expect(cells[cellAt(1, 1)]).toBe(CELL_GAP);
    expect(cells[cellAt(0, 0)]).toBe(CELL_NONE);
  });

  it('paints a gap cell whole and leaves a covered cell to its 1 m outline', () => {
    const m = footprintMask1m(polys, opts);
    const before = m.data.slice();
    const cells = classifierCells(structure(), grid, m, 3);
    expect(paintGapCells(m, cells, grid)).toBe(1);
    // the gap cell, every texel of it
    for (const [x, z] of [[-29.5, -29.5], [-20.5, -20.5], [-25, -25]] as const) expect(maskAt(m, x, z)).toBe(true);
    expect(maskAt(m, -19.5, -25)).toBe(false);
    expect(maskAt(m, -30.5, -25)).toBe(false);
    // the covered cells are untouched: their 10 m squares are not painted
    expect(maskAt(m, 9.5, 9.5)).toBe(false);
    expect(maskAt(m, 15, 5)).toBe(false);
    let changed = 0;
    for (let k = 0; k < m.data.length; k++) if (m.data[k] !== before[k]) changed++;
    expect(changed).toBe(100);
  });

  it('builder: unions, reuses the Overture raster, and reports an unchanged classifier', () => {
    const b = new CutoutStencilBuilder();
    const first = b.build({ setId: 1, packed: packFootprints(polys), opts, classifier: { structure: structure(), grid } });
    expect(first.changed).toBe(true);
    expect(first.baseRebuilt).toBe(true);
    expect(first.gapCells).toBe(1);
    expect(first.coverage).toEqual({ classifierBuildings: 2, withoutFootprint: 1 });
    if (!first.changed) throw new Error('unreachable');
    expect(maskAt(first.mask, -25, -25)).toBe(true);
    expect(maskAt(first.mask, 5, 5)).toBe(true);
    expect(first.cells?.[cellAt(1, 1)]).toBe(CELL_GAP);
    const again = b.build({ setId: 1, opts, classifier: { structure: structure(), grid } });
    expect(again.changed).toBe(false);
    expect(again.baseRebuilt).toBe(false);
    // a new building streams in: the raster is reused, the gap repainted
    const s = structure();
    s[cellAt(1, 6)] = 1;
    const grown = b.build({ setId: 1, opts, classifier: { structure: s, grid } });
    expect(grown.changed).toBe(true);
    expect(grown.baseRebuilt).toBe(false);
    expect(grown.gapCells).toBe(2);
    if (grown.changed) expect(maskAt(grown.mask, -25, 25)).toBe(true);
    expect(() => b.build({ setId: 2, opts, classifier: null })).toThrow();
  });

  it('collides with a gap box and drops one that duplicates a prism', () => {
    const cells = new Uint8Array(64);
    cells[cellAt(1, 1)] = CELL_GAP;
    cells[cellAt(4, 4)] = CELL_COVERED; cells[cellAt(5, 4)] = CELL_COVERED; cells[cellAt(6, 4)] = CELL_GAP;
    const box = (x0: number, z0: number, x1: number, z1: number) => ({ min: { x: x0, z: z0 }, max: { x: x1, z: z1 } });
    const gapBox = box(-30, -30, -20, -20);
    const prismBox = box(0, 0, 20, 10);
    const mixed = box(0, 0, 30, 10);
    expect(selectGapBoxes([gapBox, prismBox, mixed], cells, grid)).toEqual([gapBox]);
  });
});

describe('roof cap', () => {
  const opts = { size: 64, cell: 1, dilateM: 2, roofCap: true };

  it('encodes whole metres rounded up and round-trips', () => {
    for (const h of [1, 3, 17, 120, 254]) expect(decodeRoofCap(encodeRoofCap(h))).toBe(h);
    expect(encodeRoofCap(17.2)).toBe(18);
    expect(decodeRoofCap(encodeRoofCap(17.2))).toBeGreaterThanOrEqual(17.2);
    // never 0: that byte means "unset" while a build runs
    expect(encodeRoofCap(0)).toBe(1);
    expect(encodeRoofCap(-4)).toBe(1);
  });

  it('uses 255 as the no-cap sentinel: unknown, infinite, or over 254 m', () => {
    expect(ROOF_NO_CAP).toBe(255);
    expect(encodeRoofCap(null)).toBe(255);
    expect(encodeRoofCap(NaN)).toBe(255);
    expect(encodeRoofCap(Infinity)).toBe(255);
    expect(encodeRoofCap(254.5)).toBe(255);
    expect(decodeRoofCap(255)).toBe(Infinity);
  });

  it('writes RG8: each footprint its cap, the higher where they overlap, the band its own, none outside', () => {
    const low = { ring: square(0, 0, 10, 10), holes: [] };
    const tower = { ring: square(10, 0, 20, 10), holes: [] };
    const part = { ring: square(2, 2, 6, 6), holes: [] };
    const m = footprintMaskPacked(packFootprints([low, tower, part]), opts, Uint8Array.from([12, 90, 30]));
    expect(m.channels).toBe(2);
    expect(m.data.length).toBe(64 * 64 * 2);
    // the low block clear of the tower's and the part's bands
    expect(roofCapAt(m, 1, 8.5)).toBe(12);
    expect(roofCapAt(m, 15, 5)).toBe(90);
    // the part over its building: the higher cap
    expect(roofCapAt(m, 4, 4)).toBe(30);
    // the tower's band reaches 2 m into the low block it shares a wall with and carries the
    // tower's cap there, so the linear filter never halves the cap on the tower's own wall
    expect(roofCapAt(m, 8.5, 5)).toBe(90);
    expect(roofCapAt(m, 9.5, 5)).toBe(90);
    expect(roofCapAt(m, 7.5, 5)).toBe(30);
    // the low block's band beyond its own outer wall
    expect(roofCapAt(m, -1.5, 5)).toBe(12);
    expect(maskAt(m, -1.5, 5)).toBe(true);
    // outside every footprint (and the cleared outer ring): no cap
    expect(roofCapAt(m, -20, -20)).toBe(Infinity);
    expect(m.data[1]).toBe(ROOF_NO_CAP);
    // R is unchanged by the second channel
    const r8 = footprintMaskPacked(packFootprints([low, tower, part]), { ...opts, roofCap: false });
    for (let k = 0; k < r8.data.length; k++) expect(m.data[k * 2]).toBe(r8.data[k]);
  });

  it('a polygon with no cap leaves 255, and that wins an overlap', () => {
    const a = { ring: square(0, 0, 10, 10), holes: [] };
    const b = { ring: square(5, 0, 15, 10), holes: [] };
    const m = footprintMaskPacked(packFootprints([a, b]), opts, Uint8Array.from([20, ROOF_NO_CAP]));
    expect(roofCapAt(m, 2, 5)).toBe(20);
    expect(roofCapAt(m, 7, 5)).toBe(Infinity);
  });

  // roof samples on a 10 m grid, cells over x,z in [-40, 40)
  const grid = { n: 8, cell: 10, half: 40 };
  const cellAt = (i: number, j: number) => j * 8 + i;

  it('caps at the max photogrammetry roof over the footprint, above its base, plus the margin', () => {
    const top = new Float32Array(64).fill(-Infinity);
    // a 20 x 10 m building over cells (4,4) and (5,4): a 12 m podium and a 40 m wing, ground at 5
    top[cellAt(4, 4)] = 17; top[cellAt(5, 4)] = 45;
    const pk = packFootprints([{ ring: square(0, 0, 20, 10), holes: [] }, { ring: square(-30, -30, -20, -20), holes: [] }]);
    const roof = { base: Float32Array.from([5, 0]), overtureTop: Float32Array.from([NaN, NaN]), marginM: 3 };
    const caps = polygonRoofCaps(pk, roof, top, grid);
    // the max (45), not the mean (31): the wing is not shaved
    expect(caps[0]).toBe(45 + 3 - 5);
    // no roof sample at all: no cap
    expect(caps[1]).toBe(ROOF_NO_CAP);
    // Overture's roof counts when it is the higher
    const withOverture = polygonRoofCaps(pk, { ...roof, overtureTop: Float32Array.from([60, 9]) }, top, grid);
    expect(withOverture[0]).toBe(60 + 3 - 5);
    expect(withOverture[1]).toBe(9 + 3);
    // a footprint too small to hold a cell centre reads the cell under its box centre
    const small = packFootprints([{ ring: square(11, 1, 14, 4), holes: [] }]);
    expect(polygonRoofCaps(small, { base: Float32Array.from([5]), overtureTop: Float32Array.from([NaN]), marginM: 3 }, top, grid)[0]).toBe(43);
  });

  it('builder: gap cells get no cap, and a roof sample streaming in re-rasters the cap', () => {
    const b = new CutoutStencilBuilder();
    const polys = [{ ring: square(2, 2, 8, 8), holes: [] }];
    const structure = new Uint8Array(64);
    structure[cellAt(4, 4)] = 1; structure[cellAt(1, 1)] = 1;
    const top = new Float32Array(64).fill(-Infinity);
    const roof = { base: Float32Array.from([0]), overtureTop: Float32Array.from([NaN]), marginM: 3 };
    const o = { size: 128, cell: 1, dilateM: 2, roofCap: true };
    const first = b.build({ setId: 1, packed: packFootprints(polys), roof, opts: o, classifier: { structure, grid, top } });
    if (!first.changed) throw new Error('expected a mask');
    expect(roofCapAt(first.mask, 5, 5)).toBe(Infinity);
    expect(maskAt(first.mask, -25, -25)).toBe(true);
    expect(roofCapAt(first.mask, -25, -25)).toBe(Infinity);
    const top2 = top.slice();
    top2[cellAt(4, 4)] = 20;
    const second = b.build({ setId: 1, opts: o, classifier: { structure, grid, top: top2 } });
    expect(second.baseRebuilt).toBe(true);
    if (!second.changed) throw new Error('expected a mask');
    expect(roofCapAt(second.mask, 5, 5)).toBe(23);
    expect(roofCapAt(second.mask, -25, -25)).toBe(Infinity);
    const third = b.build({ setId: 1, opts: o, classifier: { structure, grid, top: top2.slice() } });
    expect(third.changed).toBe(false);
  });
});

describe('stencil digests: skip the upload and the build when nothing changed', () => {
  const grid = { n: 8, cell: 10, half: 40 };
  const opts = { size: 128, cell: 1, dilateM: 2, roofCap: true };

  it('digests bytes: equal for equal content, different for one flipped byte, length and tail included', () => {
    const a = new Uint8Array(1003).map((_, k) => k * 7);
    expect(digestBytes(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(digestBytes(a.slice())).toBe(digestBytes(a));
    for (const k of [0, 500, 1002]) {
      const b = a.slice();
      b[k] = b[k]! ^ 1;
      expect(digestBytes(b)).not.toBe(digestBytes(a));
    }
    expect(digestBytes(a.subarray(0, 1002))).not.toBe(digestBytes(a));
    expect(digestBytes(new Uint8Array(4), new Uint8Array(4))).not.toBe(digestBytes(new Uint8Array(8)));
  });

  it('input unchanged: same set, cells and roof tops digest the same; a cell, a top or a new set does not', () => {
    const structure = new Uint8Array(64); structure[3] = 1;
    const top = new Float32Array(64).fill(-Infinity); top[3] = 20;
    const d = cutoutInputDigest(1, opts, { structure, grid, top });
    expect(cutoutInputDigest(1, opts, { structure: structure.slice(), grid, top: top.slice() })).toBe(d);
    const s2 = structure.slice(); s2[9] = 1;
    expect(cutoutInputDigest(1, opts, { structure: s2, grid, top })).not.toBe(d);
    const t2 = top.slice(); t2[3] = 21;
    expect(cutoutInputDigest(1, opts, { structure, grid, top: t2 })).not.toBe(d);
    expect(cutoutInputDigest(2, opts, { structure, grid, top })).not.toBe(d);
    expect(cutoutInputDigest(1, { ...opts, roofCap: false }, { structure, grid, top })).not.toBe(d);
  });

  it('digest skip: an identical stencil leaves the texture untouched, a changed one uploads', () => {
    const f = new TileClutterFilter(new Heightfield(40, 4, new Float32Array(25).fill(10)), new Uint8Array(16), 4);
    const polys = [{ ring: square(2, 2, 8, 8), holes: [] }];
    const b1 = new CutoutStencilBuilder(), b2 = new CutoutStencilBuilder();
    const job = { setId: 1, packed: packFootprints(polys), opts, classifier: null };
    const first = b1.build(job);
    // a second builder (as after a worker restart) makes the same bytes: the same digest
    const twin = b2.build({ ...job, packed: packFootprints(polys) });
    if (!first.changed || !twin.changed) throw new Error('expected masks');
    expect(twin.digest).toBe(first.digest);
    expect(twin.digest).toBe(digestBytes(twin.mask.data));
    expect(f.setFootprintMask(first.mask, first.digest)).toBe(true);
    const tex = (f as any).footprintTex;
    const version = tex.version;
    expect(f.setFootprintMask(twin.mask, twin.digest)).toBe(false);
    expect(tex.version).toBe(version);
    expect(tex.image.data).toBe(first.mask.data);
    const other = b2.build({ setId: 2, packed: packFootprints([{ ring: square(2, 2, 9, 9), holes: [] }]), opts, classifier: null });
    if (!other.changed) throw new Error('expected a mask');
    expect(other.digest).not.toBe(first.digest);
    expect(f.setFootprintMask(other.mask, other.digest)).toBe(true);
    expect(tex.version).toBeGreaterThan(version);
    // no digest given: always uploads, as before
    expect(f.setFootprintMask(other.mask)).toBe(true);
  });
});

describe('CoalescedRebuild', () => {
  const fakeClock = () => {
    let t = 0;
    const timers: { at: number; fn: () => void }[] = [];
    return {
      now: () => t,
      setTimeout: (fn: () => void, ms: number) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
      clearTimeout: (h: unknown) => { const k = timers.indexOf(h as any); if (k >= 0) timers.splice(k, 1); },
      advance(ms: number) {
        t += ms;
        for (const h of timers.filter(x => x.at <= t)) { timers.splice(timers.indexOf(h), 1); h.fn(); }
      }
    };
  };

  it('runs the first request now and folds a burst into one run per interval', () => {
    const clock = fakeClock();
    let runs = 0;
    const r = new CoalescedRebuild(() => { runs++; r.done(); }, 2000, clock);
    r.request();
    expect(runs).toBe(1);
    for (let k = 0; k < 20; k++) { clock.advance(100); r.request(); }
    // 20 requests over 2 s: the first ran, the rest folded into the run at 2 s, and the
    // request that landed just after that run started folds into one more at 4 s
    expect(runs).toBe(2);
    clock.advance(2000);
    expect(runs).toBe(3);
    clock.advance(10000);
    expect(runs).toBe(3);
    r.request();
    expect(runs).toBe(4);
  });

  it('keeps one build in flight and runs once more after it for requests made meanwhile', () => {
    const clock = fakeClock();
    let runs = 0;
    const r = new CoalescedRebuild(() => { runs++; }, 2000, clock);
    r.request();
    r.request(); r.request();
    clock.advance(5000);
    expect(runs).toBe(1);
    r.done();
    expect(runs).toBe(2);
    r.done();
    expect(runs).toBe(2);
    r.request();
    clock.advance(1999);
    expect(runs).toBe(2);
    clock.advance(1);
    expect(runs).toBe(3);
    r.reset();
    r.request();
    expect(runs).toBe(4);
  });
});

describe('Cutout 3D view mode', () => {
  it('shows the tiles, cut to footprints, colliding with the prism walls it does not draw', () => {
    expect(VIEW_MODES['cutout-3d']).toEqual({
      label: 'VIEW: CUTOUT 3D', paintsWalls: false, paintsBoxes: false, showsPrisms: false, prismPhysics: true,
      proceduralFacades: false, showsTiles: true, snapsTiles: false, cutsToFootprints: true
    });
  });
  it('is the only mode that cuts, and every drawn-prism mode collides with its walls', () => {
    for (const m of VIEW_MODE_CYCLE) {
      expect(traits(m).cutsToFootprints).toBe(m === 'cutout-3d');
      if (traits(m).showsPrisms) expect(traits(m).prismPhysics).toBe(true);
    }
    expect(new Set(VIEW_MODE_CYCLE)).toEqual(new Set(Object.keys(VIEW_MODES)));
  });
  it('parses ?view= values', () => {
    expect(parseViewMode('cutout-3d')).toBe('cutout-3d');
    expect(parseViewMode('nope')).toBeNull();
    expect(parseViewMode('toString')).toBeNull();
    expect(parseViewMode(null)).toBeNull();
  });
});

describe('TileClutterFilter cutout', () => {
  const hf = () => new Heightfield(40, 4, new Float32Array(25).fill(10));
  const litShader = () => ({
    uniforms: {} as Record<string, { value: any }>,
    vertexShader: '#include <normal_pars_vertex>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}',
    fragmentShader: 'void main() {\n#include <clipping_planes_fragment>\n}'
  });
  const patchOne = (filter: TileClutterFilter) => {
    const mat: any = { onBeforeCompile: () => {}, needsUpdate: false };
    filter.patch({ traverse: (fn: (o: unknown) => void) => fn({ isMesh: true, material: mat }) } as any);
    return mat;
  };

  it('appends cutout as mode 4 and keeps it out of the clutter button cycle', () => {
    expect(CLUTTER_MODES.indexOf('cutout')).toBe(4);
    const f = new TileClutterFilter(hf(), new Uint8Array(16), 4);
    f.mode = 'cutout';
    expect(f.mode).toBe('cutout');
    expect(f.cycleMode()).toBe('flatten');
    for (let k = 0; k < 8; k++) expect(f.cycleMode()).not.toBe('cutout');
  });

  it('samples the footprint stencil per fragment at the world position and discards outside it', () => {
    const f = new TileClutterFilter(hf(), new Uint8Array(16), 4);
    const shader = litShader();
    patchOne(f).onBeforeCompile(shader, {});
    // no stencil yet: the cutout sampler is the structure mask, scaled so its 1 reads 1
    expect(shader.uniforms.uFootprintMask?.value).toBe(shader.uniforms.uClutterMask?.value);
    expect(shader.uniforms.uFootprintField?.value.w).toBe(255);
    expect(shader.fragmentShader).toContain('uniform sampler2D uFootprintMask');
    expect(shader.fragmentShader).toContain('uniform vec4 uFootprintField');
    expect(shader.fragmentShader).toContain('uClutterMode > 3.5');
    expect(shader.fragmentShader).toContain('vec4 cFoot = texture2D(uFootprintMask, (vClutterWorldPos.xz - uFootprintField.xy) / uFootprintField.z + 0.5);');
    expect(shader.fragmentShader).toContain('cFoot.r * uFootprintField.w < 0.5 || vClutterRiseVal > cFoot.g * 255.0 + step(0.999, cFoot.g) * 1e6 + uFootprintNoCap) discard');
    // no stencil: the cap is out of reach (the structure mask has no G)
    expect(shader.uniforms.uFootprintNoCap?.value).toBe(1e6);
    // one sample, no branch of its own
    const cut = shader.fragmentShader.slice(shader.fragmentShader.indexOf('uClutterMode > 3.5) {'), shader.fragmentShader.indexOf('} else if (uClutterMode > 2.5'));
    expect(cut.match(/texture2D/g)?.length).toBe(1);
    expect(cut.match(/\bif\b/g)?.length).toBe(1);
    // the cutout branch is tested before swept's (> 2.5) catches mode 4
    expect(shader.fragmentShader.indexOf('uClutterMode > 3.5')).toBeLessThan(shader.fragmentShader.indexOf('uClutterMode > 2.5'));
    // no flattening in cutout: facades inside a footprint keep their ground floors
    expect(shader.vertexShader).toContain('uClutterMode > 0.5 && uClutterMode < 3.5');
  });

  it('swaps the stencil by uniform value, shared across materials, and clears back to the fallback', () => {
    const f = new TileClutterFilter(hf(), new Uint8Array(16), 4);
    const a = litShader(), b = litShader();
    patchOne(f).onBeforeCompile(a, {});
    patchOne(f).onBeforeCompile(b, {});
    expect(b.uniforms.uFootprintMask).toBe(a.uniforms.uFootprintMask);
    expect(b.uniforms.uFootprintField).toBe(a.uniforms.uFootprintField);
    const m = footprintMask1m([{ ring: square(0, 0, 10, 10), holes: [] }], { size: 64, cell: 1, dilateM: 1.5 });
    f.setFootprintMask(m);
    expect(f.hasFootprintMask).toBe(true);
    expect(a.uniforms.uFootprintMask!.value.image.width).toBe(64);
    expect(a.uniforms.uFootprintMask!.value.image.data).toBe(m.data);
    expect(a.uniforms.uFootprintField!.value.toArray()).toEqual([0, 0, 64, 1]);
    f.setFootprintMask(null);
    expect(f.hasFootprintMask).toBe(false);
    // fallback: the same sampler now reads the structure mask over the whole ground field
    expect(a.uniforms.uFootprintMask!.value).toBe(a.uniforms.uClutterMask!.value);
    expect(a.uniforms.uFootprintField!.value.toArray()).toEqual([0, 0, 40, 255]);
    expect(() => f.setFootprintMask({ data: new Uint8Array(3), n: 2, cx: 0, cz: 0, size: 2 })).toThrow();
  });

  it('loads an RG8 stencil with the cap live, reuses its texture, and an R8 one leaves the cap off', () => {
    const f = new TileClutterFilter(hf(), new Uint8Array(16), 4);
    const a = litShader();
    patchOne(f).onBeforeCompile(a, {});
    const capped = footprintMask1m([{ ring: square(0, 0, 10, 10), holes: [] }], { size: 64, cell: 1, dilateM: 0, roofCap: true });
    f.setFootprintMask(capped);
    expect(f.hasRoofCap).toBe(true);
    expect(a.uniforms.uFootprintNoCap!.value).toBe(0);
    const tex = a.uniforms.uFootprintMask!.value;
    expect(tex.format).toBe(RGFormat);
    const again = { ...capped, data: capped.data.slice() };
    f.setFootprintMask(again);
    expect(a.uniforms.uFootprintMask!.value).toBe(tex);
    expect(tex.image.data).toBe(again.data);
    f.setFootprintMask(footprintMask1m([{ ring: square(0, 0, 10, 10), holes: [] }], { size: 64, cell: 1, dilateM: 0 }));
    expect(f.hasRoofCap).toBe(false);
    expect(a.uniforms.uFootprintNoCap!.value).toBe(1e6);
    expect(() => f.setFootprintMask({ ...capped, data: new Uint8Array(64 * 64) })).toThrow();
  });
});
