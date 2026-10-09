/**
 * The Cutout skirt (docs/plans/2026-10-08-cutout-per-texel-heights.md, 4b Skirt): past the kept growth, a bounded
 * flood into low (floor to keep rise), measured, not kept, not rough mesh, so a wall's foot is not cut.
 */
import { describe, it, expect } from 'vitest';
import {
  type FootprintMaskOptions, maskAt, packFootprints, CutoutStencilBuilder, roofCapAt, decodeRoofCap,
  polygonRoofCaps, digestBytes, footprintMaskLayers, type HeightsView
} from '../src/services/overture/footprintMask.ts';
import {
  createHeightField, encodeRise, heightAt, keepFloorM, KEPT_BIT, ROUGH_BIT, HEIGHT_ORIGIN, HEIGHT_N,
  type HeightField, type HeightTerrain
} from '../src/services/overture/heightField.ts';

const square = (x0: number, z0: number, x1: number, z1: number) => [x0, z0, x1, z0, x1, z1, x0, z1, x0, z0];
const flatTerrain = (h = 0): HeightTerrain => ({ size: 3600, segs: 360, data: new Float32Array(361 * 361).fill(h) });
const groundField = (): HeightField => {
  const f = createHeightField();
  f.data.fill(encodeRise(0));
  return f;
};
/** rise `riseM` (kept unless `flags` says otherwise) over world x in [x0, x1), z in [z0, z1) */
const setBox = (f: HeightField, x0: number, x1: number, z0: number, z1: number, riseM: number, flags = KEPT_BIT): void => {
  for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) f.data[(z - HEIGHT_ORIGIN) * HEIGHT_N + (x - HEIGHT_ORIGIN)] = encodeRise(riseM) | flags;
};
const countOn = (m: { data: Uint8Array; channels: number }): number => {
  let c = 0;
  for (let k = 0; k < m.data.length; k += m.channels) if (m.data[k]) c++;
  return c;
};

const KEEP = 3;
const BASE: FootprintMaskOptions = { size: 64, cell: 1, dilateM: 2, roofCap: true, growM: 8 };
const SKIRT: FootprintMaskOptions = { ...BASE, skirtM: 3, keepRiseM: KEEP };
const roof = (n: number) => ({ base: new Float32Array(n), overtureTop: new Float32Array(n).fill(NaN), marginM: 3 });
const lot = (x0 = -10, z0 = -10, x1 = 10, z1 = 10) => ({ ring: square(x0, z0, x1, z1), holes: [] });
const layersOf = (polys: ReturnType<typeof lot>[], f: HeightField, opts: FootprintMaskOptions = SKIRT) => {
  const pk = packFootprints(polys);
  const h: HeightsView = { field: f, terrain: flatTerrain(0) };
  const caps = polygonRoofCaps(pk, roof(polys.length), null, null, h);
  return { caps, ...footprintMaskLayers(pk, opts, caps, h) };
};
/** the lot's 20 m roof, 4 m of kept overhang east of it (grown), then `strip` from x 14 */
const withStrip = (width: number, rise: number, flags = 0): HeightField => {
  const f = groundField();
  setBox(f, -10, 14, -10, 10, 20);
  setBox(f, 14, 14 + width, -10, 10, rise, flags);
  return f;
};

