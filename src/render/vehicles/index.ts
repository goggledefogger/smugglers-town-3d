import { Group, MathUtils } from 'three';
import type { VehicleStats } from '../../core/physics/vehicleStats.ts';
import type { VehicleMesh, VehicleModelBuilder } from './types.ts';
import { VehicleMeshBuilder } from './VehicleMeshBuilder.ts';
import { createVehiclePalette } from './VehiclePalette.ts';
import { buildDuneBuggy } from './models/DuneBuggy.ts';
import { buildRallyCar } from './models/RallyCar.ts';
import { buildSuv } from './models/Suv.ts';
import { buildTrophyTruck } from './models/TrophyTruck.ts';
import { buildMonsterTruck } from './models/MonsterTruck.ts';

export * from './types.ts';
export * from './VehicleMeshBuilder.ts';
export * from './VehiclePalette.ts';
export * from './textures/graffiti.ts';
export * from './textures/liveryTextures.ts';
export * from './textures/wheelTextures.ts';
export { buildDuneBuggy } from './models/DuneBuggy.ts';
export { buildRallyCar } from './models/RallyCar.ts';
export { buildSuv } from './models/Suv.ts';
export { buildTrophyTruck } from './models/TrophyTruck.ts';
export { buildMonsterTruck } from './models/MonsterTruck.ts';

export const VEHICLE_BUILDERS: Record<string, VehicleModelBuilder> = {
  'Dune Buggy': buildDuneBuggy,
  'Rally Car': buildRallyCar,
  'SUV': buildSuv,
  'Trophy Truck': buildTrophyTruck,
  'Monster Truck': buildMonsterTruck
};

/**
 * Procedural vehicle assembler: builds the vehicle root group, body silhouette,
 * 4-wheel steering/axle suspension pivots, and taillight braking material.
 */
export function buildVehicle(stats: VehicleStats, teamColor: number): VehicleMesh {
  const p = createVehiclePalette(stats, teamColor);
  const root = new Group();
  const b = new VehicleMeshBuilder(root);
  const wheelR = MathUtils.clamp(0.45 + 0.28 * (stats.mass - 0.9), 0.4, 0.8);
  const builder = VEHICLE_BUILDERS[stats.name] ?? buildSuv;
  const layout = builder(b, p, wheelR);

  const wheels: { spin: Group; r: number }[] = [];
  const frontPivots: Group[] = [];

  for (const [x, z] of [[0.95, 1.3], [-0.95, 1.3], [0.95, -1.3], [-0.95, -1.3]] as const) {
    const r = z > 0 ? layout.rearR : wheelR;
    const pivot = new Group();
    pivot.position.set(x, r, z);
    const spin = b.wheel(r, layout.wheelW, p);
    pivot.add(spin);
    root.add(pivot);
    wheels.push({ spin, r });
    if (z < 0) frontPivots.push(pivot); // Forward is -Z
  }

  return { root, wheels, frontPivots, wheelR, tail: p.tail };
}
