/**
 * Bindings: a physical control on a specific device, mapped to a
 * `LogicalAction`. Data, not code — the default table is Stadia-friendly and
 * every entry is rebindable from the settings screen, persisted to
 * localStorage so a player's layout survives a reload.
 *
 * A binding is one of:
 *  - a keyboard key (`KeyW`, `Space`, `ArrowUp`…)
 *  - a gamepad button by standard-mapping index (A=0, B=1, …, with analog
 *    `.value` for triggers)
 *  - a gamepad axis by index + sign (left stick X is axis 0, sign -1 = left)
 */

import type { LogicalAction } from './types.ts';

export type DeviceKind = 'keyboard' | 'gamepad';

/** One physical control bound to one logical action. */
export interface KeyBinding { readonly kind: 'key'; readonly code: string }
export interface ButtonBinding { readonly kind: 'button'; readonly index: number }
export interface AxisBinding { readonly kind: 'axis'; readonly index: number; readonly sign: 1 | -1 }

export type Binding = KeyBinding | ButtonBinding | AxisBinding;

/** The full table for one device. Multiple bindings can map to one action
 *  (e.g. accelerate = A button *and* RT trigger). */
export type BindingTable = Record<LogicalAction, Binding[]>;

/** Which `LogicalAction`s each binding feeds. */
export const DRIVING_ACTIONS: readonly LogicalAction[] = [
  'accelerate', 'brake', 'steerLeft', 'steerRight', 'jump', 'pitchUp', 'pitchDown'
];
export const HOTKEY_ACTIONS: readonly LogicalAction[] = ['camera', 'reset'];
export const UI_ACTIONS: readonly LogicalAction[] = [
  'uiUp', 'uiDown', 'uiLeft', 'uiRight', 'uiConfirm', 'uiBack', 'uiTab', 'uiPause'
];

export const ALL_ACTIONS: readonly LogicalAction[] = [
  ...DRIVING_ACTIONS, ...HOTKEY_ACTIONS, ...UI_ACTIONS
];

const DEFAULTS_KEYBOARD: BindingTable = {
  accelerate: [{ kind: 'key', code: 'KeyW' }, { kind: 'key', code: 'ArrowUp' }],
  brake: [{ kind: 'key', code: 'KeyS' }, { kind: 'key', code: 'ArrowDown' }],
  steerLeft: [{ kind: 'key', code: 'KeyA' }, { kind: 'key', code: 'ArrowLeft' }],
  steerRight: [{ kind: 'key', code: 'KeyD' }, { kind: 'key', code: 'ArrowRight' }],
  jump: [{ kind: 'key', code: 'Space' }],
  // pitch has no dedicated key; the sim reuses accelerate/brake while airborne.
  // These are empty so keyboard pitch falls out of accel/brake in the source.
  pitchUp: [],
  pitchDown: [],
  camera: [{ kind: 'key', code: 'KeyC' }],
  reset: [{ kind: 'key', code: 'KeyR' }],
  uiUp: [{ kind: 'key', code: 'ArrowUp' }],
  uiDown: [{ kind: 'key', code: 'ArrowDown' }],
  uiLeft: [{ kind: 'key', code: 'ArrowLeft' }],
  uiRight: [{ kind: 'key', code: 'ArrowRight' }],
  uiConfirm: [{ kind: 'key', code: 'Enter' }],
  uiBack: [{ kind: 'key', code: 'Escape' }],
  uiTab: [{ kind: 'key', code: 'Tab' }],
  uiPause: [{ kind: 'key', code: 'KeyP' }]
};

