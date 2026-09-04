/**
 * Gamepad input as an `InputSource`. The Gamepad API is poll-based —
 * `gamepadconnected` only tells you a pad exists; button/axis state advances
 * when you call `navigator.getGamepads()`, once per frame. So `vehicleInput`
 * and the edge scan both run off that poll, in the same frame the keyboard
 * is read.
 *
 * The edge scan lives in `poll()`, not `vehicleInput()`, because menus never
 * call `vehicleInput` (nothing is driving) — a gamepad confirm pressed on the
 * garage screen would never be detected if the scan waited for a driving
 * frame. `poll()` runs every frame; `vehicleInput()` only while driving.
 *
 * Bindings resolve standard-mapping indices to `LogicalAction`s. A trigger
 * bound to `accelerate` contributes its analog `.value` (0..1) as partial
 * throttle; a face button bound to `accelerate` contributes 1 when pressed.
 * Axis steer/pitch pass through a deadzone. Dpad and stick directions
 * bound to UI actions fire once on the down-edge (the stick must leave
 * the deadzone and come back to fire again — no auto-repeat).
 */

import type { VehicleInput } from '../core/physics/vehicleStats.ts';
import type { InputSource, UiAction, Hotkey, LogicalAction } from './types.ts';
import type { Bindings, BindingTable, Binding } from './bindings.ts';
import { logger } from '../app/log.ts';

const log = logger('input');

/** Below this magnitude an axis reads as centered — resting sticks jitter. */
const STICK_DEADZONE = 0.18;
/** Trigger value below which the pedal reads as released — L2/R2 jitter. */
const TRIGGER_DEADZONE = 0.05;
/** Stick direction (for UI nav) must exceed this to count as an edge. */
const UI_STICK_DEADZONE = 0.5;

interface PadSnapshot {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly value: number; readonly pressed: boolean }[];
}

const UI_OF: Partial<Record<LogicalAction, UiAction>> = {
  uiUp: 'up', uiDown: 'down', uiLeft: 'left', uiRight: 'right',
  uiConfirm: 'confirm', uiBack: 'back', uiTab: 'tab', uiPause: 'pause'
};
const HOTKEY_OF: Partial<Record<LogicalAction, Hotkey>> = { camera: 'camera', reset: 'reset' };

export class GamepadSource implements InputSource {
  private readonly table: BindingTable;
  private readonly pendingUi: UiAction[] = [];
  private readonly pendingHot: Hotkey[] = [];
  /** Per-binding edge tracking: which axis/button directions are currently "held". */
  private readonly axisHeld = new Map<string, boolean>();
  private lastPadId: string | null = null;

  constructor(bindings: Bindings) {
    this.table = bindings.table('gamepad');
  }

