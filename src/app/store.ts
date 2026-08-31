/**
 * Reactive store the UI subscribes to. Game pushes updates; Lit components
 * re-render on change. Kept intentionally small — snapshot-in snapshot-out.
 */
export type GamePhase = 'intro' | 'playing' | 'gameover';

export interface HudSnapshot {
  readonly phase: GamePhase;
  readonly speed: number;
  readonly damage: number;
  readonly vehicleName: string;
  readonly scores: Readonly<Record<0 | 1, number>>;
  readonly carrierName: string | null;
  readonly carrierIsPlayer: boolean;
  readonly carrierIsAlly: boolean;
  readonly objective: 'FIND CONTRABAND' | 'DELIVER CONTRABAND';
  readonly distanceToTarget: number;
  readonly targetIsDelivery: boolean;
  /** Screen-space bearing to the current target, radians clockwise from up. */
  readonly targetBearingRad: number;
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
