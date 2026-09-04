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
