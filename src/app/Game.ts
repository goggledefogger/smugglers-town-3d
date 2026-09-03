/**
 * Game — the simulation root. Owns the world (terrain, vehicles, match), steps
 * physics/gameplay at a fixed 60 Hz via an accumulator, and pushes HUD
 * snapshots to the store. Rendering subscribes to world state; Game never
 * touches the renderer directly.
 *
 * A match runs countdown → playing → (suddenDeath) → gameover. The clock
 * only runs while playing; at zero the leader wins, a tie goes to sudden
 * death where the next delivery wins. Win-at-scoreGoal applies throughout.
 */
import { Vector3 } from 'three';
import { config } from './config.ts';
import { WORLD_M_PER_M } from '../core/geo/ecef.ts';
import { VehicleBody, type BuildingCollider, type VehiclePhysicsConfig } from '../core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../core/physics/vehicleStats.ts';
import { resolveVehicleCollisions } from '../core/physics/vehicleCollisions.ts';
import { MatchRules } from '../core/gameplay/MatchRules.ts';
import { DriverBrain, type RouteFn } from '../core/ai/DriverBrain.ts';
import { NavGrid, type FlowField } from '../core/ai/NavGrid.ts';
import type { TerrainProvider } from '../core/terrain/TerrainProvider.ts';
import type { VehicleInput } from '../core/physics/vehicleStats.ts';
import type { GameEvents } from './events.ts';
import type { HudSnapshot, Store } from './store.ts';

export interface VehicleActor {
  readonly body: VehicleBody;
  readonly team: 0 | 1;
  readonly isPlayer: boolean;
  readonly label: string;
  brain: DriverBrain | null;
}

export interface RoundConfig {
  readonly roundS: number;
  readonly countdownS: number;
  readonly finalMinuteS: number;
}

export interface GameDeps {
  readonly events: GameEvents;
  readonly store: Store<HudSnapshot>;
  /** Defaults to config.match; tests shorten it. */
  readonly round?: RoundConfig;
}

export type MatchPhase = 'countdown' | 'playing' | 'suddenDeath' | 'gameover';

const _tmpV = new Vector3();
const _tmpFwd = new Vector3();
const UP = new Vector3(0, 1, 0);
/** Broadphase cell for building colliders; a car only tests the 3×3 cells around it. */
const BROAD_CELL = 40;
const cellKey = (i: number, j: number): number => (i + 2048) * 4096 + (j + 2048);
/** The one place physics tuning enters the sim: app/config, with the field size folded in. */
const PHYSICS: VehiclePhysicsConfig = { ...config.physics, worldHalf: config.world.mapHalf };

interface CachedField {
  readonly field: FlowField;
  readonly x: number;
  readonly z: number;
  readonly at: number;
}

export class Game {
  readonly vehicles: VehicleActor[] = [];
  /** Live body list shared with MatchRules (same array, mutated in place). */
  private readonly bodies: VehicleBody[] = [];
  private match: MatchRules;
  private teams = new Map<number, 0 | 1>();
  private accumulator = 0;
  /** Fraction of a step elapsed since the last one; views interpolate poses by it. */
  alpha = 1;
  private timeS = 0;
  private winner: 0 | 1 | null = null;
  private buildingColliders: BuildingCollider[] = [];
  private readonly colliderCells = new Map<number, BuildingCollider[]>();
  private readonly _near: BuildingCollider[] = [];
  private readonly _seen = new Set<BuildingCollider>();
  private hudTimer = 0;
  private readonly round: RoundConfig;
  private phase: MatchPhase = 'countdown';
  private countdownLeft = 0;
  private lastCountdownN = -1;
  private timeLeftS = 0;
  private finalMinuteShown = false;
  private readonly nav = new NavGrid(config.world.mapHalf * 2);
  private readonly fields = new Map<string, CachedField>();
  private readonly _wp = new Vector3();
  /** Roster index the player drives at the next spawn (garage choice); persists across rematches. */
  playerType = 2;

  constructor(
    private terrain: TerrainProvider,
    private readonly deps: GameDeps
  ) {
    this.round = deps.round ?? config.match;
    this.match = new MatchRules(
      config.scoring, this.bodies, this.teams, terrain.heightfield, config.world.mapHalf, this.blockedWithin
    );
  }

  /** True when any building collider comes within r of (x, z). */
  readonly blockedWithin = (x: number, z: number, r: number): boolean =>
    this.buildingColliders.some(c => x + r > c.min.x && x - r < c.max.x && z + r > c.min.z && z - r < c.max.z);

