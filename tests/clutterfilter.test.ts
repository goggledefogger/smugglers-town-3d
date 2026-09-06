import { describe, it, expect } from 'vitest';
import { Heightfield } from '../src/core/heightfield.ts';
import { TileClutterFilter, CLUTTER_RISE_M } from '../src/render/TileClutterFilter.ts';
import { collidersFromRasters } from '../src/services/tiles/tileColliders.ts';
import { Bindings, HOTKEY_ACTIONS } from '../src/input/bindings.ts';

// a MeshStandardMaterial-shaped shader object, as three hands to onBeforeCompile
const litShader = () => ({
  uniforms: {} as Record<string, { value: unknown }>,
  vertexShader: '#include <normal_pars_vertex>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}',
  fragmentShader: 'void main() {}'
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
    expect(shader.fragmentShader).toBe('void main() {}');
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
