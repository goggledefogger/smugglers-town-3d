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
import { VehicleBody, type BuildingCollider, type VehiclePhysicsConfig } from '../core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../core/physics/vehicleStats.ts';
import { resolveVehicleCollisions } from '../core/physics/vehicleCollisions.ts';
import { segmentVsAabb } from '../core/physics/collision.ts';
import { MatchRules } from '../core/gameplay/MatchRules.ts';
import { DriverBrain, type RouteFn } from '../core/ai/DriverBrain.ts';
import { NavGrid, type FlowField } from '../core/world/NavGrid.ts';
import { SpawnPlanner, DEFAULT_SPAWN } from '../core/spawn/SpawnPlanner.ts';
import { mulberry32, type Rng } from '../core/rng.ts';
import { navMarkerFor } from './navTarget.ts';
import { buildHudSnapshot } from './hudSnapshot.ts';
import type { TerrainProvider } from '../core/terrain/TerrainProvider.ts';
import type { VehicleInput } from '../core/physics/vehicleStats.ts';
import type { SurfaceElevationFn } from '../core/physics/VehicleBody.ts';
import type { GameEvents } from './events.ts';
import type { HudSnapshot, Store } from './store.ts';

/** Who drives an actor: the keyboard here, a bot, or a remote player's uid. */
export type Control = 'local' | 'bot' | string;

export interface VehicleActor {
  readonly body: VehicleBody;
  readonly team: 0 | 1;
  /** The local human's car; the camera, HUD and keyboard follow it. */
  readonly isPlayer: boolean;
  readonly label: string;
  readonly control: Control;
  brain: DriverBrain | null;
}

/** One seat in a match; the host builds the list from the lobby, single player from config. */
export interface Seat {
  readonly name: string;
  readonly team: 0 | 1;
  /** Roster index into VEHICLE_TYPES; bots draw one from the seed when null. */
  readonly vehicle: number | null;
  readonly control: Control;
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
  /** Match seed: the same seed and world give the same layout everywhere. */
  readonly seed?: number;
}

export type MatchPhase = 'countdown' | 'playing' | 'suddenDeath' | 'gameover';

