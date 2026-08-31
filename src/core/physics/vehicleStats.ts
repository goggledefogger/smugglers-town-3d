/**
 * Tuning table for a vehicle archetype. All stats are multipliers on the
 * physics constants in app/config.
 */
export interface VehicleStats {
  readonly name: string;
  readonly color: number;
  readonly mass: number;
  readonly accel: number;
  readonly maxSpeed: number;
  readonly durability: number;
  readonly steer: number;
  readonly grip: number;
}

export const VEHICLE_TYPES: readonly VehicleStats[] = [
  { name: 'Dune Buggy',   color: 0xffcc33, mass: 1.0, accel: 1.4, maxSpeed: 1.15, durability: 0.55, steer: 1.25, grip: 0.82 },
  { name: 'Rally Car',    color: 0xff4444, mass: 0.9, accel: 1.5, maxSpeed: 1.3,  durability: 0.45, steer: 1.1,  grip: 0.7 },
  { name: 'SUV',          color: 0x3399ff, mass: 1.4, accel: 1.0, maxSpeed: 1.0,  durability: 1.0,  steer: 1.0,  grip: 1.0 },
  { name: 'Trophy Truck', color: 0x33cc66, mass: 1.3, accel: 1.1, maxSpeed: 1.05, durability: 0.9,  steer: 1.05, grip: 0.95 },
  { name: 'Monster Truck',color: 0xaa55ff, mass: 2.0, accel: 0.75, maxSpeed: 0.85, durability: 1.5,  steer: 0.85, grip: 1.2 }
];

/** Aggregate physical input for one vehicle over a step. */
export interface VehicleInput {
  throttle: number;   // [0, 1]
  brake: number;      // [0, 1]
  steer: number;      // [-1, 1], +1 turns left
  jump: boolean;
  pitch?: number;     // [-1, 1] air-control pitch
}
