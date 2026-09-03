/**
 * What rendering and the HUD need from a match, whether it is simulated here
 * (`Game`) or mirrored from a host over the network (`ClientSession`).
 */
import type { Vector3 } from 'three';
import type { MatchState } from '../core/gameplay/MatchRules.ts';
import type { TerrainProvider } from '../core/terrain/TerrainProvider.ts';
import type { MatchPhase, VehicleActor } from './Game.ts';

export interface WorldView {
  readonly vehicles: readonly VehicleActor[];
  readonly player: VehicleActor | undefined;
  readonly state: MatchState;
  /** Fraction of a sim step since the last one; views interpolate poses by it. */
  readonly alpha: number;
  readonly matchPhase: MatchPhase;
  readonly terrainProvider: TerrainProvider;
  /** Radians clockwise from straight ahead to the player's current target. */
  targetBearing(): number;
  /** Clear fraction of a segment through the world's buildings; a world without them returns 1. */
  lineOfSight(from: Vector3, to: Vector3): number;
}