describe('cutout skirt', () => {
  it('floor is half the keep rise', () => {
    expect(keepFloorM(KEEP)).toBe(1.5);
    expect(keepFloorM(6)).toBe(3);
  });

  it('a. a 2 m strip against the grown edge is added and carries the parent cap', () => {
    const { core, mask, caps, grown, skirted } = layersOf([lot()], withStrip(2, 2));
    expect(grown).toBe(4 * 20);
    expect(skirted).toBe(2 * 20);
    expect(countOn(core)).toBe(400 + 80 + 40);
    expect(maskAt(core, 15.5, 0.5)).toBe(true);
    expect(maskAt(core, 16.5, 0.5)).toBe(false);
    expect(roofCapAt(core, 15.5, 0.5)).toBe(decodeRoofCap(caps[0]!));
    // the dilation stamps skirt texels too
    expect(maskAt(mask, 17.5, 0.5)).toBe(true);
    // and against the polygon itself, no growth on either side
    const g = groundField();
    setBox(g, -10, 10, -10, 10, 20);
    setBox(g, 10, 12, -10, 10, 2, 0);
    const direct = layersOf([lot()], g);
    expect(direct.grown).toBe(0);
    expect(direct.skirted).toBe(40);
    expect(roofCapAt(direct.core, 11.5, 0.5)).toBe(decodeRoofCap(direct.caps[0]!));
  });

  it('a, builder: the skirt runs with growth off and `skirted` reaches the build stats', () => {
    const polys = [lot()];
    const built = new CutoutStencilBuilder().build({
      setId: 1, packed: packFootprints(polys), roof: roof(1), opts: { ...SKIRT, growM: 0 }, classifier: null
    }, { field: withStrip(2, 2), terrain: flatTerrain(0) });
    expect(built.grown).toBe(0);
    // with no growth the 4 m kept overhang is not entered (kept) and stops the skirt at the polygon edge
    expect(built.skirted).toBe(0);
    const g = groundField();
    setBox(g, -10, 10, -10, 10, 20);
    setBox(g, 10, 12, -10, 10, 2, 0);
    const b2 = new CutoutStencilBuilder().build({
      setId: 1, packed: packFootprints(polys), roof: roof(1), opts: { ...SKIRT, growM: 0 }, classifier: null
    }, { field: g, terrain: flatTerrain(0) });
    expect(b2.skirted).toBe(40);
  });

  it('b. a 0.5 m strip (below the floor) is not added; the floor follows keepRiseM', () => {
    expect(layersOf([lot()], withStrip(2, 0.5)).skirted).toBe(0);
    expect(layersOf([lot()], withStrip(2, 1.5)).skirted).toBe(40);
    // a 6 m keep rise puts the floor at 3 m: a 2 m strip is ground there
    expect(layersOf([lot()], withStrip(2, 2), { ...SKIRT, keepRiseM: 6 }).skirted).toBe(0);
  });

  it('c. a rough 2 m strip is not added', () => {
    expect(layersOf([lot()], withStrip(2, 2, ROUGH_BIT)).skirted).toBe(0);
  });

  it('d. stops at skirtM layers', () => {
    const { core, skirted } = layersOf([lot()], withStrip(6, 2));
    expect(skirted).toBe(3 * 20);
    expect(maskAt(core, 16.5, 0.5)).toBe(true);
    expect(maskAt(core, 17.5, 0.5)).toBe(false);
    expect(layersOf([lot()], withStrip(6, 2), { ...SKIRT, skirtM: 1 }).skirted).toBe(20);
  });

  it('e. never enters a kept texel, so it cannot carry growth past a low strip', () => {
    const f = groundField();
    setBox(f, -10, 10, -10, 10, 20);
    setBox(f, 10, 12, -10, 10, 2, 0); // the low strip
    setBox(f, 12, 16, -10, 10, 10);   // kept mesh beyond it, unreachable by kept growth
    const { core, grown, skirted } = layersOf([lot()], f);
    expect(grown).toBe(0);
    expect(skirted).toBe(40);
    expect(maskAt(core, 11.5, 0.5)).toBe(true);
    expect(maskAt(core, 12.5, 0.5)).toBe(false);
    // nor the not-yet-grown kept texels past the 8 m bound: growth's truncation is unchanged
    const g = groundField();
    setBox(g, -10, 30, -10, 10, 20);
    const t = layersOf([lot()], g);
    expect(t.skirted).toBe(0);
    expect(t.grownTruncated).toBe(20);
    expect(maskAt(t.core, 18.5, 0.5)).toBe(false);
  });

  it('f. skirtM 0 (or no keepRiseM) leaves the mask byte-identical', () => {
    const fixtures: HeightField[] = [];
    // the growth fixtures from cutout.test.ts: overhang, past the bound, a taller neighbour, two buildings
    let f = groundField(); setBox(f, -10, 15, -10, 10, 20); fixtures.push(f);
    f = groundField(); setBox(f, -10, 30, -10, 10, 20); fixtures.push(f);
    f = groundField(); setBox(f, -10, 10, -10, 10, 20); setBox(f, 10, 14, -10, 10, 50); fixtures.push(f);
    f = groundField(); setBox(f, -10, 0, -10, 10, 20); fixtures.push(f);
    fixtures.push(withStrip(2, 2), withStrip(6, 2));
    for (const fx of fixtures) {
      const hash = (o: FootprintMaskOptions) => { const r = layersOf([lot()], fx, o); return digestBytes(r.mask.data, r.core.data); };
      const before = hash(BASE);
      expect(hash({ ...SKIRT, skirtM: 0 })).toBe(before);
      expect(hash({ ...BASE, skirtM: 3 })).toBe(before);
      expect(hash({ ...SKIRT, cell: 2 })).toBe(hash({ ...BASE, cell: 2 }));
    }
    // and with the skirt on a strip it does change
    const r = layersOf([lot()], withStrip(2, 2));
    const b = layersOf([lot()], withStrip(2, 2), BASE);
    expect(digestBytes(r.mask.data)).not.toBe(digestBytes(b.mask.data));
  });

  it('heightAt reports the rough bit', () => {
    const f = groundField();
    f.chunkSeen.fill(1);
    setBox(f, 0, 1, 0, 1, 12, KEPT_BIT | ROUGH_BIT);
    setBox(f, 1, 2, 0, 1, 12);
    expect(heightAt(f, 0.5, 0.5)).toMatchObject({ state: 'kept', rough: true });
    expect(heightAt(f, 1.5, 0.5)).toMatchObject({ state: 'kept', rough: false });
    expect(createHeightField() && heightAt(createHeightField(), 0.5, 0.5).rough).toBe(false);
  });
});
