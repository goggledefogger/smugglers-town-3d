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
import type { Binding, DeviceKind } from './bindings.ts';
import { Bindings } from './bindings.ts';
import { KeyboardSource } from './KeyboardSource.ts';
import { GamepadSource } from './GamepadSource.ts';

export type CapturedBinding = { device: DeviceKind; binding: Binding };

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

  /** Per-frame edge scan on every source — run every frame, menus or gameplay. */
  poll(): void {
    for (const s of this.sources) s.poll();
  }

  /** Merged driving input. Per-channel: any source pushing wins, 0 if none. */
  vehicleInput(): VehicleInput {
    let throttle = 0, brake = 0, steer = 0, jump = false, pitch = 0, handbrake = false;
    for (const s of this.sources) {
      const v = s.vehicleInput();
      if (v.throttle) throttle = maxAbs(throttle, v.throttle);
      if (v.brake) brake = maxAbs(brake, v.brake);
      if (v.steer) steer = maxAbs(steer, v.steer);
      if (v.jump) jump = true;
      if (v.handbrake) handbrake = true;
      if (v.pitch) pitch = maxAbs(pitch, v.pitch);
    }
    return { throttle, brake, steer, jump, pitch, handbrake };
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

  /**
   * Capture the next physical input from any source, as a binding. Used by
   * the rebind screen: call this, and the callback fires once with whatever
   * key or button the player presses next. Returns a cancel function.
   */
  captureNext(onCapture: (c: CapturedBinding) => void): () => void {
    let cancelled = false;

    // keyboard: a one-shot keydown listener
    const onKey = (e: KeyboardEvent) => {
      if (cancelled) return;
      // ignore pure modifier presses; they're not useful as bindings alone
      if (e.code.startsWith('Shift') || e.code.startsWith('Control') || e.code.startsWith('Alt') || e.code.startsWith('Meta')) return;
      window.removeEventListener('keydown', onKey);
      cancelPad();
      onCapture({ device: 'keyboard', binding: { kind: 'key', code: e.code } });
    };
    window.addEventListener('keydown', onKey, { once: true });

    // gamepad: poll for the first newly-pressed button or axis past a threshold
    let raf = 0;
    const prevBtn = new Map<number, boolean>();
    const poll = () => {
      if (cancelled) return;
      const pads = (navigator.getGamepads?.() ?? []);
      for (const g of pads) {
        if (!g?.connected) continue;
        for (let i = 0; i < g.buttons.length; i++) {
          const pressed = g.buttons[i]?.pressed ?? false;
          if (pressed && !prevBtn.get(i)) {
            cancelKey();
            onCapture({ device: 'gamepad', binding: { kind: 'button', index: i } });
            return;
          }
          prevBtn.set(i, pressed);
        }
        for (let i = 0; i < g.axes.length; i++) {
          const v = g.axes[i] ?? 0;
          if (Math.abs(v) > 0.6) {
            cancelKey();
            onCapture({ device: 'gamepad', binding: { kind: 'axis', index: i, sign: v > 0 ? 1 : -1 } });
            return;
          }
        }
      }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);

    const cancelKey = () => window.removeEventListener('keydown', onKey);
    const cancelPad = () => cancelAnimationFrame(raf);
    return () => { cancelled = true; cancelKey(); cancelAnimationFrame(raf); };
  }

  dispose(): void {
    for (const s of this.sources) s.dispose();
  }
}

/** Max by magnitude, preserving sign — so -0.8 beats 0.3 on steer. */
function maxAbs(a: number, b: number): number {
  return Math.abs(b) > Math.abs(a) ? b : a;
}
