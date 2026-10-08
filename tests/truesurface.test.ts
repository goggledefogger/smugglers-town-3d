import { describe, it, expect } from 'vitest';
import { Heightfield } from '../src/core/heightfield.ts';
import {
  SurfaceHeightfield, shouldRecapture, SURF_ENCODE_OFFSET, SURF_RECAPTURE_MS, type RecaptureState
} from '../src/core/terrain/SurfaceHeightfield.ts';
import { Bindings, HOTKEY_ACTIONS } from '../src/input/bindings.ts';

// a flat base at y = 10 over a 1000 m field; a 64 m window of 64 one-metre texels at the origin
const flatBase = (): Heightfield => new Heightfield(1000, 4, new Float32Array(25).fill(10));
const RES = 64, EXT = 64;
const capture = (y: number): Float32Array => new Float32Array(RES * RES).fill(y + SURF_ENCODE_OFFSET);

function field(roads: ((x: number, z: number) => boolean) | null = null): SurfaceHeightfield {
  return new SurfaceHeightfield(flatBase(), roads, { extentM: EXT, res: RES, edgeFade: 4 });
}

describe('SurfaceHeightfield.sample', () => {
  it('is the base until a capture lands, and outside the window after', () => {
    const f = field();
    expect(f.sample(0, 0)).toBe(10);
    f.ingest(0, 0, capture(10.4));
    expect(f.sample(200, 0)).toBe(10);
  });

  it('returns the captured surface inside the band', () => {
    const f = field();
    f.ingest(0, 0, capture(10.4));
    expect(f.sample(0, 0)).toBeCloseTo(10.4, 3);
    expect(f.sample(-7.3, 11.1)).toBeCloseTo(10.4, 3);
  });

  it('returns the base where the capture is a wall or roof (outside the band) or was never drawn', () => {
    const f = field();
    f.ingest(0, 0, capture(25));
    expect(f.sample(0, 0)).toBe(10);
    f.ingest(0, 0, new Float32Array(RES * RES)); // the clear value
    expect(f.sample(0, 0)).toBe(10);
  });

  it('caps road cells at the base plus the road cap (canopy over a street)', () => {
    const f = field(x => x < 0);
    f.ingest(0, 0, capture(11.2));
    expect(f.sample(-10, 0)).toBeCloseTo(10.5, 3);
    expect(f.sample(10, 0)).toBeCloseTo(11.2, 3);
  });

  it('tracks the live base: refinement written into it flows through', () => {
    const base = flatBase();
    const f = new SurfaceHeightfield(base, null, { extentM: EXT, res: RES, edgeFade: 4 });
    f.ingest(0, 0, capture(10.4));
    base.copyFrom(new Heightfield(1000, 4, new Float32Array(25).fill(12)));
    expect(f.sample(0, 0)).toBeCloseTo(12.4, 3); // the delta rides the new base until recapture
  });

  it('processes in slices and swaps whole', () => {
    let t = 0;
    const f = new SurfaceHeightfield(flatBase(), null, { extentM: EXT, res: RES, edgeFade: 4, now: () => (t += 1) });
    f.readBuffer.set(capture(10.4));
    f.beginProcess(0, 0);
    expect(f.step(0)).toBe(false);
    expect(f.hasCapture).toBe(false);
    while (!f.step(0)) { /* slice */ }
    expect(f.sample(0, 0)).toBeCloseTo(10.4, 3);
  });
});

describe('shouldRecapture', () => {
  const s: RecaptureState = {
    nowMs: 10_000, lastCaptureMs: 5_000, hasCapture: true, busy: false,
    centerX: 0, centerZ: 0, playerX: 0, playerZ: 0, extentM: 768, dirty: false
  };
  it('captures when there is none, not while busy', () => {
    expect(shouldRecapture({ ...s, hasCapture: false })).toBe(true);
    expect(shouldRecapture({ ...s, hasCapture: false, busy: true })).toBe(false);
  });
  it('recaptures past a quarter of the window, or when dirty', () => {
    expect(shouldRecapture(s)).toBe(false);
    expect(shouldRecapture({ ...s, playerX: 150 })).toBe(false);
    expect(shouldRecapture({ ...s, playerX: 150, playerZ: 150 })).toBe(true);
    expect(shouldRecapture({ ...s, dirty: true })).toBe(true);
  });
  it('throttles to one capture per interval', () => {
    const recent = { ...s, lastCaptureMs: s.nowMs - SURF_RECAPTURE_MS + 1 };
    expect(shouldRecapture({ ...recent, dirty: true, playerX: 500 })).toBe(false);
    expect(shouldRecapture({ ...recent, hasCapture: false })).toBe(false);
  });
});

describe('surfaceMode hotkey', () => {
  it('is a hotkey on U by default, unbound on the gamepad', () => {
    expect(HOTKEY_ACTIONS).toContain('surfaceMode');
    const b = new Bindings(); // node: no localStorage, so the defaults
    expect(b.table('keyboard').surfaceMode).toEqual([{ kind: 'key', code: 'KeyU' }]);
    expect(b.table('gamepad').surfaceMode).toEqual([]);
  });

  it('a save from before surfaceMode existed falls back to the defaults', () => {
    const fresh = new Bindings();
    const keyboard: Record<string, unknown> = { ...fresh.table('keyboard'), jump: [{ kind: 'key', code: 'KeyQ' }] };
    const gamepad: Record<string, unknown> = { ...fresh.table('gamepad') };
    delete keyboard.surfaceMode;
    delete gamepad.surfaceMode;
    const store = new Map([['stt.bindings', JSON.stringify({ v: 4, keyboard, gamepad })]]);
    const prev = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); }
    };
    try {
      const b = new Bindings();
      expect(b.table('keyboard').surfaceMode).toEqual([{ kind: 'key', code: 'KeyU' }]);
      expect(b.table('keyboard').jump).toEqual(fresh.table('keyboard').jump);
    } finally {
      (globalThis as any).localStorage = prev;
    }
  });
});
