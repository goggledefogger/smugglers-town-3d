import { describe, it, expect, beforeEach, vi } from 'vitest';import { GamepadSource } from '../src/input/GamepadSource.ts';
import { Bindings } from '../src/input/bindings.ts';

/**
 * GamepadSource polls navigator.getGamepads() each frame. We stub that to
 * return a hand-built pad snapshot, so the binding-to-input logic is tested
 * without a real device or a gamepad-capable DOM.
 */

function makePad(over: { axes?: number[]; buttons?: { value: number; pressed: boolean }[] }): Gamepad {
  const axes = over.axes ?? [0, 0, 0, 0];
  const buttons = over.buttons ?? Array.from({ length: 16 }, () => ({ value: 0, pressed: false }));
  return {
    axes, buttons, connected: true, id: 'test', index: 0, mapping: 'standard',
    timestamp: 0, vibrationActuator: null
  } as unknown as Gamepad;
}

function padAt(over: Parameters<typeof makePad>[0]): void {
  // node has a `navigator` (Node 22) but no getGamepads; define it for the test
  Object.defineProperty(navigator, 'getGamepads', {
    value: vi.fn(() => [makePad(over)]),
    configurable: true
  });
}

describe('GamepadSource', () => {
  let b: Bindings;
  let g: GamepadSource;
  beforeEach(() => {
    // vitest runs in node; Bindings guards on localStorage, but give it a real
    // one so rebinds persist within the test
    const store = new Map<string, string>();
    (globalThis as { localStorage: Storage }).localStorage = {
      getItem: k => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v); },
      removeItem: k => { store.delete(k); },
      clear: () => store.clear(),
      key: i => [...store.keys()][i] ?? null,
      get length() { return store.size; }
    } as Storage;
    if (typeof navigator.getGamepads !== 'function') {
      Object.defineProperty(navigator, 'getGamepads', { value: vi.fn(() => []), configurable: true });
    }
    b = new Bindings();
    g = new GamepadSource(b);
  });

  it('yields all-zero input from an untouched pad', () => {
    padAt({});
    expect(g.vehicleInput()).toEqual({ throttle: 0, brake: 0, steer: 0, jump: false, pitch: 0 });
  });

  it('A button accelerates (Stadia default)', () => {
    const buttons = Array.from({ length: 16 }, () => ({ value: 0, pressed: false }));
    buttons[0] = { value: 1, pressed: true };
    padAt({ buttons });
    expect(g.vehicleInput().throttle).toBe(1);
  });

  it('LT (index 6) gives analog brake', () => {
    const buttons = Array.from({ length: 16 }, () => ({ value: 0, pressed: false }));
    buttons[6] = { value: 0.6, pressed: false }; // analog, not pressed
    padAt({ buttons });
    expect(g.vehicleInput().brake).toBeCloseTo(0.6, 5);
  });

  it('a trigger under the deadzone reads as zero', () => {
    const buttons = Array.from({ length: 16 }, () => ({ value: 0, pressed: false }));
    buttons[6] = { value: 0.03, pressed: false };
    padAt({ buttons });
    expect(g.vehicleInput().brake).toBe(0);
  });

  it('left stick right steers right (negative)', () => {
    padAt({ axes: [0.7, 0, 0, 0] });
    expect(g.vehicleInput().steer).toBeCloseTo(-0.7, 5);
  });

  it('left stick left steers left (positive)', () => {
    padAt({ axes: [-0.5, 0, 0, 0] });
    expect(g.vehicleInput().steer).toBeCloseTo(0.5, 5);
  });

  it('stick inside the deadzone reads as centered', () => {
    padAt({ axes: [-0.1, 0, 0, 0] });
    expect(g.vehicleInput().steer).toBe(0);
  });

  it('Y (index 3) jumps, not A', () => {
    const buttons = Array.from({ length: 16 }, () => ({ value: 0, pressed: false }));
    buttons[3] = { value: 1, pressed: true };
    padAt({ buttons });
    expect(g.vehicleInput().jump).toBe(true);
  });

  it('RT (index 7) also jumps', () => {
    const buttons = Array.from({ length: 16 }, () => ({ value: 0, pressed: false }));
    buttons[7] = { value: 1, pressed: true };
    padAt({ buttons });
    expect(g.vehicleInput().jump).toBe(true);
  });

  it('right stick up pitches nose up (positive)', () => {
    padAt({ axes: [0, 0, 0, -0.8] });
    expect(g.vehicleInput().pitch).toBeCloseTo(0.8, 5);
  });

  it('dpad-up fires a uiUp edge once, not while held', () => {
    const up = { value: 1, pressed: true };
    padAt({ buttons: withButton(12, up) });
    g.poll();  // poll detects the down-edge
    expect(g.drainUiActions()).toEqual(['up']);
    // still held: no repeat
    g.poll();
    expect(g.drainUiActions()).toEqual([]);
    // release and re-press: fires again
    padAt({});
    g.poll();
    padAt({ buttons: withButton(12, up) });
    g.poll();
    expect(g.drainUiActions()).toEqual(['up']);
  });

  it('A fires a confirm edge for menus', () => {
    padAt({ buttons: withButton(0, { value: 1, pressed: true }) });
    g.poll();
    expect(g.drainUiActions()).toContain('confirm');
  });

  it('a resting pad produces no UI edges', () => {
    padAt({});
    g.poll();
    expect(g.drainUiActions()).toEqual([]);
  });

  it('fires UI edges from poll() even when vehicleInput is never called (menus)', () => {
    // the bug this guards against: menus never poll vehicleInput, so an edge
    // scan that lived in vehicleInput would never run while a menu is open
    padAt({ buttons: withButton(0, { value: 1, pressed: true }) });
    g.poll();
    expect(g.drainUiActions()).toContain('confirm');
    // and the analog driving state is untouched — poll doesn't read it
    padAt({ axes: [0.7, 0, 0, 0] });
    g.poll();
    expect(g.drainUiActions()).toEqual(['right']);
  });

  it('respects a rebind: if jump is rebound to button 1, button 1 jumps', () => {
    b.rebind('gamepad', 'jump', { kind: 'button', index: 1 });
    padAt({ buttons: withButton(1, { value: 1, pressed: true }) });
    expect(g.vehicleInput().jump).toBe(true);
    // and the old Y binding no longer jumps
    padAt({ buttons: withButton(3, { value: 1, pressed: true }) });
    expect(g.vehicleInput().jump).toBe(false);
  });
});

function withButton(i: number, btn: { value: number; pressed: boolean }) {
  const buttons = Array.from({ length: 16 }, () => ({ value: 0, pressed: false }));
  buttons[i] = btn;
  return buttons;
}
