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
import { logger } from '../app/log.ts';

const log = logger('host');

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
  /** uids that have reported their world built and are safe to start. */
  private readonly worldReady = new Set<string>();
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
      log.info('peer left', { uid });
      this.peerUid.delete(id);
      this.joined.delete(uid);
      // whoever is waiting on this peer should stop waiting now, not in 20 s
      for (const w of [...this.waiters]) w();
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
   * Resolves once every uid in `expected` has reported its world built, or
   * after `timeoutMs`; returns whoever never did.
   *
   * A peer that drops while loading stops being waited on immediately — the
   * timeout is there for the stuck, not for the gone.
   */
  waitForReady(expected: readonly string[], timeoutMs: number): Promise<string[]> {
    return new Promise(resolve => {
      const never = (): string[] => expected.filter(u => !this.worldReady.has(u));
      // still worth waiting for: not ready yet, and still connected
      const outstanding = (): string[] => never().filter(u => this.joined.has(u));
      if (outstanding().length === 0) return resolve(never());
      const timer = setTimeout(() => finish(), timeoutMs);
      const check = (): void => {
        if (outstanding().length === 0) finish();
      };
      const finish = (): void => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter(w => w !== check);
        resolve(never());
      };
      this.waiters.push(check);
    });
  }

  /**
   * Announce the match: every joined peer gets its hello and starts building
   * its world. Snapshots only start flowing once `update()` is called, which
   * the caller does after `waitForReady`, so nobody is left behind.
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
    const hf = g.terrainProvider.heightfield;
    return {
      t: 's',
      tick: g.tick,
      timeS: g.time,
      timeLeftS: g.timeLeft,
      phase: g.matchPhase,
      scores: [st.scores[0], st.scores[1]],
      crates: st.contraband.map(c => ({
        i: c.id,
        p: [c.pos.x, c.pos.y - hf.sample(c.pos.x, c.pos.z), c.pos.z] as [number, number, number],
        c: c.carrier?.id ?? null,
        d: c.delivered ? 1 as const : 0 as const
      })),
      bodies: g.vehicles.map(a => {
        const b = a.body;
        return {
          id: b.id,
          p: [b.pos.x, b.pos.y - b.groundY, b.pos.z],
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
      if (this.tokens[m.uid] !== m.token) {
        log.warn('join refused: bad token', { uid: m.uid, from });
        return;
      }
      if (this.peerUid.has(from) || this.joined.has(m.uid)) {
        log.warn('join refused: seat or peer already bound', { uid: m.uid, from });
        return;
      }
      log.info('peer seated', { uid: m.uid, from });
      this.peerUid.set(from, m.uid);
      this.joined.add(m.uid);
      if (this.hello) this.transport.send(encode({ t: 'h', ...this.hello }), from);
      for (const w of [...this.waiters]) w();
      return;
    }
    if (m.t === 'r') {
      const uid = this.peerUid.get(from);
      if (!uid) return;
      log.info('peer world ready', { uid });
      this.worldReady.add(uid);
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
