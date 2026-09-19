/**
 * Gamepad input normalization.
 *
 * Normalizes differences across operating systems (Windows, macOS, Linux)
 * and browsers (Chrome, Edge, Firefox, Safari), with specialized support
 * for the Google Stadia Controller over Bluetooth.
 *
 * Background:
 * Chrome/Edge map the Bluetooth Stadia controller to `mapping: 'standard'`.
 * Firefox on Windows/Linux frequently flags it as `mapping: ''` (non-standard DirectInput).
 * In raw HID mode, buttons and triggers are displaced:
 * - Triggers are on axes 4 and 5 (often ranging -1..1) rather than buttons 6 and 7.
 * - Start is on button 6 (which standard mapping assigns to LT/Brake!).
 * - Back/Select is on button 4 (standard mapping is 8).
 * - Shoulders are on buttons 9 and 10 (standard mapping is 4 and 5).
 * - L3/R3 are on buttons 7 and 8 (standard mapping is 10 and 11).
 * - D-Pad buttons are 11..14 (standard mapping is 12..15), or on a POV hat axis.
 *
 * This normalizer transforms raw gamepads into the standard W3C 16+ button,
 * 4-axis layout so the rest of the game handles all controllers uniformly.
 */

interface PadButton {
  readonly value: number;
  readonly pressed: boolean;
}

export interface PadSnapshot {
  readonly axes: readonly number[];
  readonly buttons: readonly PadButton[];
  readonly id: string;
  readonly mapping: string;
  readonly isStadia: boolean;
  readonly name: string;
}

/** Check whether a gamepad ID string corresponds to a Google Stadia Controller. */
export function isStadiaController(id: string): boolean {
  if (!id) return false;
  const lower = id.toLowerCase();
  // Vendor 18d1 (Google), Product 9400 (Stadia Controller Bluetooth)
  return (lower.includes('18d1') && lower.includes('9400')) || lower.includes('stadia');
}

/** Get a clean, human-friendly display name for a gamepad. */
export function getGamepadDisplayName(id: string): string {
  if (!id) return 'Gamepad';
  if (isStadiaController(id)) return 'Google Stadia Controller';
  if (/xbox/i.test(id)) return 'Xbox Controller';
  if (/dualshock|dualsense|playstation/i.test(id)) return 'PlayStation Controller';
  if (/nintendo|switch|pro controller/i.test(id)) return 'Nintendo Switch Pro Controller';
  // Trim common browser metadata noise like "(STANDARD GAMEPAD Vendor: ...)"
  const cleaned = id.replace(/\s*\(standard gamepad[^)]*\)/i, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim();
  return cleaned || 'Gamepad';
}

/** Tracks which gamepad trigger axes rest at -1.0 to normalize [-1, 1] -> [0, 1]. */
const triggerNegativeRange = new Set<string>();

/**
 * Normalizes an analog trigger axis value to 0..1.
 * Handles both [0, 1] axes and [-1, 1] axes (where -1 = unpressed, +1 = fully pressed).
 */
export function normalizeTriggerAxis(padId: string, axisIndex: number, rawVal: number): number {
  const key = `${padId}:${axisIndex}`;
  if (rawVal < -0.4) {
    triggerNegativeRange.add(key);
  }
  if (triggerNegativeRange.has(key)) {
    return Math.max(0, Math.min(1, (rawVal + 1) / 2));
  }
  return Math.max(0, Math.min(1, rawVal));
}

/**
 * Decodes a POV hat switch axis into 4 directional states.
 * Standard DirectInput hat switch: centered > 1.05 or < -1.05.
 * Values: -1.0=Up, -0.71=Up-Right, -0.43=Right, -0.14=Down-Right,
 *          0.14=Down, 0.43=Down-Left, 0.71=Left, 1.0=Up-Left.
 */
export function decodeHatSwitch(hat: number): { up: boolean; down: boolean; left: boolean; right: boolean } {
  if (hat > 1.05 || hat < -1.05) {
    return { up: false, down: false, left: false, right: false };
  }
  const up = Math.abs(hat - (-1.0)) < 0.12 || Math.abs(hat - (-0.71)) < 0.12 || Math.abs(hat - 1.0) < 0.12;
  const right = Math.abs(hat - (-0.71)) < 0.12 || Math.abs(hat - (-0.43)) < 0.12 || Math.abs(hat - (-0.14)) < 0.12;
  const down = Math.abs(hat - (-0.14)) < 0.12 || Math.abs(hat - 0.14) < 0.12 || Math.abs(hat - 0.43) < 0.12;
  const left = Math.abs(hat - 0.43) < 0.12 || Math.abs(hat - 0.71) < 0.12 || Math.abs(hat - 1.0) < 0.12;
  return { up, down, left, right };
}

function makeButton(value: number, pressed = value > 0.5): PadButton {
  return { value: Math.max(0, Math.min(1, value)), pressed };
}

/**
 * Normalizes any Gamepad into the standard W3C 16-button, 4-axis layout.
 * If the pad is already 'standard' mapping, it passes through.
 * If it's a Stadia Controller in non-standard mode (e.g. Firefox), it translates
 * raw HID buttons/axes into standard indices.
 */