// Stadia-friendly: A = accelerate (Danny's ask), B = brake, Y = jump, X = camera.
// Triggers RT/LT are analog throttle/brake on top of the face buttons.
// Standard Gamepad mapping indices.
const DEFAULTS_GAMEPAD: BindingTable = {
  accelerate: [{ kind: 'button', index: 0 }, { kind: 'button', index: 7 }],   // A + RT
  brake: [{ kind: 'button', index: 1 }, { kind: 'button', index: 6 }],        // B + LT
  steerLeft: [{ kind: 'axis', index: 0, sign: -1 }, { kind: 'button', index: 14 }], // stick L + dpad-left
  steerRight: [{ kind: 'axis', index: 0, sign: 1 }, { kind: 'button', index: 15 }], // stick R + dpad-right
  jump: [{ kind: 'button', index: 3 }],                                         // Y
  pitchUp: [{ kind: 'axis', index: 3, sign: -1 }],   // right stick up = nose up
  pitchDown: [{ kind: 'axis', index: 3, sign: 1 }],  // right stick down = nose down
  camera: [{ kind: 'button', index: 2 }],          // X
  reset: [{ kind: 'button', index: 9 }],            // Start/Options
  uiUp: [{ kind: 'button', index: 12 }, { kind: 'axis', index: 1, sign: -1 }],   // dpad-up + stick up
  uiDown: [{ kind: 'button', index: 13 }, { kind: 'axis', index: 1, sign: 1 }],  // dpad-down + stick down
  uiLeft: [{ kind: 'button', index: 14 }, { kind: 'axis', index: 0, sign: -1 }], // dpad-left + stick left
  uiRight: [{ kind: 'button', index: 15 }, { kind: 'axis', index: 0, sign: 1 }], // dpad-right + stick right
  uiConfirm: [{ kind: 'button', index: 0 }],   // A
  uiBack: [{ kind: 'button', index: 1 }],      // B
  uiTab: [],
  uiPause: [{ kind: 'button', index: 9 }]      // Start
};

const STORAGE_KEY = 'stt.bindings';
/**
 * Bump when the default table or the saved shape changes. A saved blob whose
 * `v` doesn't match is rejected and the defaults load — so a stale save from
 * an older default (e.g. the pre-redesign layout that mapped A→jump) can't
 * override the corrected defaults. Forward-compatible: bumping re-invalidates.
 */
const SCHEMA_VERSION = 1;

export interface SavedBindings {
  readonly keyboard: BindingTable;
  readonly gamepad: BindingTable;
}

export class Bindings {
  private keyboard: BindingTable;
  private gamepad: BindingTable;
  private readonly listeners = new Set<() => void>();

  constructor() {
    const loaded = this.load();
    this.keyboard = loaded.keyboard;
    this.gamepad = loaded.gamepad;
  }

  table(kind: DeviceKind): BindingTable {
    return kind === 'keyboard' ? this.keyboard : this.gamepad;
  }

  /** Replace the binding for `action` on `kind`. */
  rebind(kind: DeviceKind, action: LogicalAction, binding: Binding): void {
    const table = kind === 'keyboard' ? this.keyboard : this.gamepad;
    table[action] = [binding];
    this.save();
    this.emit();
  }

  /** Restore the factory defaults for both devices. */
  reset(): void {
    this.keyboard = structuredClone(DEFAULTS_KEYBOARD);
    this.gamepad = structuredClone(DEFAULTS_GAMEPAD);
    this.save();
    this.emit();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private load(): SavedBindings {
    const fallback: SavedBindings = {
      keyboard: structuredClone(DEFAULTS_KEYBOARD),
      gamepad: structuredClone(DEFAULTS_GAMEPAD)
    };
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw) as { v?: number; keyboard?: BindingTable; gamepad?: BindingTable };
      // reject any save from a different schema version — its indices may belong
      // to an older default (e.g. A→jump) we've since corrected
      if (parsed.v !== SCHEMA_VERSION) return fallback;
      // shallow-validate: only accept if every action is present in each table
      if (parsed.keyboard && parsed.gamepad
          && ALL_ACTIONS.every(a => Array.isArray(parsed.keyboard![a]))
          && ALL_ACTIONS.every(a => Array.isArray(parsed.gamepad![a]))) {
        return { keyboard: parsed.keyboard, gamepad: parsed.gamepad };
      }
    } catch { /* corrupt JSON: fall through to defaults */ }
    return fallback;
  }

  private save(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: SCHEMA_VERSION,
      keyboard: this.keyboard,
      gamepad: this.gamepad
    }));
  }
}

export { DEFAULTS_KEYBOARD, DEFAULTS_GAMEPAD };
