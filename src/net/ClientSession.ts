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
import type { MatchState } from '../core/gameplay/MatchRules.ts';
import { WORLD_M_PER_M } from '../core/geo/ecef.ts';
import { VehicleBody } from '../core/physics/VehicleBody.ts';
import { VEHICLE_TYPES, type VehicleInput } from '../core/physics/vehicleStats.ts';
import type { TerrainProvider } from '../core/terrain/TerrainProvider.ts';
import type { Transport } from './Transport.ts';
import { decode, encode, inputToMsg, type BodySnap, type HelloMsg, type SnapshotMsg } from './protocol.ts';

const INPUT_HZ = 30;
/** Render this many sim ticks behind the newest snapshot so there is always a pair to blend. */
const DELAY_TICKS = 4;
/** A jump larger than this between snapshots is a respawn: cut, don't slide. */
const TELEPORT_UNITS = 40;
const _qa = new Quaternion();
const _qb = new Quaternion();
const _tmpV = new Vector3();
const _tmpFwd = new Vector3();

interface MutableState {
  scores: Record<0 | 1, number>;
  carrier: VehicleBody | null;
  contrabandPos: Vector3;
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
    readonly terrainProvider: TerrainProvider
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
      contrabandPos: new Vector3(),
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
      this.snaps.push(m);
      if (this.snaps.length > 4) this.snaps.shift();
      // scalar match state needs no blending: the newest is the truth
      this.matchPhase = m.phase;
      this.timeLeftS = m.timeLeftS;
      this.st.scores = { 0: m.scores[0], 1: m.scores[1] };
      this.st.carrier = m.carrier === null ? null : this.byId.get(m.carrier)?.body ?? null;
      this.st.contrabandPos.set(m.crate[0], m.crate[1], m.crate[2]);
      if (m.phase === 'gameover') this.st.winner = m.scores[0] >= m.scores[1] ? 0 : 1;
      return;
    }
    if (m.t === 'e') {
      // the payload types line up by construction of EventMsg; the bus is not generic over a union
      (this.events.emit as (name: string, payload: unknown) => void)(m.name, m.payload);
    }
  }

  /** Blend each puppet between the two snapshots around the render tick. */
  private interpolate(dt: number): void {
    const n = this.snaps.length;
    if (n === 0) return;
    const newest = this.snaps[n - 1]!;
    const target = newest.tick - DELAY_TICKS;
    // free-run the clock at sim rate; snap if it has fallen far behind (a stall)
    this.renderTick = target - this.renderTick > 20 ? target : Math.min(target, this.renderTick + dt * 60);
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
      body.pos.set(sa.p[0] + dx * t, sa.p[1] + dy * t, sa.p[2] + dz * t);
      _qa.set(sa.q[0], sa.q[1], sa.q[2], sa.q[3]);
      _qb.set(sb.q[0], sb.q[1], sb.q[2], sb.q[3]);
      body.quat.slerpQuaternions(_qa, _qb, t);
      body.vel.set(sb.v[0], sb.v[1], sb.v[2]);
      body.speed = body.vel.length();
      body.damage = sb.d;
      body.onGround = sb.g === 1;
      body.groundY = this.terrainProvider.heightfield.sample(body.pos.x, body.pos.z);
      body.snapPrev();
    }
  }

  targetBearing(): number {
    const player = this.player;
    if (!player) return 0;
    const target = this.st.carrier ? this.st.bases[player.team] : this.st.contrabandPos;
    _tmpV.copy(target).sub(player.body.pos);
    _tmpV.y = 0;
    if (_tmpV.lengthSq() < 1) return 0;
    _tmpV.normalize();
    const fwd = player.body.forward(_tmpFwd);
    fwd.y = 0;
    fwd.normalize();
    const ahead = _tmpV.dot(fwd);
    const right = _tmpV.cross(fwd).y;
    return Math.atan2(right, ahead);
  }

  private pushHud(): void {
    const player = this.player;
    if (!player) return;
    const st = this.st;
    const carrierActor = st.carrier ? this.vehicles.find(a => a.body === st.carrier) : null;
    const target = st.carrier ? st.bases[player.team] : st.contrabandPos;
    this.store.set({
      phase: this.matchPhase,
      timeLeftS: this.timeLeftS,
      speed: player.body.speed,
      damage: player.body.damage,
      vehicleName: player.body.stats.name,
      scores: st.scores,
      carrierName: carrierActor ? (carrierActor.isPlayer ? 'YOU' : carrierActor.label) : null,
      carrierIsPlayer: carrierActor?.isPlayer ?? false,
      carrierIsAlly: carrierActor ? carrierActor.team === player.team : false,
      objective: st.carrier ? 'DELIVER CONTRABAND' : 'FIND CONTRABAND',
      distanceToTargetM: player.body.pos.distanceTo(target) / WORLD_M_PER_M,
      targetIsDelivery: st.carrier !== null,
      locationLabel: this.terrainProvider.label,
      winner: st.winner,
      teamPips: this.vehicles.map(a => ({ team: a.team, isPlayer: a.isPlayer }))
    });
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.transport.leave();
  }
}
