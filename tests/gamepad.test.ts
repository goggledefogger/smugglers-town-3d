import { describe, it, expect } from 'vitest';
import { readGamepad, type PadState } from '../src/ui/gamepad.ts';

function pad(over: Partial<PadState> = {}): PadState {
  return {
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ value: 0, pressed: false })),
    ...over
  };
}

describe('readGamepad', () => {
  it('yields all-zero input from an untouched pad', () => {
    expect(readGamepad(pad())).toEqual({
      throttle: 0, brake: 0, steer: 0, jump: false, pitch: 0
    });
  });

  it('steers left when the stick is pushed left, and respects the deadzone', () => {
    expect(readGamepad(pad({ axes: [-0.5, 0, 0, 0] })).steer).toBeCloseTo(0.5, 5);
    // inside the deadzone reads as centred
    expect(readGamepad(pad({ axes: [-0.1, 0, 0, 0] })).steer).toBe(0);
  });

  it('steers right when the stick is pushed right', () => {
    expect(readGamepad(pad({ axes: [0.7, 0, 0, 0] })).steer).toBeCloseTo(-0.7, 5);
  });

  it('jumps on the A button and ignores button value beyond pressed', () => {
    expect(readGamepad(pad({ buttons: pressed(0) })).jump).toBe(true);
    expect(readGamepad(pad()).jump).toBe(false);
  });

  it('reads throttle and brake from the analog triggers', () => {
    expect(readGamepad(pad({ buttons: trigger(7, 0.6) })).throttle).toBeCloseTo(0.6, 5);
    expect(readGamepad(pad({ buttons: trigger(6, 0.4) })).brake).toBeCloseTo(0.4, 5);
  });

  it('treats a trigger under the deadzone as released', () => {
    expect(readGamepad(pad({ buttons: trigger(7, 0.03) })).throttle).toBe(0);
  });

  it('falls back to dpad up/down when the triggers are unused', () => {
    expect(readGamepad(pad({ buttons: pressed(12) })).throttle).toBe(1);
    expect(readGamepad(pad({ buttons: pressed(13) })).brake).toBe(1);
  });

  it('reads pitch from the right stick, inverted (pull-back is nose up)', () => {
    // right stick down is positive Y; pitch +1 is nose up, so a pull-back
    // (positive Y) must read as positive pitch
    expect(readGamepad(pad({ axes: [0, 0, 0, 0.8] })).pitch).toBeCloseTo(-0.8, 5);
    expect(readGamepad(pad({ axes: [0, 0, 0, -0.8] })).pitch).toBeCloseTo(0.8, 5);
  });

  it('steer from the left stick beats the dpad when both are used', () => {
    const both = pad({ axes: [0.6, 0, 0, 0], buttons: pressed(14) });
    expect(readGamepad(both).steer).toBeCloseTo(-0.6, 5);
  });
});

function pressed(i: number) {
  const buttons = Array.from({ length: 16 }, () => ({ value: 0, pressed: false }));
  buttons[i] = { value: 1, pressed: true };
  return buttons;
}

function trigger(i: number, value: number) {
  const buttons = Array.from({ length: 16 }, () => ({ value: 0, pressed: false }));
  buttons[i] = { value, pressed: value > 0 };
  return buttons;
}
