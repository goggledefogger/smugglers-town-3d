import { describe, it, expect } from 'vitest';
import { Heightfield } from '../src/core/heightfield.ts';
import { TileClutterFilter, CLUTTER_RISE_M, snapIdGrid } from '../src/render/TileClutterFilter.ts';
import { Vector3 } from 'three';
const hfSnap = () => new Heightfield(80, 4, new Float32Array(25).fill(0));
import { collidersFromRasters } from '../src/services/tiles/tileColliders.ts';
import { Bindings, HOTKEY_ACTIONS } from '../src/input/bindings.ts';

// a MeshStandardMaterial-shaped shader object, as three hands to onBeforeCompile
const litShader = () => ({
  uniforms: {} as Record<string, { value: unknown }>,
  vertexShader: '#include <normal_pars_vertex>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}',
  fragmentShader: 'void main() {\n#include <clipping_planes_fragment>\n}'
});

const patchOne = (filter: TileClutterFilter) => {
  const mat: any = { onBeforeCompile: () => {}, needsUpdate: false };
  const mesh: any = { isMesh: true, material: mat };
  filter.patch({ traverse: (fn: (o: unknown) => void) => fn(mesh) } as any);
  return mat;
};

describe('structure mask', () => {
  const N = 40;
  const grid = { cell: 1.5, half: (N * 1.5) / 2, n: N };
  const flat = (v: number) => new Float32Array(N * N).fill(v);

  it('marks building cells 1 and street cells 0', () => {
    const top = flat(0), low = flat(0);
    for (let j = 15; j <= 17; j++) for (let i = 15; i <= 17; i++) top[j * N + i] = 4.5;
    const mask = new Uint8Array(N * N).fill(7);
    collidersFromRasters([{ i0: 0, j0: 0, w: N, h: N, top, low }], grid, flat(0), 1, undefined, undefined, mask);
    expect(mask[16 * N + 16]).toBe(1);
    expect(mask[10 * N + 10]).toBe(0);
    expect(mask.every(v => v === 0 || v === 1)).toBe(true);
  });
});

describe('TileClutterFilter', () => {
  const hf = () => new Heightfield(40, 4, new Float32Array(25).fill(10));
  const mask = () => new Uint8Array(16);

  it('rejects a mask that does not match the grid', () => {
    expect(() => new TileClutterFilter(hf(), new Uint8Array(9), 4)).toThrow();
  });

  it('starts off and cycles through the modes', () => {
    const f = new TileClutterFilter(hf(), mask(), 4);
    expect(f.mode).toBe('off');
    expect(f.cycleMode()).toBe('flatten');
    expect(f.cycleMode()).toBe('hidden');
    expect(f.cycleMode()).toBe('swept');
    expect(f.cycleMode()).toBe('off');
  });

  it('injects the ground, mask and mode uniforms plus the vertex patch', () => {
    const f = new TileClutterFilter(hf(), mask(), 4, 2);
    const mat = patchOne(f);
    expect(mat.needsUpdate).toBe(true);
    const shader = litShader();
    mat.onBeforeCompile(shader, {});
    expect(shader.uniforms.uClutterGround?.value).toBeDefined();
    expect(shader.uniforms.uClutterMask?.value).toBeDefined();
    expect(shader.uniforms.uClutterRise?.value).toBe(CLUTTER_RISE_M * 2);
    expect(shader.vertexShader).toContain('uniform sampler2D uClutterGround');
    expect(shader.vertexShader).toContain('#include <begin_vertex>\n');
    expect(shader.vertexShader).toContain('texelFetch(uClutterGround');
    expect(shader.vertexShader).toContain('uClutterMask, cuv).r * 255.0');
    expect(shader.vertexShader).toContain('#include <project_vertex>\n');
    expect(shader.vertexShader).toContain('vNormal');
    expect(shader.vertexShader).toContain('vClutterStructure = cStructure');
    expect(shader.vertexShader).toContain('vClutterFlat = 1.0');
    expect(shader.uniforms.uClutterTall?.value).toBe(6 / CLUTTER_RISE_M);
    expect(shader.fragmentShader).toContain('vClutterFlat > 0.999');
    expect(shader.fragmentShader).toContain('#include <clipping_planes_fragment>\n');
    expect(shader.fragmentShader).toContain('discard');
  });

  it('leaves the normal fix out of unlit materials', () => {
    const f = new TileClutterFilter(hf(), mask(), 4);
    const shader = { ...litShader(), vertexShader: 'void main() {\n#include <begin_vertex>\n#include <project_vertex>\n}' };
    patchOne(f).onBeforeCompile(shader, {});
    expect(shader.vertexShader).not.toContain('vNormal');
  });

  it('shares one mode uniform across materials so switching needs no recompile', () => {
    const f = new TileClutterFilter(hf(), mask(), 4);
    const a = litShader(), b = litShader();
    patchOne(f).onBeforeCompile(a, {});
    patchOne(f).onBeforeCompile(b, {});
    expect(a.uniforms.uClutterMode!.value).toBe(0);
    f.mode = 'flatten';
    expect(a.uniforms.uClutterMode!.value).toBe(1);
    expect(b.uniforms.uClutterMode).toBe(a.uniforms.uClutterMode);
  });

  it('patches each material once and keeps the original onBeforeCompile', () => {
    const f = new TileClutterFilter(hf(), mask(), 4);
    let prevCalls = 0;
    const mat: any = { onBeforeCompile: () => { prevCalls++; }, needsUpdate: false };
    const root: any = { traverse: (fn: (o: unknown) => void) => fn({ isMesh: true, material: mat }) };
    f.patch(root);
    const first = mat.onBeforeCompile;
    f.patch(root);
    expect(mat.onBeforeCompile).toBe(first);
    mat.onBeforeCompile(litShader(), {});
    expect(prevCalls).toBe(1);
  });

  it('re-uploads the ground texture in place and swaps it for a new buffer', () => {
    const ground = hf();
    const f = new TileClutterFilter(ground, mask(), 4);
    const shader = litShader();
    patchOne(f).onBeforeCompile(shader, {});
    const tex: any = shader.uniforms.uClutterGround!.value;
    const version = tex.version;
    f.groundChanged(ground);
    expect(tex.version).toBe(version + 1);
    f.groundChanged(hf());
    expect(shader.uniforms.uClutterGround!.value).not.toBe(tex);
  });
});

