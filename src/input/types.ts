/**
 * The logical input contract: what the sim and the UI ask for, not how any
 * one device produces it. A keyboard, a gamepad, and (later) a mouse or touch
 * layer all implement `InputSource` and feed the same `InputManager`, so the
 * sim and screens never branch on "which device is active."
 *
 * Three output kinds, deliberately split:
 *  - `vehicleInput()` is analog and polled each frame — throttle, steer,
 *    pitch are continuous. The sim reads it at 60 Hz.
 *  - `drainUiActions()` is discrete and edge-triggered — a confirm is one
 *    event the moment the button crosses down, not 60 per second while held.
 *    Menus read it on each frame they are open.
 *  - `drainHotkeys()` is the same edge-triggered shape, but for gameplay
 *    hotkeys (camera, reset) the sim dispatches, not menus.
 */

/** A continuous driving channel, what the sim consumes. Re-exported shape. */
export type { VehicleInput } from '../core/physics/vehicleStats.ts';
import type { VehicleInput } from '../core/physics/vehicleStats.ts';

/** A menu-level intent, fired once on the input edge. */
export type UiAction =
  | 'up' | 'down' | 'left' | 'right'
  | 'confirm' | 'back' | 'tab' | 'pause';

/** A gameplay hotkey, edge-triggered like a UI action but routed to the sim. */
export type Hotkey = 'camera' | 'reset';

/**
 * A logical action is the name a physical control is bound to. Driving
 * actions are analog (held → continuous), UI actions are edge-triggered.
 * `camera` and `reset` are edge-triggered gameplay hotkeys.
 */
export type LogicalAction =
  | 'accelerate' | 'brake'
  | 'steerLeft' | 'steerRight'
  | 'jump'
  | 'pitchUp' | 'pitchDown'
  | 'camera' | 'reset'
  | 'uiUp' | 'uiDown' | 'uiLeft' | 'uiRight'
  | 'uiConfirm' | 'uiBack' | 'uiTab' | 'uiPause';

/** Which actions produce continuous (held) values vs. one-shot edges. */
export const EDGE_ACTIONS: ReadonlySet<LogicalAction> = new Set([
  'camera', 'reset',
  'uiUp', 'uiDown', 'uiLeft', 'uiRight',
  'uiConfirm', 'uiBack', 'uiTab', 'uiPause'
]);

/**
 * A source of input. The `InputManager` owns several and merges them.
 * `vehicleInput` returns the resting value when the source has nothing to
 * contribute, so a resting gamepad never overrides an active keyboard.
 */
export interface InputSource {
  /** Continuous driving input, polled each frame. */
  vehicleInput(): VehicleInput;
  /** Discrete UI edges accumulated since the last drain; drains the buffer. */
  drainUiActions(): UiAction[];
  /** Discrete gameplay hotkey edges (camera, reset) since the last drain. */
  drainHotkeys(): Hotkey[];
  /** Release listeners / polling state. */
  dispose(): void;
}
