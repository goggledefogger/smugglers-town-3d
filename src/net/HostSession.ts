/**
 * The host's side of a match: runs the real `Game`, feeds it each remote
 * driver's latest input, and broadcasts snapshots at `SNAP_HZ` plus every
 * gameplay event as it happens.
 *
 * Peers identify themselves with a join message carrying their lobby uid
 * and that seat's token. Transport ids are not tied to Firebase identity,
 * so the token is what proves a peer is the player it claims: it was
 * written under database rules only the owner and the host can read. A
 * seat binds once — a second peer claiming a bound uid, or a bound peer
 * claiming another uid, is ignored.
 */
import type { Game } from '../app/Game.ts';
import type { GameEvents, GameEventMap } from '../app/events.ts';
import type { VehicleInput } from '../core/physics/vehicleStats.ts';
import type { Transport } from './Transport.ts';
import { decode, encode, inputFromMsg, type EventMsg, type HelloMsg, type SnapshotMsg } from './protocol.ts';

const SNAP_HZ = 20;
const NEUTRAL: VehicleInput = { throttle: 0, brake: 0, steer: 0, jump: false };

type Forwarded = Exclude<keyof GameEventMap, 'location:changed'>;
const FORWARDED: readonly Forwarded[] = [
  'contraband:pickup', 'contraband:stolen', 'contraband:delivered', 'contraband:dropped',
  'vehicle:wrecked', 'match:countdown', 'match:finalMinute', 'match:suddenDeath', 'match:win'
];

export class HostSession {
  /** transport peer id → lobby uid, learned from each peer's join message */
  private readonly peerUid = new Map<string, string>();
  private readonly lastSeq = new Map<string, number>();
  private readonly unsubs: (() => void)[] = [];
  private readonly joined = new Set<string>();
  private snapTimer = 0;
  private waiters: (() => void)[] = [];

  private game: Game | null = null;
  private hello: Omit<HelloMsg, 't'> | null = null;

  constructor(
    private readonly transport: Transport,
    events: GameEvents,
    /** uid → token for every seat in the lobby, from the database. */
    private readonly tokens: Readonly<Record<string, string>>
  ) {
    this.unsubs.push(transport.onMessage((data, from) => this.onMessage(data, from)));
    this.unsubs.push(transport.onPeerLeave(id => {
      const uid = this.peerUid.get(id);
      if (!uid) return;
      this.peerUid.delete(id);
      this.joined.delete(uid);
      // a dropped player's car coasts to a stop instead of holding its last input
      this.game?.setRemoteInput(uid, NEUTRAL);
    }));
    for (const name of FORWARDED) {
      this.unsubs.push(events.on(name, payload => {
        transport.send(encode({ t: 'e', name, payload } as EventMsg));
      }));
    }
  }

  /** Resolves once every uid in `expected` has joined, or after `timeoutMs`; returns who is missing. */
  waitForPeers(expected: readonly string[], timeoutMs: number): Promise<string[]> {
    return new Promise(resolve => {
      const missing = (): string[] => expected.filter(u => !this.joined.has(u));
      if (missing().length === 0) return resolve([]);
      const timer = setTimeout(() => finish(), timeoutMs);
      const check = (): void => {
        if (missing().length === 0) finish();
      };
      const finish = (): void => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter(w => w !== check);
        resolve(missing());
      };
      this.waiters.push(check);
    });
  }

  /**
   * Begin the match: from here inputs drive the game, snapshots flow, and
   * every peer that has already joined gets its hello. Done after
   * `waitForPeers` so the countdown starts with everyone present.
   */
  start(game: Game, hello: Omit<HelloMsg, 't'>): void {
    this.game = game;
    this.hello = hello;
    for (const [peer] of this.peerUid) this.transport.send(encode({ t: 'h', ...hello }), peer);
  }

  update(dt: number, localInput: VehicleInput | null): void {
    if (!this.game) return;
    this.game.update(dt, localInput);
    this.snapTimer += dt;
    if (this.snapTimer >= 1 / SNAP_HZ) {
      this.snapTimer = 0;
      this.transport.send(encode(this.snapshot()));
    }
  }

  snapshot(): SnapshotMsg {
    const g = this.game!;
    const st = g.state;
    return {
      t: 's',
      tick: g.tick,
      timeS: g.time,
      timeLeftS: g.timeLeft,
      phase: g.matchPhase,
      scores: [st.scores[0], st.scores[1]],
      carrier: st.carrier?.id ?? null,
      crate: [st.contrabandPos.x, st.contrabandPos.y, st.contrabandPos.z],
      bodies: g.vehicles.map(a => {
        const b = a.body;
        return {
          id: b.id,
          p: [b.pos.x, b.pos.y, b.pos.z],
          q: [b.quat.x, b.quat.y, b.quat.z, b.quat.w],
          v: [b.vel.x, b.vel.y, b.vel.z],
          d: b.damage,
          g: b.onGround ? 1 : 0
        };
      })
    };
  }

  private onMessage(data: string, from: string): void {
    const m = decode(data);
    if (!m) return;
    if (m.t === 'j') {
      if (this.tokens[m.uid] !== m.token) return;
      if (this.peerUid.has(from) || this.joined.has(m.uid)) return;
      this.peerUid.set(from, m.uid);
      this.joined.add(m.uid);
      if (this.hello) this.transport.send(encode({ t: 'h', ...this.hello }), from);
      for (const w of [...this.waiters]) w();
      return;
    }
    if (m.t !== 'i' || !this.game) return;
    const uid = this.peerUid.get(from);
    if (!uid) return;
    if ((this.lastSeq.get(uid) ?? -1) >= m.seq) return;
    this.lastSeq.set(uid, m.seq);
    this.game.setRemoteInput(uid, inputFromMsg(m));
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.transport.leave();
  }
}
