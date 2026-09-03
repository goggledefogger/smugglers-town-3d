/**
 * Typed pub/sub for game events. UI and render layers subscribe; core emits.
 */
export interface GameEventMap {
  'contraband:pickup': { vehicleId: number };
  'contraband:stolen': { attackerId: number; victimId: number };
  'contraband:delivered': { team: 0 | 1 };
  /** The carrier wrecked; the crate is loose where it died. */
  'contraband:dropped': { vehicleId: number };
  /** Integrity hit zero; the car respawned near its base. */
  'vehicle:wrecked': { vehicleId: number };
  /** Start countdown tick; n = 0 is "go". */
  'match:countdown': { n: number };
  'match:finalMinute': Record<string, never>;
  /** Clock ran out tied: the next delivery wins. */
  'match:suddenDeath': Record<string, never>;
  'match:win': { team: 0 | 1 };
  'location:changed': { label: string; isReal: boolean };
}

type Handler<T> = (payload: T) => void;

export class EventBus<EventMap extends object> {
  private readonly handlers = new Map<string, Set<Handler<never>>>();

  on<K extends keyof EventMap & string>(event: K, handler: Handler<EventMap[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(event, handler);
  }

  off<K extends keyof EventMap & string>(event: K, handler: Handler<EventMap[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof EventMap & string>(event: K, payload: EventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) (h as Handler<EventMap[K]>)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}

export type GameEvents = EventBus<GameEventMap>;
