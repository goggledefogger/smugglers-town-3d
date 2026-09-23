/**
 * A client's side of a match: no simulation at all. It mirrors the host's
 * bodies as puppets, interpolated between the two most recent snapshots
 * about `DELAY_TICKS` behind the host, sends the local input at `INPUT_HZ`,
 * and replays the host's gameplay events into the local bus so the HUD and
 * banners work unchanged. It presents the same `WorldView` as `Game`.
 */
import { Quaternion, Vector3 } from 'three';
import type { WorldView } from '../app/WorldView.ts';
import type { MatchPhase, VehicleActor } from '../app/Game.ts';
import type { GameEvents } from '../app/events.ts';
import type { HudSnapshot, Store } from '../app/store.ts';
import { navMarkerFor } from '../app/navTarget.ts';
import { buildHudSnapshot } from '../app/hudSnapshot.ts';
import type { Crate, MatchState } from '../core/gameplay/MatchRules.ts';
import { VehicleBody, type SurfaceElevationFn } from '../core/physics/VehicleBody.ts';
import { VEHICLE_TYPES, type VehicleInput } from '../core/physics/vehicleStats.ts';
import type { TerrainProvider } from '../core/terrain/TerrainProvider.ts';
import type { Transport } from './Transport.ts';
import { decode, encode, inputToMsg, type BodySnap, type HelloMsg, type SnapshotMsg } from './protocol.ts';
import { logger } from '../app/log.ts';

const log = logger('client');

const INPUT_HZ = 30;
/** Render this many sim ticks (100 ms) behind the newest snapshot so there is always a pair to blend. */
const DELAY_TICKS = 6;
/** Playback speed bends by this much per tick of error, within ±MAX_RATE_ADJUST, to hold that delay. */
const RATE_GAIN = 0.05;
const MAX_RATE_ADJUST = 0.15;
/** Further behind than this is a stall, not jitter: jump rather than race to catch up. */
const SNAP_TICKS = 30;
/** Snapshots kept: enough to cover SNAP_TICKS, else a lagging clock renders the oldest one frozen. */
const KEEP_SNAPS = 14;
/** A jump larger than this between snapshots is a respawn: cut, don't slide. */
const TELEPORT_UNITS = 40;
const _qa = new Quaternion();
const _qb = new Quaternion();

interface MutableState {
  scores: Record<0 | 1, number>;
  carrier: VehicleBody | null;
  contraband: Crate[];
  bases: Record<0 | 1, Vector3>;
  winner: 0 | 1 | null;
}

export class ClientSession implements WorldView {
  readonly vehicles: VehicleActor[] = [];
  readonly alpha = 1;
  matchPhase: MatchPhase = 'countdown';
  private readonly st: MutableState;
  private readonly byId = new Map<number, VehicleActor>();
  private readonly snaps: SnapshotMsg[] = [];
  private readonly unsubs: (() => void)[] = [];
  private renderTick = 0;
  private clockSet = false;
  private seq = 0;
  private inputTimer = 0;
  private hudTimer = 0;
  private timeLeftS = 0;

  constructor(
    hello: HelloMsg,
    selfUid: string,
    private readonly transport: Transport,
    private readonly events: GameEvents,
    private readonly store: Store<HudSnapshot>,
    readonly terrainProvider: TerrainProvider,
    /** This player's bridge decks and ramps, so a car the host has on one sits on ours. */
    private readonly surface?: SurfaceElevationFn
  ) {
    for (const e of hello.roster) {
      const stats = VEHICLE_TYPES[e.vehicle] ?? VEHICLE_TYPES[2]!;
      const isPlayer = e.owner === selfUid;
      const actor: VehicleActor = {
        body: new VehicleBody(stats, undefined, Math.random, e.id),
        team: e.team,
        isPlayer,
        label: isPlayer ? 'YOU' : e.name || stats.name,
        control: e.owner === null ? 'bot' : e.owner === selfUid ? 'local' : e.owner,
        brain: null
      };
      this.vehicles.push(actor);
      this.byId.set(e.id, actor);
    }
    this.st = {
      scores: { 0: 0, 1: 0 },
      carrier: null,
      contraband: [],
      bases: { 0: new Vector3(...hello.bases[0]), 1: new Vector3(...hello.bases[1]) },
      winner: null
    };
    this.unsubs.push(transport.onMessage(data => this.onMessage(data)));
  }

  get player(): VehicleActor | undefined {
    return this.vehicles.find(a => a.isPlayer);
  }

  get state(): MatchState {
    return this.st;
  }

  lineOfSight(): number {
    return 1;
  }

  update(dt: number, input: VehicleInput | null): void {
    this.inputTimer += dt;
    if (this.inputTimer >= 1 / INPUT_HZ) {
      this.inputTimer = 0;
      this.transport.send(encode(inputToMsg(input ?? { throttle: 0, brake: 0, steer: 0, jump: false }, ++this.seq)));
    }
    this.interpolate(dt);
    this.hudTimer += dt;
    if (this.hudTimer > 0.1) {
      this.hudTimer = 0;
      this.pushHud();
    }
  }

