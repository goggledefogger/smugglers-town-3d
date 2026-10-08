import { describe, it, expect } from 'vitest';
import { Heightfield } from '../src/core/heightfield.ts';
import { TileClutterFilter, CLUTTER_MODES } from '../src/render/TileClutterFilter.ts';
import { footprintMask1m, maskAt, dilateMask, classifierGap, MASK_ON } from '../src/services/overture/footprintMask.ts';
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
    expect(shader.fragmentShader).toContain('texture2D(uFootprintMask, (vClutterWorldPos.xz - uFootprintField.xy) / uFootprintField.z + 0.5).r * uFootprintField.w < 0.5) discard');
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
});
