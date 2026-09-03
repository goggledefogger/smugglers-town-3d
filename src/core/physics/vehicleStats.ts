import { capsuleCollider, type VehicleCollider } from './collision.ts';

/**
 * Tuning table for a vehicle archetype. The number stats are multipliers on
 * the physics constants in app/config; the collider is the body's physical
 * shape (see collision.ts) and is what every contact test uses.
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
  readonly collider: VehicleCollider;
}

// colliders: radius ≈ half the body width, half-length puts the two spheres
// about at the axles, so the envelope hugs the mesh without poking past it
export const VEHICLE_TYPES: readonly VehicleStats[] = [
  { name: 'Dune Buggy',   color: 0xffcc33, mass: 1.0, accel: 1.4, maxSpeed: 1.15, durability: 0.55, steer: 1.25, grip: 0.82, collider: capsuleCollider(1.7, 0.9) },
  { name: 'Rally Car',    color: 0xff4444, mass: 0.9, accel: 1.5, maxSpeed: 1.3,  durability: 0.45, steer: 1.1,  grip: 0.7,  collider: capsuleCollider(1.8, 1.1) },
  { name: 'SUV',          color: 0x3399ff, mass: 1.4, accel: 1.0, maxSpeed: 1.0,  durability: 1.0,  steer: 1.0,  grip: 1.0,  collider: capsuleCollider(1.9, 1.0) },
  { name: 'Trophy Truck', color: 0x33cc66, mass: 1.3, accel: 1.1, maxSpeed: 1.05, durability: 0.9,  steer: 1.05, grip: 0.95, collider: capsuleCollider(2.0, 1.1) },
  { name: 'Monster Truck',color: 0xaa55ff, mass: 2.0, accel: 0.75, maxSpeed: 0.85, durability: 1.5,  steer: 0.85, grip: 1.2,  collider: capsuleCollider(2.4, 0.9) }
];

/** Aggregate physical input for one vehicle over a step. */
export interface VehicleInput {
  throttle: number;   // [0, 1]
  brake: number;      // [0, 1]
  steer: number;      // [-1, 1], +1 turns left
  jump: boolean;
  /** [-1, 1] air-control pitch, applied only while airborne. +1 is nose up. */
  pitch?: number;
}