  private onMessage(data: string): void {
    const m = decode(data);
    if (!m) return;
    if (m.t === 's') {
      const last = this.snaps[this.snaps.length - 1];
      if (last && m.tick <= last.tick) return;
      if (!last) log.info('first snapshot', { tick: m.tick, bodies: m.bodies.length, phase: m.phase });
      this.snaps.push(m);
      if (this.snaps.length > KEEP_SNAPS) this.snaps.shift();
      // scalar match state needs no blending: the newest is the truth
      this.matchPhase = m.phase;
      this.timeLeftS = m.timeLeftS;
      this.st.scores = { 0: m.scores[0], 1: m.scores[1] };
      // the host owns the wave, so mirror its list rather than reconciling:
      // crate ids are stable within a wave and change wholesale between them
      this.st.contraband = m.crates.map(c => {
        const existing = this.st.contraband.find(e => e.id === c.i);
        const pos = existing?.pos ?? new Vector3();
        pos.set(c.p[0], this.terrainProvider.heightfield.sample(c.p[0], c.p[2]) + c.p[1], c.p[2]);
        return {
          id: c.i,
          pos,
          carrier: c.c === null ? null : this.byId.get(c.c)?.body ?? null,
          lastTransfer: -Infinity,
          delivered: c.d === 1
        };
      });
      if (m.phase === 'gameover') this.st.winner = m.scores[0] >= m.scores[1] ? 0 : 1;
      return;
    }
    if (m.t === 'e') {
      // the payload types line up by construction of EventMsg; the bus is not generic over a union
      (this.events.emit as (name: string, payload: unknown) => void)(m.name, m.payload);
    }
  }

  /**
   * Blend each puppet between the two snapshots around the render tick.
   * The render clock runs at sim rate with its speed bent toward holding
   * DELAY_TICKS behind the newest snapshot. A clock that is merely clamped
   * stalls on every late packet, falls further behind each time, and then
   * jumps — which reads as jerking and jamming
   */
  private interpolate(dt: number): void {
    const n = this.snaps.length;
    if (n === 0) return;
    const newest = this.snaps[n - 1]!;
    if (!this.clockSet) {
      this.clockSet = true;
      this.renderTick = newest.tick - DELAY_TICKS;
    }
    const behind = newest.tick - this.renderTick;
    if (behind > SNAP_TICKS) {
      this.renderTick = newest.tick - DELAY_TICKS;
    } else {
      const rate = 1 + Math.max(-MAX_RATE_ADJUST, Math.min(MAX_RATE_ADJUST, (behind - DELAY_TICKS) * RATE_GAIN));
      this.renderTick = Math.min(newest.tick, this.renderTick + dt * 60 * rate);
    }
    let a = this.snaps[0]!, b = newest;
    for (let i = n - 1; i > 0; i--) {
      if (this.snaps[i - 1]!.tick <= this.renderTick) {
        a = this.snaps[i - 1]!;
        b = this.snaps[i]!;
        break;
      }
    }
    const span = b.tick - a.tick;
    const f = span > 0 ? Math.min(1, Math.max(0, (this.renderTick - a.tick) / span)) : 1;
    const before = new Map<number, BodySnap>();
    for (const s of a.bodies) before.set(s.id, s);
    for (const sb of b.bodies) {
      const actor = this.byId.get(sb.id);
      if (!actor) continue;
      const body = actor.body;
      const sa = before.get(sb.id) ?? sb;
      const dx = sb.p[0] - sa.p[0], dy = sb.p[1] - sa.p[1], dz = sb.p[2] - sa.p[2];
      const cut = dx * dx + dy * dy + dz * dz > TELEPORT_UNITS * TELEPORT_UNITS;
      const t = cut ? 1 : f;
      // p[1] is height above the host's ground: stand it on ours
      const x = sa.p[0] + dx * t, z = sa.p[2] + dz * t;
      body.groundY = this.groundAt(x, z, body.pos.y);
      body.pos.set(x, body.groundY + sa.p[1] + dy * t, z);
      _qa.set(sa.q[0], sa.q[1], sa.q[2], sa.q[3]);
      _qb.set(sb.q[0], sb.q[1], sb.q[2], sb.q[3]);
      body.quat.slerpQuaternions(_qa, _qb, t);
      body.vel.set(sb.v[0], sb.v[1], sb.v[2]);
      body.speed = body.vel.length();
      body.damage = sb.d;
      body.onGround = sb.g === 1;
      body.snapPrev();
    }
  }


  /** Our driving surface at (x, z); nearY picks the deck nearest where the car last was. */
  private groundAt(x: number, z: number, nearY: number): number {
    const gy = this.terrainProvider.heightfield.sample(x, z);
    return this.surface?.(x, z, nearY, gy) ?? gy;
  }

  navMarker(): { yaw: number; distance: number; target: Vector3 } | null {
    const player = this.player;
    return player ? navMarkerFor(this.st, player, this.vehicles) : null;
  }

  private pushHud(): void {
    const player = this.player;
    if (!player) return;
    this.store.set(buildHudSnapshot({
      state: this.st,
      player,
      vehicles: this.vehicles,
      phase: this.matchPhase,
      timeLeftS: this.timeLeftS,
      locationLabel: this.terrainProvider.label,
      winner: this.st.winner
    }));
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.transport.leave();
  }
}