const UP = new Vector3(0, 1, 0);
/** Broadphase cell for building colliders; a car only tests the 3×3 cells around it. */
const BROAD_CELL = 40;
const cellKey = (i: number, j: number): number => (i + 2048) * 4096 + (j + 2048);
/** Landing damage and tumbles are off for this long after a spawn or respawn. */
const SPAWN_GRACE_S = 2;
/** The camera keeps this much clearance from building faces. */
const CAMERA_PAD = 1.2;
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
  private readonly nav = new NavGrid(config.world.mapHalf * 2, 6);
  private readonly rng: Rng;
  private readonly spawn: SpawnPlanner;
  private readonly fields = new Map<string, CachedField>();
  private readonly _wp = new Vector3();
  /** Roster index the player drives at the next spawn (garage choice); persists across rematches. */
  playerType = 2;
  /** Latest input from each remote driver, by uid; applied every step until replaced. */
  private readonly remoteInputs = new Map<string, VehicleInput>();
  /** Sim steps since the match started; the host stamps snapshots with it. */
  private tickCount = 0;
  private surfaceProvider?: SurfaceElevationFn | undefined;

  setSurfaceProvider(fn: SurfaceElevationFn | undefined): void {
    this.surfaceProvider = fn;
  }

  constructor(
    private terrain: TerrainProvider,
    private readonly deps: GameDeps
  ) {
    this.round = deps.round ?? config.match;
    this.rng = mulberry32(deps.seed ?? (Math.random() * 2 ** 32) >>> 0);
    // the nav grid is the world's occupancy: the AI routes on it and the
    // spawner measures open ground with it
    this.spawn = new SpawnPlanner(
      { ...DEFAULT_SPAWN, mapHalf: config.world.mapHalf, arenaRadius: config.world.arenaRadius }, this.nav, this.rng
    );
    this.match = new MatchRules(config.scoring, this.bodies, this.teams, terrain.heightfield, this.spawn);
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
    const q = this.nav.cell * 2;
    const key = `${kind}:${Math.round(to.x / q)}:${Math.round(to.z / q)}`;
    let e = this.fields.get(key);
    const moved = e ? Math.hypot(e.x - to.x, e.z - to.z) : Infinity;
    if (!e || moved > this.nav.cell * 4 || (moved > 0 && this.timeS - e.at > 0.5)) {
      if (this.fields.size > 16) {
        for (const [k, old] of this.fields) {
          if (this.timeS - old.at > 5.0 || this.fields.size > 16) {
            this.fields.delete(k);
          }
        }
      }
      e = { field: this.nav.flowField(to.x, to.z), x: to.x, z: to.z, at: this.timeS };
      this.fields.set(key, e);
    }
    return e.field.waypoint(from.x, from.z, 3, this._wp);
  };

  /** Full reset for a new match (new terrain or rematch). Set colliders first so spawns avoid them. */
  reset(terrain: TerrainProvider, seats: readonly Seat[] = this.defaultSeats()): void {
    this.terrain = terrain;
    this.tickCount = 0;
    this.remoteInputs.clear();
    this.match = new MatchRules(config.scoring, this.bodies, this.teams, terrain.heightfield, this.spawn);
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
    this.spawnAllVehicles(seats);
    this.match.placeBases();
    this.match.spawnContraband();
  }

  /** Single player: the garage pick in seat 0, bots in the rest, teams split down the middle. */
  private defaultSeats(): Seat[] {
    const total = config.match.teamSize * 2;
    return Array.from({ length: total }, (_, i) => ({
      name: '',
      team: i < config.match.teamSize ? 0 : 1,
      vehicle: i === 0 ? this.playerType : null,
      control: i === 0 ? 'local' : 'bot'
    }));
  }

  private spawnAllVehicles(seats: readonly Seat[]): void {
    const hf = this.terrain.heightfield;
    // one planner call for every driver, human and AI alike
    const points = this.spawn.matchSpawns(seats.length, i => seats[i]!.team);
    seats.forEach((seat, i) => {
      const isPlayer = seat.control === 'local';
      const typeIdx = seat.vehicle ?? this.pickVehicleType();
      const body = new VehicleBody(VEHICLE_TYPES[typeIdx]!, PHYSICS, this.rng);
      const at = points[i]!;
      // released above the ground: the drop settles during the countdown
      body.pos.set(at.x, hf.sample(at.x, at.z) + this.spawn.dropHeight, at.z);
      body.quat.setFromAxisAngle(UP, at.yaw);
      body.graceS = SPAWN_GRACE_S;
      body.snapPrev();
      this.teams.set(body.id, seat.team);
      this.bodies.push(body);
      this.vehicles.push({
        body,
        team: seat.team,
        isPlayer,
        label: isPlayer ? 'YOU' : seat.name || VEHICLE_TYPES[typeIdx]!.name,
        control: seat.control,
        brain: seat.control === 'bot'
          ? new DriverBrain(config.ai, v => this.teams.get(v.id) ?? 0, this.rng)
          : null
      });
    });
  }

  /** A remote driver's latest input; the host applies it every step until the next arrives. */
  setRemoteInput(uid: string, input: VehicleInput): void {
    this.remoteInputs.set(uid, input);
  }

  bodyById(id: number): VehicleBody | undefined {
    return this.vehicles.find(a => a.body.id === id)?.body;
  }

  get tick(): number {
    return this.tickCount;
  }

  get time(): number {
    return this.timeS;
  }

  get timeLeft(): number {
    return this.timeLeftS;
  }

  get matchWinner(): 0 | 1 | null {
    return this.winner;
  }

  /** Bot vehicle mix, drawn from the match seed. */
  private pickVehicleType(): number {
    const r = this.rng();
    if (r < 0.3) return 2;
    if (r < 0.5) return 3;
    if (r < 0.7) return 1;
    if (r < 0.85) return 0;
    return 4;
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

  /**
   * Fraction of the segment from `from` to `to` that is clear of buildings
   * (1 = all of it). The chase camera uses it to pull in rather than sit
   * inside the block behind the car; props are ignored so a cactus between
   * camera and car does not snap the view
   */
  lineOfSight(from: Vector3, to: Vector3): number {
    let best = 1;
    for (const p of [from, to]) {
      for (const box of this.collidersNear(p)) {
        if (box.kind === 'prop') continue;
        const t = segmentVsAabb(from, to, box.min, box.max, CAMERA_PAD);
        if (t < best) best = t;
      }
    }
    return best;
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
      control: 'local',
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
    this.tickCount++;
    if (this.phase === 'countdown') {
      this.stepCountdown(dt);
      return;
    }
    this.timeS += dt;
    if (this.phase === 'playing') this.tickClock(dt);
    if (this.phase === 'gameover') return;
    for (const actor of this.vehicles) {
      let input: VehicleInput;
      if (actor.brain) {
        actor.brain.think(dt, actor.body, this.match.state, this.route);
        input = actor.brain.input();
      } else if (actor.control === 'local') {
        input = playerInput ?? NEUTRAL_INPUT;
      } else {
        input = this.remoteInputs.get(actor.control) ?? NEUTRAL_INPUT;
      }
      actor.body.step(dt, input, this.terrain.heightfield, this.collidersNear(actor.body.pos), this.surfaceProvider);
    }
    resolveVehicleCollisions(this.bodies, (a, b) => this.match.onRam(a, b, this.timeS), this.rng);
    for (const actor of this.vehicles) {
      if (actor.body.damage >= 1) this.wreck(actor);
    }
    this.match.checkPickup();
    this.match.checkDelivery();
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
      actor.body.step(dt, NEUTRAL_INPUT, this.terrain.heightfield, this.collidersNear(actor.body.pos), this.surfaceProvider);
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
    body.pos.set(p.x, this.terrain.heightfield.sample(p.x, p.z) + this.spawn.dropHeight, p.z);
    body.vel.set(0, 0, 0);
    body.angVel.set(0, 0, 0);
    body.quat.setFromAxisAngle(UP, p.yaw);
    body.damage = 0;
    body.graceS = SPAWN_GRACE_S;
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



  navMarker(): { yaw: number; distance: number; target: Vector3 } | null {
    const player = this.player;
    return player ? navMarkerFor(this.match.state, player, this.vehicles) : null;
  }

  private pushHud(): void {
    const player = this.player;
    if (!player) return;
    this.deps.store.set(buildHudSnapshot({
      state: this.match.state,
      player,
      vehicles: this.vehicles,
      phase: this.phase,
      timeLeftS: this.timeLeftS,
      locationLabel: this.terrain.label,
      winner: this.winner
    }));
  }
}

const NEUTRAL_INPUT: VehicleInput = { throttle: 0, brake: 0, steer: 0, jump: false };

