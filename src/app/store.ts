/**
 * Reactive store the UI subscribes to. Game pushes updates; Lit components
 * re-render on change. Kept intentionally small — snapshot-in snapshot-out.
 */
import { type NavGoal, type ObjectiveText } from './navTarget.ts';
export type GamePhase = 'intro' | 'countdown' | 'playing' | 'suddenDeath' | 'gameover';

export interface HudSnapshot {
  readonly phase: GamePhase;
  /** Seconds left on the round clock. */
  readonly timeLeftS: number;
  readonly speed: number;
  readonly damage: number;
  readonly vehicleName: string;
  readonly scores: Readonly<Record<0 | 1, number>>;
  readonly carrierName: string | null;
  readonly carrierIsPlayer: boolean;
  readonly carrierIsAlly: boolean;
  readonly objective: ObjectiveText;
  /** Real meters to the current target. */
  readonly distanceToTargetM: number;
  /** What the player is being sent to do; drives the nav marker's colour and label. */
  readonly navGoal: NavGoal;
  readonly locationLabel: string;
  readonly winner: 0 | 1 | null;
  readonly teamPips: readonly { team: 0 | 1; isPlayer: boolean }[];
}

export interface Store<T> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(fn: (state: T) => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<(s: T) => void>();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const fn of subs) fn(state);
    },
    subscribe(fn) {
      subs.add(fn);
      fn(state);
      return () => {
        subs.delete(fn);
      };
    }
  };
}
