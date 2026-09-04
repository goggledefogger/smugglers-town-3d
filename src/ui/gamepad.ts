/**
 * Gamepad reading for player input. The Gamepad API is poll-based — the
 * `gamepadconnected` event only tells you a pad exists; button/axis state
 * advances when you call `navigator.getGamepads()`, once per frame. So this
 * is a pure function of the pad snapshot, called from the same poll that
 * already reads the keyboard.
 *
 * Standard mapping (`mapping === 'standard'`) is assumed but not required:
 * indices fall back to the raw array when a pad reports no mapping, so an
 * oddball Bluetooth controller still drives — rebindable keys (roadmap) is
 * the real fix for those, but a resting pad never steals input from the
 * keyboard either way.
 */
import type { VehicleInput } from '../core/physics/vehicleStats.ts';

/** A GamepadAxis/GamepadButton-shaped slice, so tests can build pads by hand. */
export interface PadState {
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly value: number; readonly pressed: boolean }[];
}

const LEFT_STICK_X = 0;
const RIGHT_STICK_Y = 3;
// standard: buttons[0] = A (cross), [6] = L2/ZL (brake), [7] = R2/ZR (throttle),
// [12] up, [13] down, [14] left, [15] right. L2/R2 report analog .value in [0,1].
const BTN_A = 0;
const BTN_BRAKE = 6;
const BTN_THROTTLE = 7;
const BTN_DPAD_UP = 12;
const BTN_DPAD_DOWN = 13;
const BTN_DPAD_LEFT = 14;
const BTN_DPAD_RIGHT = 15;

/** Below this magnitude an axis reads as centered — resting sticks jitter. */
const STICK_DEADZONE = 0.18;
/** Trigger value below which the pedal reads as released — resting L2/R2 jitter. */
const TRIGGER_DEADZONE = 0.05;

function axis(p: PadState, i: number): number {
  const v = p.axes[i] ?? 0;
  return Math.abs(v) < STICK_DEADZONE ? 0 : v;
}

function pressed(p: PadState, i: number): boolean {
  return p.buttons[i]?.pressed ?? false;
}

/** Analog trigger 0..1, or 0 inside the deadzone. L2/R2 rest values jitter. */
function trigger(p: PadState, i: number): number {
  const v = p.buttons[i]?.value ?? 0;
  return v < TRIGGER_DEADZONE ? 0 : v;
}

/**
 * Read a pad snapshot into a `VehicleInput`. Channels default to the resting
 * values (throttle/brake/steer 0, jump false, pitch 0) so a pad that is
 * plugged in but untouched yields no input — the keyboard stays in charge.
 *
 * Steer sign: `VehicleInput.steer` is +1 for left, but a stick reports right
 * as positive, so the axis is negated.
 */
export function readGamepad(p: PadState): VehicleInput {
  const steerX = -axis(p, LEFT_STICK_X);
  // right stick down is positive Y; pitch +1 is nose up (pull back), so negate.
  // `|| 0` folds the -0 that `-axis` produces on a centred stick back to +0,
  // so a resting pad matches the keyboard's 0 exactly (toEqual sees -0 !== 0).
  const pitch = -axis(p, RIGHT_STICK_Y) || 0;
  const dpadUp = pressed(p, BTN_DPAD_UP);
  const dpadDown = pressed(p, BTN_DPAD_DOWN);
  const dpadLeft = pressed(p, BTN_DPAD_LEFT);
  const dpadRight = pressed(p, BTN_DPAD_RIGHT);
  const throttle = trigger(p, BTN_THROTTLE);
  const brake = trigger(p, BTN_BRAKE);
  return {
    // analog triggers give partial throttle; dpad is a digital fallback for
    // pads whose triggers rest at full-on or that lack them entirely
    throttle: throttle > 0 ? throttle : dpadUp ? 1 : 0,
    brake: brake > 0 ? brake : dpadDown ? 1 : 0,
    // an off-centre stick is analog and wins over the digital dpad; a centred
    // stick falls back to whatever direction the dpad is holding
    steer: steerX !== 0 ? steerX : dpadLeft ? 1 : dpadRight ? -1 : 0,
    jump: pressed(p, BTN_A),
    // the keyboard reuses throttle/brake keys for pitch because it has no
    // separate axis; a gamepad has the right stick, so pitch is that alone
    pitch
  };
}

/** The first currently-connected standard-ish gamepad, or null. */
export function activeGamepad(): PadState | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  for (const g of pads) {
    if (g && g.connected) return { mapping: g.mapping ?? '', axes: g.axes, buttons: g.buttons };
  }
  return null;
}
