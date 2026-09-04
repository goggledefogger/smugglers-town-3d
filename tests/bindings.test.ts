import { describe, it, expect, beforeEach } from 'vitest';
import { Bindings, DEFAULTS_GAMEPAD, DEFAULTS_KEYBOARD } from '../src/input/bindings.ts';
import type { LogicalAction } from '../src/input/types.ts';

/** vitest runs in node, where localStorage is absent. The Bindings class
 *  guards on `typeof localStorage`, so it works but never persists; for the
 *  round-trip test we provide a real in-memory shim. */
function shimStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage: Storage }).localStorage = {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, v); },
    removeItem: k => { store.delete(k); },
    clear: () => store.clear(),
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; }
  } as Storage;
}

describe('Bindings', () => {
  let b: Bindings;
  beforeEach(() => {
    shimStorage();
    b = new Bindings();
  });

  it('loads the factory defaults for both devices', () => {
    const k = b.table('keyboard');
    expect(k.accelerate.some(x => x.kind === 'key' && x.code === 'KeyW')).toBe(true);
    const g = b.table('gamepad');
    // Stadia-friendly: A (index 0) accelerates
    expect(g.accelerate.some(x => x.kind === 'button' && x.index === 0)).toBe(true);
    // Y (index 3) jumps, not A
    expect(g.jump.some(x => x.kind === 'button' && x.index === 3)).toBe(true);
    // RT (index 7) also jumps (Danny's ask)
    expect(g.jump.some(x => x.kind === 'button' && x.index === 7)).toBe(true);
    // X (index 2) brakes, B (index 1) reverses — mapped from the PS2 layout
    expect(g.brake.some(x => x.kind === 'button' && x.index === 2)).toBe(true);
    expect(g.brake.some(x => x.kind === 'button' && x.index === 1)).toBe(true);
    // camera sits on Select (index 8), matching the PS2's SELECT=camera
    expect(g.camera).toEqual([{ kind: 'button', index: 8 }]);
  });

  it('rebinds an action on one device without touching the other', () => {
    b.rebind('keyboard', 'accelerate', { kind: 'key', code: 'KeyT' });
    const k = b.table('keyboard');
    expect(k.accelerate).toEqual([{ kind: 'key', code: 'KeyT' }]);
    // gamepad accelerate unchanged
    expect(b.table('gamepad').accelerate).toEqual(DEFAULTS_GAMEPAD.accelerate);
  });

  it('persists across a new instance (localStorage round-trip)', () => {
    b.rebind('gamepad', 'jump', { kind: 'button', index: 0 });
    const reloaded = new Bindings();
    expect(reloaded.table('gamepad').jump).toEqual([{ kind: 'button', index: 0 }]);
  });

  it('reset restores the factory defaults', () => {
    b.rebind('keyboard', 'jump' as LogicalAction, { kind: 'key', code: 'KeyJ' });
    b.reset();
    expect(b.table('keyboard').jump).toEqual(DEFAULTS_KEYBOARD.jump);
    expect(b.table('gamepad').accelerate).toEqual(DEFAULTS_GAMEPAD.accelerate);
  });

  it('falls back to defaults when stored JSON is corrupt', () => {
    localStorage.setItem('stt.bindings', 'not json');
    const reloaded = new Bindings();
    expect(reloaded.table('keyboard').accelerate).toEqual(DEFAULTS_KEYBOARD.accelerate);
  });

  it('falls back to defaults when stored JSON is missing actions', () => {
    // a table that's valid JSON but missing most actions should be rejected
    localStorage.setItem('stt.bindings', JSON.stringify({ keyboard: { accelerate: [] }, gamepad: {} }));
    const reloaded = new Bindings();
    expect(reloaded.table('keyboard').accelerate).toEqual(DEFAULTS_KEYBOARD.accelerate);
  });

  it('rejects an un-versioned save (stale layout from before schema versioning)', () => {
    // a save from the pre-redesign code: no `v` field, and A (index 0) mapped
    // to jump. It must NOT survive — the corrected default has A→accelerate.
    const stale = {
      keyboard: structuredClone(DEFAULTS_KEYBOARD),
      gamepad: { ...structuredClone(DEFAULTS_GAMEPAD), jump: [{ kind: 'button' as const, index: 0 }] }
    };
    localStorage.setItem('stt.bindings', JSON.stringify(stale));
    const reloaded = new Bindings();
    // defaults win: A accelerates, Y (3) jumps
    expect(reloaded.table('gamepad').accelerate).toEqual(DEFAULTS_GAMEPAD.accelerate);
    expect(reloaded.table('gamepad').jump).toEqual(DEFAULTS_GAMEPAD.jump);
  });

  it('rejects a save from the previous schema version (v:1)', () => {
    // v:1 had RT on accelerate and X on camera; v:2 moves RT to jump and
    // camera to Select. A v:1 save must be rejected so the v:2 defaults win.
    const v1 = {
      v: 1,
      keyboard: structuredClone(DEFAULTS_KEYBOARD),
      gamepad: {
        accelerate: [{ kind: 'button' as const, index: 0 }, { kind: 'button' as const, index: 7 }],
        brake: [{ kind: 'button' as const, index: 1 }, { kind: 'button' as const, index: 6 }],
        steerLeft: [{ kind: 'axis' as const, index: 0, sign: -1 as const }, { kind: 'button' as const, index: 14 }],
        steerRight: [{ kind: 'axis' as const, index: 0, sign: 1 as const }, { kind: 'button' as const, index: 15 }],
        jump: [{ kind: 'button' as const, index: 3 }],
        pitchUp: [{ kind: 'axis' as const, index: 3, sign: -1 as const }],
        pitchDown: [{ kind: 'axis' as const, index: 3, sign: 1 as const }],
        camera: [{ kind: 'button' as const, index: 2 }],
        reset: [{ kind: 'button' as const, index: 9 }],
        uiUp: [{ kind: 'button' as const, index: 12 }, { kind: 'axis' as const, index: 1, sign: -1 as const }],
        uiDown: [{ kind: 'button' as const, index: 13 }, { kind: 'axis' as const, index: 1, sign: 1 as const }],
        uiLeft: [{ kind: 'button' as const, index: 14 }, { kind: 'axis' as const, index: 0, sign: -1 as const }],
        uiRight: [{ kind: 'button' as const, index: 15 }, { kind: 'axis' as const, index: 0, sign: 1 as const }],
        uiConfirm: [{ kind: 'button' as const, index: 0 }],
        uiBack: [{ kind: 'button' as const, index: 1 }],
        uiTab: [],
        uiPause: [{ kind: 'button' as const, index: 9 }]
      }
    };
    localStorage.setItem('stt.bindings', JSON.stringify(v1));
    const reloaded = new Bindings();
    // v:2 defaults win: RT (7) is now jump, camera is on Select (8)
    expect(reloaded.table('gamepad').jump).toEqual(DEFAULTS_GAMEPAD.jump);
    expect(reloaded.table('gamepad').camera).toEqual([{ kind: 'button', index: 8 }]);
  });

  it('rejects a save with the wrong schema version', () => {
    const future = {
      v: 999,
      keyboard: structuredClone(DEFAULTS_KEYBOARD),
      gamepad: { ...structuredClone(DEFAULTS_GAMEPAD), jump: [{ kind: 'button' as const, index: 0 }] }
    };
    localStorage.setItem('stt.bindings', JSON.stringify(future));
    const reloaded = new Bindings();
    expect(reloaded.table('gamepad').jump).toEqual(DEFAULTS_GAMEPAD.jump);
  });

  it('notifies onChange listeners on rebind and reset', () => {
    let calls = 0;
    const off = b.onChange(() => { calls++; });
    b.rebind('keyboard', 'accelerate', { kind: 'key', code: 'KeyT' });
    b.reset();
    expect(calls).toBe(2);
    off();
    b.rebind('keyboard', 'accelerate', { kind: 'key', code: 'KeyY' });
    expect(calls).toBe(2);
  });
});
