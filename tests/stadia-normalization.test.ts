import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GamepadSource } from '../src/input/GamepadSource.ts';
import { Bindings } from '../src/input/bindings.ts';
import {
  isStadiaController,
  getGamepadDisplayName,
  decodeHatSwitch,
  normalizeTriggerAxis
} from '../src/input/gamepadNormalization.ts';

describe('Stadia Controller & Gamepad Normalization', () => {
  it('identifies Stadia controller from various browser ID formats', () => {
    // Chrome on Windows/macOS
    expect(isStadiaController('Google LLC Stadia Controller rev. A (STANDARD GAMEPAD Vendor: 18d1 Product: 9400)')).toBe(true);
    // Firefox on Windows DirectInput
    expect(isStadiaController('18d1-9400-Google LLC Stadia Controller rev. A')).toBe(true);
    // Generic Stadia
    expect(isStadiaController('Stadia Controller')).toBe(true);
    // Non-Stadia controllers
    expect(isStadiaController('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe(false);
    expect(isStadiaController('Wireless Controller (Vendor: 054c Product: 0ce6)')).toBe(false);
  });

  it('provides clean display names for known controllers', () => {
    expect(getGamepadDisplayName('18d1-9400-Google LLC Stadia Controller rev. A')).toBe('Google Stadia Controller');
    expect(getGamepadDisplayName('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('Xbox Controller');
    expect(getGamepadDisplayName('Sony Interactive Entertainment DualSense Wireless Controller')).toBe('PlayStation Controller');
    expect(getGamepadDisplayName('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)')).toBe('Nintendo Switch Pro Controller');
  });

  it('decodes POV hat switch axes accurately', () => {
    // Centered / released
    expect(decodeHatSwitch(1.28)).toEqual({ up: false, down: false, left: false, right: false });
    expect(decodeHatSwitch(-2.0)).toEqual({ up: false, down: false, left: false, right: false });

    // 8 Cardinal & diagonal directions
    expect(decodeHatSwitch(-1.0)).toEqual({ up: true, down: false, left: false, right: false });
    expect(decodeHatSwitch(-0.71)).toEqual({ up: true, down: false, left: false, right: true });
    expect(decodeHatSwitch(-0.43)).toEqual({ up: false, down: false, left: false, right: true });
    expect(decodeHatSwitch(-0.14)).toEqual({ up: false, down: true, left: false, right: true });
    expect(decodeHatSwitch(0.14)).toEqual({ up: false, down: true, left: false, right: false });
    expect(decodeHatSwitch(0.43)).toEqual({ up: false, down: true, left: true, right: false });
    expect(decodeHatSwitch(0.71)).toEqual({ up: false, down: false, left: true, right: false });
    expect(decodeHatSwitch(1.0)).toEqual({ up: true, down: false, left: true, right: false });
  });

  it('normalizes trigger axis resting at -1.0 to [0, 1] without false braking', () => {
    const padId = 'stadia-test-pad';
    // When resting at -1.0, should normalize to 0
    expect(normalizeTriggerAxis(padId, 4, -1.0)).toBe(0);
    // Half pressed (around 0.0)
    expect(normalizeTriggerAxis(padId, 4, 0.0)).toBeCloseTo(0.5, 2);
    // Fully squeezed (+1.0)
    expect(normalizeTriggerAxis(padId, 4, 1.0)).toBe(1);
  });
});

describe('Non-standard Firefox Bluetooth Stadia Controller Emulation', () => {
  let b: Bindings;
  let g: GamepadSource;

  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage: Storage }).localStorage = {
      getItem: k => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v); },
      removeItem: k => { store.delete(k); },
      clear: () => store.clear(),
      key: i => [...store.keys()][i] ?? null,
      get length() { return store.size; }
    } as Storage;
    b = new Bindings();
    g = new GamepadSource(b);
  });

  function makeRawStadiaPad(over: {
    rawButtons?: { value: number; pressed: boolean }[];
    rawAxes?: number[];
  }): Gamepad {
    const rawButtons = over.rawButtons ?? Array.from({ length: 17 }, () => ({ value: 0, pressed: false }));
    const rawAxes = over.rawAxes ?? [0, 0, 0, 0, -1, -1]; // axes 4 and 5 are LT and RT resting at -1
    return {
      id: '18d1-9400-Google LLC Stadia Controller rev. A',
      index: 0,
      connected: true,
      mapping: '', // Non-standard mapping in Firefox
      axes: rawAxes,
      buttons: rawButtons,
      timestamp: 0,
      vibrationActuator: null
    } as unknown as Gamepad;
  }

  function stubGamepads(pads: Gamepad[]): void {
    Object.defineProperty(navigator, 'getGamepads', {
      value: vi.fn(() => pads),
      configurable: true
    });
  }

  it('correctly maps A (raw button 0) to accelerate', () => {
    const rawButtons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false }));
    rawButtons[0] = { value: 1, pressed: true };
    stubGamepads([makeRawStadiaPad({ rawButtons })]);

    const v = g.vehicleInput();
    expect(v.throttle).toBe(1);
  });

  it('correctly maps raw LT trigger on axis 4 to analog brake', () => {
    // Left Trigger squeezed halfway: axis 4 = 0.0 (in [-1, 1] range)
    stubGamepads([makeRawStadiaPad({ rawAxes: [0, 0, 0, 0, 0.2, -1] })]);

    const v = g.vehicleInput();
    expect(v.brake).toBeCloseTo(0.6, 2);
  });

  it('ensures raw button 6 (Start on Stadia) triggers pause and does NOT brake', () => {
    // In raw mode, button 6 is physical Start. In standard mapping, button 6 is LT (Brake).
    // Without normalization, pressing Start would brake!
    const rawButtons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false }));
    rawButtons[6] = { value: 1, pressed: true };
    stubGamepads([makeRawStadiaPad({ rawButtons })]);

    const v = g.vehicleInput();
    expect(v.brake).toBe(0); // must NOT brake

    g.poll();
    const ui = g.drainUiActions();
    expect(ui).toContain('pause'); // must trigger pause (Start is bound to pause)
  });

  it('correctly maps raw button 4 (Select/Options) to camera hotkey', () => {
    // Raw button 4 is Select on Stadia. Standard mapping is button 8.
    const rawButtons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false }));
    rawButtons[4] = { value: 1, pressed: true };
    stubGamepads([makeRawStadiaPad({ rawButtons })]);

    g.poll();
    const hot = g.drainHotkeys();
    expect(hot).toContain('camera');
  });

  it('correctly maps raw buttons 11-14 to D-Pad Up/Down/Left/Right', () => {
    const rawButtons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false }));
    // Raw 11 is D-Pad Up
    rawButtons[11] = { value: 1, pressed: true };
    stubGamepads([makeRawStadiaPad({ rawButtons })]);

    g.poll();
    expect(g.drainUiActions()).toContain('up');
  });

  it('correctly maps POV hat switch axis to D-Pad if digital buttons are absent', () => {
    // Emulate raw driver where buttons 11-14 are missing, and D-Pad is on axis 6
    const rawButtons = Array.from({ length: 10 }, () => ({ value: 0, pressed: false }));
    // Axis 6 = 0.14 (Down)
    const rawAxes = [0, 0, 0, 0, -1, -1, 0.14];
    stubGamepads([makeRawStadiaPad({ rawButtons, rawAxes })]);

    g.poll();
    expect(g.drainUiActions()).toContain('down');
  });
});