export function normalizePadSnapshot(pad: Gamepad): PadSnapshot {
  const isStadia = isStadiaController(pad.id);
  const name = getGamepadDisplayName(pad.id);

  // Standard mapping: already normalized by browser
  if (pad.mapping === 'standard') {
    return {
      axes: pad.axes,
      buttons: pad.buttons.map(b => ({ value: b.value, pressed: b.pressed })),
      id: pad.id,
      mapping: pad.mapping,
      isStadia,
      name
    };
  }

  // Non-standard mapping for Stadia Controller
  if (isStadia) {
    const rawButtons = pad.buttons;
    const rawAxes = pad.axes;

    const outButtons: PadButton[] = Array.from({ length: 17 }, () => makeButton(0, false));

    // Face buttons: 0:A, 1:B, 2:X, 3:Y
    for (let i = 0; i <= 3; i++) {
      const btn = rawButtons[i];
      if (btn) {
        outButtons[i] = { value: btn.value, pressed: btn.pressed };
      }
    }

    // Shoulders: LB = raw 9, RB = raw 10
    if (rawButtons[9]) outButtons[4] = { value: rawButtons[9].value, pressed: rawButtons[9].pressed };
    if (rawButtons[10]) outButtons[5] = { value: rawButtons[10].value, pressed: rawButtons[10].pressed };

    // Triggers: LT = raw axis 4 (or raw button 6 if triggers are digital), RT = raw axis 5 (or raw button 7)
    let ltVal = rawAxes.length > 4 ? normalizeTriggerAxis(pad.id, 4, rawAxes[4]!) : 0;
    let rtVal = rawAxes.length > 5 ? normalizeTriggerAxis(pad.id, 5, rawAxes[5]!) : 0;
    outButtons[6] = makeButton(ltVal, ltVal > 0.1);
    outButtons[7] = makeButton(rtVal, rtVal > 0.1);

    // Center buttons: Select/Back = raw 4, Start/Menu = raw 6, Stadia/Guide = raw 5
    if (rawButtons[4]) outButtons[8] = { value: rawButtons[4].value, pressed: rawButtons[4].pressed };
    if (rawButtons[6]) outButtons[9] = { value: rawButtons[6].value, pressed: rawButtons[6].pressed };
    if (rawButtons[5]) outButtons[16] = { value: rawButtons[5].value, pressed: rawButtons[5].pressed };

    // Thumbstick clicks: L3 = raw 7, R3 = raw 8
    if (rawButtons[7]) outButtons[10] = { value: rawButtons[7].value, pressed: rawButtons[7].pressed };
    if (rawButtons[8]) outButtons[11] = { value: rawButtons[8].value, pressed: rawButtons[8].pressed };

    // D-Pad: raw buttons 11..14 or POV Hat switch
    let dpadFound = false;
    if (rawButtons.length >= 15) {
      const up = rawButtons[11];
      const down = rawButtons[12];
      const left = rawButtons[13];
      const right = rawButtons[14];
      if (up || down || left || right) {
        if (up) outButtons[12] = { value: up.value, pressed: up.pressed };
        if (down) outButtons[13] = { value: down.value, pressed: down.pressed };
        if (left) outButtons[14] = { value: left.value, pressed: left.pressed };
        if (right) outButtons[15] = { value: right.value, pressed: right.pressed };
        dpadFound = true;
      }
    }

    // If D-Pad not satisfied via buttons, check for POV hat on axes 6, 7, 8, or 9
    if (!dpadFound && rawAxes.length > 6) {
      for (let ax = 6; ax < rawAxes.length; ax++) {
        const hat = rawAxes[ax]!;
        if (hat <= 1.05 && hat >= -1.05) {
          const { up, down, left, right } = decodeHatSwitch(hat);
          if (up || down || left || right) {
            outButtons[12] = makeButton(up ? 1 : 0, up);
            outButtons[13] = makeButton(down ? 1 : 0, down);
            outButtons[14] = makeButton(left ? 1 : 0, left);
            outButtons[15] = makeButton(right ? 1 : 0, right);
            break;
          }
        }
      }
    }

    // Axes: 0:LX, 1:LY, 2:RX, 3:RY
    const outAxes = [
      rawAxes[0] ?? 0,
      rawAxes[1] ?? 0,
      rawAxes[2] ?? 0,
      rawAxes[3] ?? 0
    ];

    return {
      axes: outAxes,
      buttons: outButtons,
      id: pad.id,
      mapping: 'standard (remapped)',
      isStadia: true,
      name
    };
  }

  // Generic non-standard fallback: ensure at least 16 buttons and 4 axes
  const buttons: PadButton[] = [];
  for (let i = 0; i < Math.max(16, pad.buttons.length); i++) {
    const b = pad.buttons[i];
    buttons.push(b ? { value: b.value, pressed: b.pressed } : makeButton(0, false));
  }

  return {
    axes: pad.axes,
    buttons,
    id: pad.id,
    mapping: pad.mapping || 'unknown',
    isStadia,
    name
  };
}

/** Human-friendly name for standard gamepad buttons. */
export const GAMEPAD_BUTTON_NAMES: Record<number, string> = {
  0: 'A',
  1: 'B',
  2: 'X',
  3: 'Y',
  4: 'LB',
  5: 'RB',
  6: 'LT',
  7: 'RT',
  8: 'Select / Options',
  9: 'Start / Menu',
  10: 'LS Click',
  11: 'RS Click',
  12: 'D-Pad Up',
  13: 'D-Pad Down',
  14: 'D-Pad Left',
  15: 'D-Pad Right',
  16: 'Stadia / Home',
  17: 'Capture',
  18: 'Assistant'
};

/** Human-friendly name for standard gamepad axes. */
export const GAMEPAD_AXIS_NAMES: Record<string, string> = {
  '0:-1': 'Left Stick Left',
  '0:1': 'Left Stick Right',
  '1:-1': 'Left Stick Up',
  '1:1': 'Left Stick Down',
  '2:-1': 'Right Stick Left',
  '2:1': 'Right Stick Right',
  '3:-1': 'Right Stick Up',
  '3:1': 'Right Stick Down'
};
