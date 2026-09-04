import { describe, it, expect } from 'vitest';
import type { VehicleInput } from '../src/core/physics/vehicleStats.ts';
import type { UiAction, Hotkey, InputSource } from '../src/input/types.ts';
import { InputManager } from '../src/input/InputManager.ts';
import { Bindings } from '../src/input/bindings.ts';

/** A controllable source for testing the merge, not a real device. */
class FakeSource implements InputSource {
  private v: VehicleInput = { throttle: 0, brake: 0, steer: 0, jump: false, pitch: 0 };
  private ui: UiAction[] = [];
  private hot: Hotkey[] = [];
  set(v: Partial<VehicleInput>): void { this.v = { ...this.v, ...v }; }
  queueUi(...a: UiAction[]): void { this.ui.push(...a); }
  queueHot(...h: Hotkey[]): void { this.hot.push(...h); }
  poll(): void { /* FakeSource feeds edges via queue, not a scan */ }
  vehicleInput(): VehicleInput { return { ...this.v }; }
  drainUiActions(): UiAction[] { return this.ui.splice(0); }
  drainHotkeys(): Hotkey[] { return this.hot.splice(0); }
  dispose(): void { /* noop */ }
}

describe('InputManager merge', () => {
  it('a resting gamepad never overrides an active keyboard', () => {
    const kb = new FakeSource();
    const pad = new FakeSource();
    const mgr = InputManager.ForTest(new Bindings(), [kb, pad]);
    kb.set({ throttle: 1, steer: 0.3 });
    pad.set({ throttle: 0, brake: 0, steer: 0, jump: false, pitch: 0 });
    const v = mgr.vehicleInput();
    expect(v.throttle).toBe(1);
    expect(v.steer).toBeCloseTo(0.3, 5);
  });

  it('a gamepad channel overrides the keyboard only where it is active', () => {
    const kb = new FakeSource();
    const pad = new FakeSource();
    const mgr = InputManager.ForTest(new Bindings(), [kb, pad]);
    kb.set({ throttle: 1, steer: 0.3 });
    pad.set({ steer: -0.8 });  // pad steers right, keyboard throttle stays
    const v = mgr.vehicleInput();
    expect(v.throttle).toBe(1);       // keyboard still wins, pad throttle is 0
    expect(v.steer).toBeCloseTo(-0.8, 5); // pad overrides steer
  });

  it('jump is true if either source holds it', () => {
    const kb = new FakeSource();
    const pad = new FakeSource();
    const mgr = InputManager.ForTest(new Bindings(), [kb, pad]);
    kb.set({ jump: false });
    pad.set({ jump: true });
    expect(mgr.vehicleInput().jump).toBe(true);
  });

  it('drainUiActions concatenates across sources and drains the buffer', () => {
    const a = new FakeSource();
    const b = new FakeSource();
    const mgr = InputManager.ForTest(new Bindings(), [a, b]);
    a.queueUi('up', 'confirm');
    b.queueUi('back');
    expect(mgr.drainUiActions()).toEqual(['up', 'confirm', 'back']);
    // drained: a second call is empty
    expect(mgr.drainUiActions()).toEqual([]);
  });

  it('drainHotkeys concatenates across sources', () => {
    const a = new FakeSource();
    const b = new FakeSource();
    const mgr = InputManager.ForTest(new Bindings(), [a, b]);
    a.queueHot('camera');
    b.queueHot('reset');
    expect(mgr.drainHotkeys()).toEqual(['camera', 'reset']);
  });
});
