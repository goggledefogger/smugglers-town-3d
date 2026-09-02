/**
 * Game — the simulation root. Owns the world (terrain, vehicles, match), steps
 * physics/gameplay at a fixed 60 Hz via an accumulator, and pushes HUD
 * snapshots to the store. Rendering subscribes to world state; Game never
 * touches the renderer directly.
 */
import { Vector3 } from 'three';
import { config } from './config.ts';
import { VehicleBody, type BuildingCollider } from '../core/physics/VehicleBody.ts';
import { VEHICLE_TYPES } from '../core/physics/vehicleStats.ts';
import { resolveVehicleCollisions } from '../core/physics/vehicleCollisions.ts';
import { MatchRules } from '../core/gameplay/MatchRules.ts';
import { DriverBrain } from '../core/ai/DriverBrain.ts';
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

export interface GameDeps {
  readonly events: GameEvents;
  readonly store: Store<HudSnapshot>;
}

const _tmpV = new Vector3();

export class Game {
  readonly vehicles: VehicleActor[] = [];
  private match: MatchRules;
  private teams = new Map<number, 0 | 1>();
  private accumulator = 0;
  private timeS = 0;
  private winner: 0 | 1 | null = null;
  private buildingColliders: BuildingCollider[] = [];
  private hudTimer = 0;

  constructor(
    private terrain: TerrainProvider,
    private readonly deps: GameDeps
  ) {
    this.match = new MatchRules(
      config.scoring, [], this.teams, terrain.heightfield, config.world.mapHalf, this.insideBuilding
    );
  }

  private readonly insideBuilding = (x: number, z: number): boolean =>
    this.buildingColliders.some(c => x >= c.min.x && x <= c.max.x && z >= c.min.z && z <= c.max.z);

  /** Full reset for a new match (new terrain or rematch). Set colliders first so spawns avoid them. */
  reset(terrain: TerrainProvider): void {
    this.terrain = terrain;
    this.match = new MatchRules(
      config.scoring, [], this.teams, terrain.heightfield, config.world.mapHalf, this.insideBuilding
    );
    this.winner = null;
    this.timeS = 0;
    this.accumulator = 0;
    // building colliders belong to the terrain, not the match: a rematch on
    // real terrain keeps them and a relocation replaces them explicitly
    this.vehicles.length = 0;
    this.teams.clear();
    this.spawnAllVehicles();
    this.match.spawnContraband();
    this.match.relocateDropZone();
  }

