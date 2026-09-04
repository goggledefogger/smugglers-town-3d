/**
 * InputManager owns the input sources and merges them into the two shapes
 * the rest of the app consumes: a continuous `VehicleInput` (driving) and
 * discrete `UiAction` / `Hotkey` edges (menus and gameplay hotkeys).
 *
 * Merging rule for driving: keyboard is the baseline, and a gamepad overrides
 * a channel only when that channel is actually off-centre, so a plugged-in
 * but untouched pad never steals the keyboard. Each source's `vehicleInput`
 * already returns its resting value when idle, so a plain per-channel max
 * composes them: whichever source is pushing a channel wins.
 */

import type { VehicleInput } from '../core/physics/vehicleStats.ts';
import type { UiAction, Hotkey, InputSource } from './types.ts';
import { Bindings } from './bindings.ts';
import { KeyboardSource } from './KeyboardSource.ts';
import { GamepadSource } from './GamepadSource.ts';

export class InputManager {
  readonly bindings: Bindings;
  private readonly sources: InputSource[];

  constructor(bindings?: Bindings) {
    this.bindings = bindings ?? new Bindings();
    this.sources = [
      new KeyboardSource(this.bindings),
      new GamepadSource(this.bindings)
    ];
  }

  /** Test seam: inject sources that don't need a DOM or gamepad. */
  static ForTest(bindings: Bindings, sources: InputSource[]): InputManager {
    const mgr = Object.create(InputManager.prototype) as unknown as InputManager;
    (mgr as unknown as { bindings: Bindings }).bindings = bindings;
    (mgr as unknown as { sources: InputSource[] }).sources = sources;
    return mgr;
  }

  /** Merged driving input. Per-channel: any source pushing wins, 0 if none. */
  vehicleInput(): VehicleInput {
    let throttle = 0, brake = 0, steer = 0, jump = false, pitch = 0;
    for (const s of this.sources) {
      const v = s.vehicleInput();
      if (v.throttle) throttle = maxAbs(throttle, v.throttle);
      if (v.brake) brake = maxAbs(brake, v.brake);
      if (v.steer) steer = maxAbs(steer, v.steer);
      if (v.jump) jump = true;
      if (v.pitch) pitch = maxAbs(pitch, v.pitch);
    }
    return { throttle, brake, steer, jump, pitch };
  }

  drainUiActions(): UiAction[] {
    const out: UiAction[] = [];
    for (const s of this.sources) out.push(...s.drainUiActions());
    return out;
  }

  drainHotkeys(): Hotkey[] {
    const out: Hotkey[] = [];
    for (const s of this.sources) out.push(...s.drainHotkeys());
    return out;
  }

  dispose(): void {
    for (const s of this.sources) s.dispose();
  }
}

/** Max by magnitude, preserving sign — so -0.8 beats 0.3 on steer. */
function maxAbs(a: number, b: number): number {
  return Math.abs(b) > Math.abs(a) ? b : a;
}
