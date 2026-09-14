/**
 * Where everything enters the world: match spawns, respawns, team bases, and
 * the contraband drop.
 *
 * One component, one rule — nothing is placed anywhere it does not fit. Every
 * position is chosen through `OpenSpace`, which measures real open ground
 * rather than sampling a handful of candidate points and hoping. That is what
 * a dense downtown needs: San Francisco has no 40-unit clearing near the map
 * centre, so a planner that only probes a coarse grid falls through to a
 * fallback point inside a building, and the match starts with the camera
 * inside a wall.
 *
 * Human and AI drivers go through the same path — there is no "player spawn"
 * special case — and every choice comes from an injected `Rng`, so a seed and
 * an occupancy grid reproduce the same layout on any machine. Both properties
 * are prerequisites for the server-authoritative multiplayer in
 * docs/MULTIPLAYER.md.
 */
import { EMPTY_SPACE, type OpenSpace, type Vec2 } from '../world/OpenSpace.ts';
import type { Rng } from '../rng.ts';

export interface SpawnPoint extends Vec2 {
  /** Heading in radians about +Y; the car faces the middle of the field. */
  readonly yaw: number;
}

export interface SpawnConfig {
  readonly mapHalf: number;
  /** Radius of the active gameplay arena where bases and contraband spawn. */
  readonly arenaRadius?: number;
  /** Open radius a car needs around it. */
  readonly carClearance: number;
  /** Preferred radius of the starting ring. */
  readonly ringRadius: number;
  /** Open radius a base needs. */
  readonly baseClearance: number;
  /** Distance of each base from the field centre, as a fraction of arenaRadius. */
  readonly baseOffset: number;
  /** Open radius the contraband needs. */
  readonly itemClearance: number;
  /** Contraband keeps at least this far from cars and bases. */
  readonly itemMinDist: number;
  /**
   * Cars enter the world this far above the ground and drop in. It reads as
   * a start rather than an appearance, and it lets physics settle a car onto
   * whatever the terrain really is before anyone gets the wheel.
   */
  readonly dropHeight: number;
  /**
   * Height above ground for the initial match start drop during countdown.
   * High enough that cars fall for a couple seconds and land just as the
   * countdown ends ("GO!").
   */
  readonly initialDropHeight?: number;
}

export const DEFAULT_SPAWN: SpawnConfig = {
  mapHalf: 2800,
  arenaRadius: 550,
  carClearance: 4,
  ringRadius: 78,
  baseClearance: 25,
  baseOffset: 0.80,
  itemClearance: 5,
  itemMinDist: 100,
  dropHeight: 14,
  initialDropHeight: 65
};

/** Heading that points from `at` toward `target`; engine forward is -Z. */
function yawToward(at: Vec2, target: Vec2): number {
  return Math.atan2(at.x - target.x, at.z - target.z);
}

const CENTER: Vec2 = { x: 0, z: 0 };

export class SpawnPlanner {
  constructor(
    private readonly cfg: SpawnConfig,
    private readonly space: OpenSpace = EMPTY_SPACE,
    private readonly rng: Rng = Math.random
  ) {}

  /** How far above the ground a car is released when respawning mid-match. */
  get dropHeight(): number {
    return this.cfg.dropHeight;
  }

  /** How far above the ground cars are released at match start during countdown. */
  get initialDropHeight(): number {
    return this.cfg.initialDropHeight ?? this.cfg.dropHeight;
  }

  /** Best-effort open point: the exact spot if it fits, else the nearest that does. */
  private open(at: Vec2, need: number): Vec2 {
    return this.space.findOpen(at.x, at.z, need)
      ?? this.space.mostOpen(at.x, at.z, need)
      ?? at;
  }

  /**
   * Starting positions for a whole match: one ring, teams on opposite arcs.
   * The ring is centred on the roomiest place in the field, and each slot is
   * nudged to open ground, so a downtown start puts the grid in a plaza or
   * along a wide street instead of inside a block. Given `at`, the ring is
   * centred on the nearest open ground to that point instead: a player who
   * asked for a place expects to start there, not at the roomiest park in
   * the 5 km field.
   */
  matchSpawns(count: number, teamOf: (index: number) => 0 | 1, at?: Vec2): SpawnPoint[] {
    const { ringRadius, carClearance } = this.cfg;
    const center = at ? this.open(at, carClearance) : this.space.mostOpen(0, 0, ringRadius + carClearance) ?? CENTER;
    const spin = this.rng() * Math.PI * 2;
    // slots go round the ring in team order, so each team lines up on its own
    // arc however the caller happens to index its drivers
    const order = Array.from({ length: count }, (_, i) => i)
      .sort((a, b) => teamOf(a) - teamOf(b) || a - b);
    const out: SpawnPoint[] = new Array<SpawnPoint>(count);
    order.forEach((index, slot) => {
      const ang = spin + (slot / count) * Math.PI * 2;
      const at = this.open({
        x: center.x + Math.cos(ang) * ringRadius,
        z: center.z + Math.sin(ang) * ringRadius
      }, carClearance);
      out[index] = { x: at.x, z: at.z, yaw: yawToward(at, center) };
    });
    return out;
  }

  /** Where a wrecked driver re-enters: open ground just inside their own base. */
  respawn(base: Vec2): SpawnPoint {
    const len = Math.hypot(base.x, base.z) || 1;
    const inset = 40;
    const at = this.open(
      { x: base.x - (base.x / len) * inset, z: base.z - (base.z / len) * inset },
      this.cfg.carClearance
    );
    return { x: at.x, z: at.z, yaw: yawToward(at, CENTER) };
  }

  /** The two team bases, on opposite sides of the field with room around them. */
  bases(): readonly [Vec2, Vec2] {
    const { mapHalf, arenaRadius = mapHalf, baseOffset, baseClearance } = this.cfg;
    const ang = this.rng() * Math.PI * 2;
    const r = arenaRadius * baseOffset;
    return [0, 1].map(team => {
      const a = ang + team * Math.PI;
      return this.open({ x: Math.cos(a) * r, z: Math.sin(a) * r }, baseClearance);
    }) as unknown as readonly [Vec2, Vec2];
  }

  /** A contraband drop clear of ground, cars and both bases. */
  item(avoid: readonly Vec2[]): Vec2 {
    const { mapHalf, arenaRadius = mapHalf, itemClearance, itemMinDist } = this.cfg;
    const far = (p: Vec2): boolean =>
      avoid.every(v => Math.hypot(p.x - v.x, p.z - v.z) > itemMinDist);
    const span = arenaRadius * 1.5;
    let fallback: Vec2 | null = null;
    for (let tries = 0; tries < 40; tries++) {
      const guess = {
        x: (this.rng() - 0.5) * span,
        z: (this.rng() - 0.5) * span
      };
      const at = this.space.findOpen(guess.x, guess.z, itemClearance);
      if (!at) continue;
      fallback ??= at;
      if (far(at)) return at;
    }
    return fallback ?? this.open(CENTER, itemClearance);
  }
}
