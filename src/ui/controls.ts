/**
 * Keyboard state for player input. Keys pressed while typing in a text
 * field are ignored — text inputs own those keys until focus leaves them,
 * so Space/WASD never leak into the game while someone is searching.
 */
import type { VehicleInput } from '../core/physics/vehicleStats.ts';

/**
 * The focused element, reached through shadow roots.
 *
 * `document.activeElement` retargets to the shadow HOST, so a field inside a
 * Lit component reads as <SR-LOBBY>, never <INPUT>. Every "is the player
 * typing?" guard therefore said no and the game ate the keystroke: the room
 * code box could not accept the digits its own codes contain, and WASD steered
 * the car while you typed a place name.
 */
export function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** True while focus is in a text field, so game hotkeys must keep their hands off. */
export function isTypingInField(): boolean {
  const el = deepActiveElement();
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el instanceof HTMLElement && el.isContentEditable);
}

const GAME_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'
]);

export class KeyboardState {
  private readonly keys = new Set<string>();
  private readonly disposers: (() => void)[] = [];

  constructor() {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingInField()) return;
      this.keys.add(e.code);
      if (GAME_KEYS.has(e.code)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isTypingInField()) return;
      this.keys.delete(e.code);
    };
    // a key held while the window loses focus never gets its keyup: without
    // this a car keeps turning (and online, keeps sending that turn) forever
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

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  toVehicleInput(): VehicleInput {
    return {
      throttle: this.isDown('KeyW') || this.isDown('ArrowUp') ? 1 : 0,
      brake: this.isDown('KeyS') || this.isDown('ArrowDown') ? 1 : 0,
      steer: this.isDown('KeyA') || this.isDown('ArrowLeft')
        ? 1
        : this.isDown('KeyD') || this.isDown('ArrowRight')
          ? -1
          : 0,
      jump: this.isDown('Space')
    };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.keys.clear();
  }
}