  private snapshot(): PadSnapshot | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    for (const g of navigator.getGamepads()) {
      if (g && g.connected) {
        const id = `${g.mapping ?? ''}:${g.axes.length}/${g.buttons.length}`;
        if (id !== this.lastPadId) {
          this.lastPadId = id;
          log.info('gamepad connected', { mapping: g.mapping, axes: g.axes.length, buttons: g.buttons.length });
        }
        return { axes: g.axes, buttons: g.buttons };
      }
    }
    return null;
  }

  /**
   * Per-frame edge scan — runs every frame, menus or gameplay. Detects the
   * down-edge of any gamepad control bound to a UI action or hotkey and
   * pushes it into the buffers `drainUiActions`/`drainHotkeys` drain. The
   * driving analog state is NOT read here; `vehicleInput` does that, and
   * only while a match is running.
   */
  poll(): void {
    const pad = this.snapshot();
    if (!pad) return;
    const edges: LogicalAction[] = [];
    for (const action of Object.keys(this.table) as LogicalAction[]) {
      if (!UI_OF[action] && !HOTKEY_OF[action]) continue;  // driving actions have no edge
      for (const b of this.table[action]) {
        const v = this.bindingValue(pad, b);
        // a binding is "on" only when pushed in its own direction: bindingValue
        // sign-adjusts axes, so a stick pushed the opposite way reads negative
        // and must NOT count as on (else one push fires both left and right)
        const on = v.kind === 'analog' ? v.value > UI_STICK_DEADZONE : v.pressed;
        const key = edgeKey(b);
        if (on && !this.axisHeld.get(key)) { this.axisHeld.set(key, true); edges.push(action); }
        else if (!on && this.axisHeld.get(key)) { this.axisHeld.set(key, false); }
      }
    }
    for (const e of edges) {
      const ui = UI_OF[e];
      if (ui) this.pendingUi.push(ui);
      else { const h = HOTKEY_OF[e]; if (h) this.pendingHot.push(h); }
    }
  }

  vehicleInput(): VehicleInput {
    const pad = this.snapshot();
    if (!pad) return REST;
    const out: VehicleInput = { throttle: 0, brake: 0, steer: 0, jump: false, pitch: 0 };
    for (const action of Object.keys(this.table) as LogicalAction[]) {
      for (const b of this.table[action]) {
        const v = this.bindingValue(pad, b);
        if (v.kind === 'analog') applyAnalog(out, action, v.value);
        else if (v.pressed) applyDigital(out, action);
      }
    }
    // fold -0 (from Math.min(0, -value) on a centred axis) to +0, so a resting
    // pad matches the keyboard's 0 exactly — toEqual sees -0 !== 0
    return {
      throttle: out.throttle,
      brake: out.brake,
      steer: out.steer || 0,
      jump: out.jump,
      pitch: out.pitch || 0
    };
  }

  /** Read one binding's current state from a pad snapshot. */
  private bindingValue(pad: PadSnapshot, b: Binding): { kind: 'digital'; pressed: boolean } | { kind: 'analog'; value: number } {
    if (b.kind === 'key') return { kind: 'digital', pressed: false };
    if (b.kind === 'button') {
      const btn = pad.buttons[b.index] ?? { value: 0, pressed: false };
      // a trigger reports analog .value; a face button is 0/1 via .pressed
      if (b.index === 6 || b.index === 7) {
        const v = btn.value;
        return { kind: 'analog', value: v < TRIGGER_DEADZONE ? 0 : v };
      }
      return { kind: 'digital', pressed: btn.pressed };
    }
    // axis
    const v = pad.axes[b.index] ?? 0;
    const signed = b.sign === -1 ? -v : v;
    return { kind: 'analog', value: Math.abs(v) < STICK_DEADZONE ? 0 : signed };
  }

  drainUiActions(): UiAction[] { return this.pendingUi.splice(0); }
  drainHotkeys(): Hotkey[] { return this.pendingHot.splice(0); }

  dispose(): void {
    this.pendingUi.length = 0;
    this.pendingHot.length = 0;
    this.axisHeld.clear();
  }
}

const REST: VehicleInput = { throttle: 0, brake: 0, steer: 0, jump: false, pitch: 0 };

function edgeKey(b: Binding): string {
  if (b.kind === 'axis') return `a${b.index}:${b.sign}`;
  if (b.kind === 'button') return `b${b.index}`;
  return `k${b.code}`;
}

function applyAnalog(out: VehicleInput, action: LogicalAction, value: number): void {
  switch (action) {
    case 'accelerate': out.throttle = Math.max(out.throttle, value); break;
    case 'brake': out.brake = Math.max(out.brake, value); break;
    case 'steerLeft': out.steer = Math.max(out.steer, value); break;
    case 'steerRight': out.steer = Math.min(out.steer, -value); break;
    case 'pitchUp': out.pitch = Math.max(out.pitch ?? 0, value); break;
    case 'pitchDown': out.pitch = Math.min(out.pitch ?? 0, -value); break;
    // a trigger or axis bound to jump reads as on when past the deadzone
    case 'jump': if (value > 0.5) out.jump = true; break;
    default: break;
  }
}

function applyDigital(out: VehicleInput, action: LogicalAction): void {
  switch (action) {
    case 'accelerate': out.throttle = 1; break;
    case 'brake': out.brake = 1; break;
    case 'steerLeft': out.steer = 1; break;
    case 'steerRight': out.steer = -1; break;
    case 'jump': out.jump = true; break;
    default: break;
  }
}