  private spawnAllVehicles(): void {
    const total = config.match.teamSize * 2;
    const hf = this.terrain.heightfield;
    for (let i = 0; i < total; i++) {
      const team = i < config.match.teamSize ? 0 : 1;
      const isPlayer = i === 0;
      const typeIdx = isPlayer ? 2 : pickVehicleType();
      const body = new VehicleBody(VEHICLE_TYPES[typeIdx]!);
      const ang = (i / total) * Math.PI * 2;
      // walk outward along the spawn ray until clear of buildings
      let x = 0, z = 0;
      for (let tries = 0; tries < 12; tries++) {
        const r = 20 + i * 2 + tries * 8;
        x = Math.cos(ang) * r;
        z = Math.sin(ang) * r;
        if (!this.insideBuilding(x, z)) break;
      }
      body.pos.set(x, hf.sample(x, z) + 3, z);
      body.quat.setFromAxisAngle(new Vector3(0, 1, 0), -ang + Math.PI / 2);
      this.teams.set(body.id, team);
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

  get terrainProvider(): TerrainProvider {
    return this.terrain;
  }

  setBuildingColliders(c: BuildingCollider[]): void {
    this.buildingColliders = c;
  }

  /** Swap the player's vehicle type in place, keeping position and velocity. */
  switchPlayerVehicle(typeIdx: number): void {
    if (typeIdx < 0 || typeIdx >= VEHICLE_TYPES.length) return;
    const player = this.vehicles.find(a => a.isPlayer);
    if (!player) return;
    const pos = player.body.pos.clone();
    const quat = player.body.quat.clone();
    const vel = player.body.vel.clone();
    const replacement = new VehicleBody(VEHICLE_TYPES[typeIdx]!);
    replacement.pos.copy(pos);
    replacement.quat.copy(quat);
    replacement.vel.copy(vel);
    this.teams.set(replacement.id, player.team);
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
    if (this.winner !== null) return;
    const dt = Math.min(frameDt, config.loop.maxFrameDt);
    this.accumulator += dt;
    while (this.accumulator >= config.loop.step) {
      this.stepSim(config.loop.step, playerInput);
      this.accumulator -= config.loop.step;
    }
    this.hudTimer += dt;
    if (this.hudTimer > 0.1) {
      this.hudTimer = 0;
      this.pushHud();
    }
  }

  private stepSim(dt: number, playerInput: VehicleInput | null): void {
    this.timeS += dt;
    for (const actor of this.vehicles) {
      let input: VehicleInput;
      if (actor.isPlayer) {
        input = playerInput ?? NEUTRAL_INPUT;
      } else {
        actor.brain!.think(dt, actor.body, this.match.state);
        input = actor.brain!.input();
      }
      actor.body.step(dt, input, this.terrain.heightfield, this.buildingColliders);
    }
    resolveVehicleCollisions(
      this.vehicles.map(a => a.body),
      { ramRadius: config.ram.ramRadius, transferCooldownS: config.scoring.transferCooldownS },
      1,
      (a, b) => this.match.onRam(a, b, this.timeS)
    );
    this.match.checkPickup(1);
    this.match.checkDelivery(1);
    this.processMatchEvents();
  }

  private processMatchEvents(): void {
    for (const e of this.match.drainEvents()) {
      switch (e.type) {
        case 'pickup':
          this.deps.events.emit('contraband:pickup', { vehicleId: e.vehicle.id });
          break;
        case 'steal':
          this.deps.events.emit('contraband:stolen', { attackerId: e.attacker.id, victimId: e.victim.id });
          break;
        case 'deliver':
          this.deps.events.emit('contraband:delivered', { team: e.team });
          break;
        case 'win':
          this.winner = e.team;
          this.deps.events.emit('match:win', { team: e.team });
          this.pushHud();
          break;
      }
    }
  }

  private pushHud(): void {
    const player = this.player;
    if (!player) return;
    const st = this.match.state;
    const carrierActor = st.carrier ? this.vehicles.find(a => a.body === st.carrier) : null;
    const target = st.carrier ? st.dropZonePos : st.contrabandPos;
    // screen-space bearing to the target, relative to the player's heading
    _tmpV.copy(target).sub(player.body.pos);
    _tmpV.y = 0;
    let bearing = 0;
    if (_tmpV.lengthSq() > 1) {
      _tmpV.normalize();
      const fwd = player.body.forward();
      fwd.y = 0;
      fwd.normalize();
      const right = _tmpV.cross(fwd).y;
      const dot = _tmpV.dot(fwd);
      bearing = Math.atan2(right, dot);
    }
    this.deps.store.set({
      phase: this.winner !== null ? 'gameover' : 'playing',
      speed: player.body.speed,
      damage: player.body.damage,
      vehicleName: player.body.stats.name,
      scores: st.scores,
      carrierName: carrierActor ? (carrierActor.isPlayer ? 'YOU' : carrierActor.label) : null,
      carrierIsPlayer: carrierActor?.isPlayer ?? false,
      carrierIsAlly: carrierActor ? carrierActor.team === player.team : false,
      objective: st.carrier ? 'DELIVER CONTRABAND' : 'FIND CONTRABAND',
      distanceToTarget: player.body.pos.distanceTo(target),
      targetIsDelivery: st.carrier !== null,
      targetBearingRad: bearing,
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