describe('clutterMode hotkey', () => {
  it('is a hotkey bound to F on the keyboard', () => {
    expect(HOTKEY_ACTIONS).toContain('clutterMode');
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; }
    } as Storage;
    const table = new Bindings().table('keyboard');
    expect(table.clutterMode.some(b => b.kind === 'key' && b.code === 'KeyF')).toBe(true);
    expect(new Bindings().table('gamepad').clutterMode).toEqual([]);
  });
});

describe('facade snap (Best 3D)', () => {
  const N = 8;
  const grid = { cell: 10, half: 40, n: N };
  const box = (x0: number, z0: number, x1: number, z1: number) =>
    ({ min: new Vector3(x0, 0, z0), max: new Vector3(x1, 20, z1) });

  it('maps footprint cells to the box and a one-cell ring around it', () => {
    // inset box inside cells i=2..3, j=2 (x -19..-1, z -19..-11)
    const ids = snapIdGrid([box(-19, -19, -1, -11)], grid);
    expect(ids[2 * N + 2]).toBe(1);
    expect(ids[2 * N + 3]).toBe(1);
    expect(ids[1 * N + 2]).toBe(1); // ring south
    expect(ids[3 * N + 4]).toBe(1); // ring corner
    expect(ids[5 * N + 5]).toBe(0);
    expect(ids[0]).toBe(0);
  });

  it('a footprint cell beats a neighbour box ring', () => {
    const ids = snapIdGrid([box(-19, -19, -1, -11), box(1, -19, 19, -11)], grid);
    expect(ids[2 * N + 3]).toBe(1);
    expect(ids[2 * N + 4]).toBe(2);
  });

  it('injects the snap uniforms and vertex patch, off until enabled', () => {
    const f = new TileClutterFilter(hfSnap(), new Uint8Array(N * N), N);
    const mat = patchOne(f);
    const s = litShader();
    mat.onBeforeCompile(s, {});
    expect(s.uniforms.uSnap!.value).toBe(0);
    expect(s.uniforms.uSnapIds).toBeDefined();
    expect(s.uniforms.uSnapBoxes).toBeDefined();
    expect(s.vertexShader).toContain('vSnapped = 1.0');
    expect(s.fragmentShader).toContain('vSnapped < 0.999');
    f.snap = true;
    expect(s.uniforms.uSnap!.value).toBe(1);
    f.setSnapBoxes([box(-19, -19, -1, -11)], grid);
    expect((s.uniforms.uSnapIds!.value as { image: { width: number } }).image.width).toBe(N);
  });
});