  /**
   * Waypoint for a bot at `from` heading to `to`, routed around buildings on
   * the nav grid; null means drive straight. Fields are cached per target
   * kind: bases never move, the contraband rarely, the carrier constantly.
   */
  readonly route: RouteFn = (kind, from, to) => {
    if (this.nav.isEmpty) return null;
    let e = this.fields.get(kind);
    const moved = e ? Math.hypot(e.x - to.x, e.z - to.z) : Infinity;
    if (!e || moved > this.nav.cell * 4 || (moved > 0 && this.timeS - e.at > 0.5)) {
      e = { field: this.nav.flowField(to.x, to.z), x: to.x, z: to.z, at: this.timeS };
      this.fields.set(kind, e);
    }
    return e.field.waypoint(from.x, from.z, 3, this._wp);
  };

  /**
   * Most open spot near the field center: the first candidate (nearest the
   * center first) clear at the largest radius that any candidate satisfies.
   * Dropping the whole spawn ring there is what keeps a downtown start from
   * wedging cars between towers.
   */
  private findOpenCenter(): { x: number; z: number } {
    for (const r of [40, 28, 18, 12, 8]) {
      for (const [x, z] of SPAWN_CANDIDATES) {
        if (!this.blockedWithin(x, z, r)) return { x, z };
      }
    }
    return { x: 0, z: 0 };
  }

  /** Full reset for a new match (new terrain or rematch). Set colliders first so spawns avoid them. */
  reset(terrain: TerrainProvider): void {
    this.terrain = terrain;
    this.match = new MatchRules(
      config.scoring, this.bodies, this.teams, terrain.heightfield, config.world.mapHalf, this.blockedWithin
    );
    this.winner = null;
    this.timeS = 0;
    this.accumulator = 0;
    this.timeLeftS = this.round.roundS;
    this.finalMinuteShown = false;
    this.countdownLeft = this.round.countdownS;
    this.lastCountdownN = -1;
    this.phase = this.round.countdownS > 0 ? 'countdown' : 'playing';
    this.fields.clear();
    // building colliders belong to the terrain, not the match: a rematch on
    // real terrain keeps them and a relocation replaces them explicitly
    this.vehicles.length = 0;
    this.bodies.length = 0;
    this.teams.clear();
    this.spawnAllVehicles();
    this.match.placeBases();
    this.match.spawnContraband();
  }

  private spawnAllVehicles(): void {
    const total = config.match.teamSize * 2;
    const hf = this.terrain.heightfield;
    const center = this.findOpenCenter();
    for (let i = 0; i < total; i++) {
      const team = i < config.match.teamSize ? 0 : 1;
      const isPlayer = i === 0;
      const typeIdx = isPlayer ? this.playerType : pickVehicleType();
      const body = new VehicleBody(VEHICLE_TYPES[typeIdx]!, PHYSICS);
      const ang = (i / total) * Math.PI * 2;
      // ring around the open spot; walk outward along the ray if a slot is still blocked
      let x = 0, z = 0;
      for (let tries = 0; tries < 12; tries++) {
        const r = 20 + i * 2 + tries * 8;
        x = center.x + Math.cos(ang) * r;
        z = center.z + Math.sin(ang) * r;
        if (!this.blockedWithin(x, z, 4)) break;
      }
      body.pos.set(x, hf.sample(x, z) + 3, z);
      body.quat.setFromAxisAngle(UP, -ang + Math.PI / 2);
      body.snapPrev();
      this.teams.set(body.id, team);
      this.bodies.push(body);
      this.vehicles.push({
        body,
        team,
        isPlayer,
        label: isPlayer ? 'YOU' : VEHICLE_TYPES[typeIdx]!.name,
        brain: isPlayer ? null : new DriverBrain(config.ai, v => this.teams.get(v.id) ?? 0)
      });
    }
  }

  get player(): VehicleActor | undefined {
    return this.vehicles.find(v => v.isPlayer);
  }

  get state() {
    return this.match.state;
  }

  get matchPhase(): MatchPhase {
    return this.phase;
  }

  get terrainProvider(): TerrainProvider {
    return this.terrain;
  }

  setBuildingColliders(c: BuildingCollider[]): void {
    this.buildingColliders = c;
    this.nav.rebuild(c);
    this.fields.clear();
    // spatial hash: a downtown has thousands of boxes and 8 cars × 60 Hz
    // can't afford to test them all
    this.colliderCells.clear();
    for (const box of c) {
      for (let j = Math.floor(box.min.z / BROAD_CELL); j <= Math.floor(box.max.z / BROAD_CELL); j++) {
        for (let i = Math.floor(box.min.x / BROAD_CELL); i <= Math.floor(box.max.x / BROAD_CELL); i++) {
          const k = cellKey(i, j);
          let list = this.colliderCells.get(k);
          if (!list) this.colliderCells.set(k, list = []);
          list.push(box);
        }
      }
    }
  }