describe('Windows Multi-Gamepad Trap Resolution', () => {
  let b: Bindings;
  let g: GamepadSource;

  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage: Storage }).localStorage = {
      getItem: k => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v); },
      removeItem: k => { store.delete(k); },
      clear: () => store.clear(),
      key: i => [...store.keys()][i] ?? null,
      get length() { return store.size; }
    } as Storage;
    b = new Bindings();
    g = new GamepadSource(b);
  });

  it('bypasses idle virtual gamepad at index 0 and reads active controller at index 1', () => {
    // Index 0: Virtual Steam Input / vJoy device sitting connected with 0 input
    const idleVirtualPad = {
      id: 'vJoy Virtual Joystick',
      index: 0,
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 16 }, () => ({ value: 0, pressed: false })),
      timestamp: 0
    } as unknown as Gamepad;

    // Index 1: Real Bluetooth Stadia controller with A button pressed
    const activeStadiaButtons = Array.from({ length: 16 }, () => ({ value: 0, pressed: false }));
    activeStadiaButtons[0] = { value: 1, pressed: true };
    const activeStadiaPad = {
      id: 'Google LLC Stadia Controller rev. A',
      index: 1,
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: activeStadiaButtons,
      timestamp: 0
    } as unknown as Gamepad;

    Object.defineProperty(navigator, 'getGamepads', {
      value: vi.fn(() => [idleVirtualPad, activeStadiaPad]),
      configurable: true
    });

    const v = g.vehicleInput();
    expect(v.throttle).toBe(1);

    const activeInfo = g.getActivePad();
    expect(activeInfo?.name).toBe('Google Stadia Controller');
  });

  it('switches active controller dynamically when user moves another pad', () => {
    const pad0Buttons = Array.from({ length: 16 }, () => ({ value: 0, pressed: false }));
    const pad1Buttons = Array.from({ length: 16 }, () => ({ value: 0, pressed: false }));

    const pad0 = {
      id: 'Xbox 360 Controller',
      index: 0,
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: pad0Buttons,
      timestamp: 0
    } as unknown as Gamepad;

    const pad1 = {
      id: 'Stadia Controller',
      index: 1,
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: pad1Buttons,
      timestamp: 0
    } as unknown as Gamepad;

    // First, pad 0 presses A
    pad0Buttons[0] = { value: 1, pressed: true };
    Object.defineProperty(navigator, 'getGamepads', {
      value: vi.fn(() => [pad0, pad1]),
      configurable: true
    });

    expect(g.getActivePad()?.name).toBe('Xbox Controller');
    expect(g.vehicleInput().throttle).toBe(1);

    // Now pad 0 releases, and pad 1 steers left
    pad0Buttons[0] = { value: 0, pressed: false };
    (pad1 as any).axes = [-0.8, 0, 0, 0];

    expect(g.vehicleInput().steer).toBeCloseTo(0.8, 2);
    expect(g.getActivePad()?.name).toBe('Google Stadia Controller');
  });

  it('prefers physical controller over virtual joystick when neither is touched', () => {
    const idleVirtualPad = {
      id: 'vJoy Virtual Joystick',
      index: 0,
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 16 }, () => ({ value: 0, pressed: false })),
      timestamp: 0
    } as unknown as Gamepad;

    const idleXboxPad = {
      id: 'Xbox Controller',
      index: 1,
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 16 }, () => ({ value: 0, pressed: false })),
      timestamp: 0
    } as unknown as Gamepad;

    Object.defineProperty(navigator, 'getGamepads', {
      value: vi.fn(() => [idleVirtualPad, idleXboxPad]),
      configurable: true
    });

    const activeInfo = g.getActivePad();
    expect(activeInfo?.name).toBe('Xbox Controller');
  });
});
