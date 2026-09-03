import type { Transport } from './Transport.ts';

interface Member {
  readonly messageCbs: Set<(data: string, from: string) => void>;
  readonly joinCbs: Set<(id: string) => void>;
  readonly leaveCbs: Set<(id: string) => void>;
}

/** In-memory hub for tests and local two-window testing; deliveries are queued as microtasks so callers can't rely on synchronous ordering. */
export function createLoopbackHub(): { join(id: string): Transport } {
  const members = new Map<string, Member>();

  return {
    join(id: string): Transport {
      if (members.has(id)) throw new Error(`peer already joined: ${id}`);
      const self: Member = { messageCbs: new Set(), joinCbs: new Set(), leaveCbs: new Set() };
      members.set(id, self);

      for (const [otherId, other] of members) {
        if (otherId === id) continue;
        queueMicrotask(() => {
          for (const cb of other.joinCbs) cb(id);
        });
      }

      return {
        selfId: id,
        peers: () => [...members.keys()].filter((peerId) => peerId !== id),
        send(data, to) {
          const targetIds = to !== undefined ? [to] : [...members.keys()].filter((peerId) => peerId !== id);
          for (const targetId of targetIds) {
            const target = members.get(targetId);
            if (!target) continue;
            queueMicrotask(() => {
              for (const cb of target.messageCbs) cb(data, id);
            });
          }
        },
        onMessage(cb) {
          self.messageCbs.add(cb);
          return () => self.messageCbs.delete(cb);
        },
        onPeerJoin(cb) {
          self.joinCbs.add(cb);
          return () => self.joinCbs.delete(cb);
        },
        onPeerLeave(cb) {
          self.leaveCbs.add(cb);
          return () => self.leaveCbs.delete(cb);
        },
        leave() {
          if (!members.delete(id)) return;
          for (const other of members.values()) {
            queueMicrotask(() => {
              for (const cb of other.leaveCbs) cb(id);
            });
          }
        }
      };
    }
  };
}