  /** Colliders that could touch a car at p: its cell and the eight around it. Reuses one scratch array. */
  private collidersNear(p: Vector3): readonly BuildingCollider[] {
    const out = this._near;
    out.length = 0;
    if (this.colliderCells.size === 0) return out;
    this._seen.clear();
    const ci = Math.floor(p.x / BROAD_CELL), cj = Math.floor(p.z / BROAD_CELL);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const list = this.colliderCells.get(cellKey(ci + di, cj + dj));
        if (!list) continue;
        for (const box of list) {
          if (!this._seen.has(box)) {
            this._seen.add(box);
            out.push(box);
          }
        }
      }
    }
    return out;
  }

  /** Swap the player's vehicle type in place, keeping position and velocity. */
  switchPlayerVehicle(typeIdx: number): void {
    if (typeIdx < 0 || typeIdx >= VEHICLE_TYPES.length) return;
    this.playerType = typeIdx;
    const player = this.vehicles.find(a => a.isPlayer);
    if (!player) return;
    const pos = player.body.pos.clone();
    const quat = player.body.quat.clone();
    const vel = player.body.vel.clone();
    const replacement = new VehicleBody(VEHICLE_TYPES[typeIdx]!, PHYSICS);
    replacement.pos.copy(pos);
    replacement.quat.copy(quat);
    replacement.vel.copy(vel);
    replacement.snapPrev();
    this.teams.set(replacement.id, player.team);
    this.bodies[this.bodies.indexOf(player.body)] = replacement;
    this.match.swapVehicle(player.body, replacement);
    const idx = this.vehicles.indexOf(player);
    this.vehicles[idx] = {
      body: replacement,
      team: player.team,
      isPlayer: true,
      label: 'YOU',
      brain: null
    };
  }

  /** Advance the simulation by frameDt seconds (fixed-step inside). */
  update(frameDt: number, playerInput: VehicleInput | null): void {
    if (this.phase === 'gameover') return;
    const dt = Math.min(frameDt, config.loop.maxFrameDt);
    this.accumulator += dt;
    while (this.accumulator >= config.loop.step) {
      this.stepSim(config.loop.step, playerInput);
      this.accumulator -= config.loop.step;
    }
    // views draw prev→current poses at this fraction: without it a 120 Hz
    // display shows the sim advancing every other frame, which reads as stutter
    this.alpha = this.accumulator / config.loop.step;
    this.hudTimer += dt;
    if (this.hudTimer > 0.1) {
      this.hudTimer = 0;
      this.pushHud();
    }
  }

  private stepSim(dt: number, playerInput: VehicleInput | null): void {
    if (this.phase === 'countdown') {
      this.stepCountdown(dt);
      return;
    }
    this.timeS += dt;
    if (this.phase === 'playing') this.tickClock(dt);
    if (this.phase === 'gameover') return;
    for (const actor of this.vehicles) {
      let input: VehicleInput;
      if (actor.isPlayer) {
        input = playerInput ?? NEUTRAL_INPUT;
      } else {
        actor.brain!.think(dt, actor.body, this.match.state, this.route);
        input = actor.brain!.input();
      }
      actor.body.step(dt, input, this.terrain.heightfield, this.collidersNear(actor.body.pos));
    }
    resolveVehicleCollisions(
      this.bodies,
      { ramRadius: config.ram.ramRadius, transferCooldownS: config.scoring.transferCooldownS },
      1,
      (a, b) => this.match.onRam(a, b, this.timeS)
    );
    for (const actor of this.vehicles) {
      if (actor.body.damage >= 1) this.wreck(actor);
    }
    this.match.checkPickup(1);
    this.match.checkDelivery(1);
    this.processMatchEvents();
  }

  /** Cars settle onto the ground, nobody drives, the banner counts 3-2-1-go. */
  private stepCountdown(dt: number): void {
    const n = Math.ceil(this.countdownLeft);
    if (n !== this.lastCountdownN) {
      this.lastCountdownN = n;
      this.deps.events.emit('match:countdown', { n });
    }
    for (const actor of this.vehicles) {
      actor.body.step(dt, NEUTRAL_INPUT, this.terrain.heightfield, this.collidersNear(actor.body.pos));
    }
    this.countdownLeft -= dt;
    if (this.countdownLeft <= 0) {
      this.phase = 'playing';
      this.deps.events.emit('match:countdown', { n: 0 });
    }
  }

  private tickClock(dt: number): void {
    this.timeLeftS = Math.max(0, this.timeLeftS - dt);
    if (!this.finalMinuteShown && this.timeLeftS <= this.round.finalMinuteS) {
      this.finalMinuteShown = true;
      this.deps.events.emit('match:finalMinute', {});
    }
    if (this.timeLeftS > 0) return;
    const s = this.match.state.scores;
    if (s[0] !== s[1]) {
      this.endMatch(s[0] > s[1] ? 0 : 1);
    } else {
      this.phase = 'suddenDeath';
      this.deps.events.emit('match:suddenDeath', {});
    }
  }

  private endMatch(team: 0 | 1): void {
    this.winner = team;
    this.phase = 'gameover';
    this.deps.events.emit('match:win', { team });
    this.pushHud();
  }

  /** Integrity hit zero: the crate drops where the car died and the car respawns near its base. */
  private wreck(actor: VehicleActor): void {
    const body = actor.body;
    this.match.dropFrom(body);
    const p = this.match.respawnPoint(actor.team);
    body.pos.set(p.x, this.terrain.heightfield.sample(p.x, p.z) + 3, p.z);
    body.vel.set(0, 0, 0);
    body.angVel.set(0, 0, 0);
    body.quat.setFromAxisAngle(UP, Math.atan2(p.x, p.z)); // face the field center
    body.damage = 0;
    body.snapPrev();
    this.deps.events.emit('vehicle:wrecked', { vehicleId: body.id });
  }

  private processMatchEvents(): void {
    for (const e of this.match.drainEvents()) {
      switch (e.type) {
        case 'pickup':
          this.deps.events.emit('contraband:pickup', { vehicleId: e.vehicle.id });
          break;
        case 'drop':
          this.deps.events.emit('contraband:dropped', { vehicleId: e.vehicle.id });
          break;
        case 'steal':
          this.deps.events.emit('contraband:stolen', { attackerId: e.attacker.id, victimId: e.victim.id });
          break;
        case 'deliver':
          this.deps.events.emit('contraband:delivered', { team: e.team });
          if (this.phase === 'suddenDeath') this.endMatch(e.team);
          break;
        case 'win':
          if (this.phase !== 'gameover') this.endMatch(e.team);
          break;
      }
    }
  }

  /** Where the player should be heading: their base when carrying, else the contraband. */
  private playerTarget(player: VehicleActor): Vector3 {
    const st = this.match.state;
    return st.carrier ? st.bases[player.team] : st.contrabandPos;
  }

  /**
   * Bearing from the player's heading to the target, radians clockwise from
   * straight ahead. Sampled every frame by the direction arrow, so it is
   * not part of the 10 Hz HUD snapshot.
   */
  targetBearing(): number {
    const player = this.player;
    if (!player) return 0;
    _tmpV.copy(this.playerTarget(player)).sub(player.body.pos);
    _tmpV.y = 0;
    if (_tmpV.lengthSq() < 1) return 0;
    _tmpV.normalize();
    const fwd = player.body.forward(_tmpFwd);
    fwd.y = 0;
    fwd.normalize();
    // ahead first: cross() below overwrites _tmpV with the cross product
    const ahead = _tmpV.dot(fwd);
    const right = _tmpV.cross(fwd).y;
    return Math.atan2(right, ahead);
  }

  private pushHud(): void {
    const player = this.player;
    if (!player) return;
    const st = this.match.state;
    const carrierActor = st.carrier ? this.vehicles.find(a => a.body === st.carrier) : null;
    const target = this.playerTarget(player);
    this.deps.store.set({
      phase: this.phase,
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
      locationLabel: this.terrain.label,
      winner: this.winner,
      teamPips: this.vehicles.map(a => ({ team: a.team, isPlayer: a.isPlayer }))
    });
  }
}

function pickVehicleType(): number {
  const r = Math.random();
  if (r < 0.3) return 2;
  if (r < 0.5) return 3;
  if (r < 0.7) return 1;
  if (r < 0.85) return 0;
  return 4;
}

const NEUTRAL_INPUT: VehicleInput = { throttle: 0, brake: 0, steer: 0, jump: false };

/** 30-unit grid within ±210 of the field center, nearest first. */
const SPAWN_CANDIDATES: readonly (readonly [number, number])[] = (() => {
  const pts: [number, number][] = [];
  for (let x = -210; x <= 210; x += 30) for (let z = -210; z <= 210; z += 30) pts.push([x, z]);
  return pts.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
})();
