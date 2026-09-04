/**
 * Keyboard input as an `InputSource`. Absorbs the old `KeyboardState`:
 * keydown/keyup tracked in a Set, blur and visibilitychange clear it (a key
 * held when the window loses focus never fires keyup, so without this a car
 * keeps turning forever), and keys pressed while typing in a text field are
 * ignored. The difference from the old class: physical keys map to
 * `LogicalAction`s through the `Bindings` table, so "which key accelerates"
 * is data, not code, and the same key set drives both the continuous
 * `VehicleInput` and the discrete edges.
 */

import type { VehicleInput } from '../core/physics/vehicleStats.ts';
import type { InputSource, UiAction, Hotkey, LogicalAction } from './types.ts';
import type { Bindings, BindingTable } from './bindings.ts';
import { isTypingInField } from '../ui/controls.ts';

/** A logical driving action's contribution to a `VehicleInput` channel. */
function driveContribution(action: LogicalAction): Partial<VehicleInput> | null {
  switch (action) {
    case 'accelerate': return { throttle: 1 };
    case 'brake': return { brake: 1 };
    case 'steerLeft': return { steer: 1 };
    case 'steerRight': return { steer: -1 };
    case 'jump': return { jump: true };
    case 'handbrake': return { handbrake: true };
    case 'pitchUp': return { pitch: 1 };
    case 'pitchDown': return { pitch: -1 };
    default: return null;
  }
}

const UI_OF: Partial<Record<LogicalAction, UiAction>> = {
  uiUp: 'up', uiDown: 'down', uiLeft: 'left', uiRight: 'right',
  uiConfirm: 'confirm', uiBack: 'back', uiTab: 'tab', uiPause: 'pause'
};
const HOTKEY_OF: Partial<Record<LogicalAction, Hotkey>> = { camera: 'camera', reset: 'reset' };

export class KeyboardSource implements InputSource {
  private readonly keys = new Set<string>();
  private readonly disposers: (() => void)[] = [];
  private readonly pendingUi: UiAction[] = [];
  private readonly pendingHot: Hotkey[] = [];
  private readonly table: BindingTable;

  constructor(bindings: Bindings) {
    this.table = bindings.table('keyboard');
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingInField()) return;
      // auto-repeat fires keydown while held; only the down-edge produces a
      // discrete event, so ignore repeats for edge-triggered actions
      const already = this.keys.has(e.code);
      this.keys.add(e.code);
      if (already) return;
      this.edgeFor(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isTypingInField()) return;
      this.keys.delete(e.code);
    };
    const release = () => this.keys.clear();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', release);
    this.disposers.push(() => window.removeEventListener('keydown', onKeyDown));
    this.disposers.push(() => window.removeEventListener('keyup', onKeyUp));
    this.disposers.push(() => window.removeEventListener('blur', release));
    this.disposers.push(() => document.removeEventListener('visibilitychange', release));
  }

  /** Fire any edge-triggered action bound to this key, once on the down-edge. */
  private edgeFor(code: string): void {
    for (const action of Object.keys(this.table) as LogicalAction[]) {
      const bound = this.table[action].some(b => b.kind === 'key' && b.code === code);
      if (!bound) continue;
      const ui = UI_OF[action];
      if (ui) { this.pendingUi.push(ui); continue; }
      const hot = HOTKEY_OF[action];
      if (hot) this.pendingHot.push(hot);
    }
  }

  /** No-op: keyboard edges fire from the `keydown` listener, not a poll. */
  poll(): void { /* keyboard has no per-frame scan; events drive edges */ }

  vehicleInput(): VehicleInput {
    const out: VehicleInput = { throttle: 0, brake: 0, steer: 0, jump: false, pitch: 0 };
    let accelDown = false, brakeDown = false;
    for (const action of Object.keys(this.table) as LogicalAction[]) {
      const held = this.table[action].some(b => b.kind === 'key' && this.keys.has(b.code));
      if (!held) continue;
      if (action === 'accelerate') accelDown = true;
      if (action === 'brake') brakeDown = true;
      const c = driveContribution(action);
      if (c) mergeDrive(out, c);
    }
    // keyboard pitch reuses accel/brake while airborne (VehicleBody ignores
    // pitch on the ground), so a keyboard player can nose up after a jump
    // without dedicated pitch keys
    if (out.pitch === 0) out.pitch = (brakeDown ? 1 : 0) - (accelDown ? 1 : 0);
    return out;
  }

  drainUiActions(): UiAction[] { return this.pendingUi.splice(0); }
  drainHotkeys(): Hotkey[] { return this.pendingHot.splice(0); }

  dispose(): void {
    for (const d of this.disposers) d();
    this.keys.clear();
    this.pendingUi.length = 0;
    this.pendingHot.length = 0;
  }
}

function mergeDrive(out: VehicleInput, c: Partial<VehicleInput>): void {
  if (c.throttle) out.throttle = c.throttle;
  if (c.brake) out.brake = c.brake;
  if (c.steer !== undefined) out.steer = c.steer;
  if (c.jump) out.jump = true;
  if (c.handbrake) out.handbrake = true;
  if (c.pitch !== undefined) out.pitch = c.pitch;
}
