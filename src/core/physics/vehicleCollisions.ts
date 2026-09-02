/**
 * Vehicle-vs-vehicle collisions: positional separation, impulse exchange, and
 * the ram-to-steal rule that transfers contraband to an attacker on contact.
 */
import { Vector3 } from 'three';
import type { VehicleBody } from './VehicleBody.ts';

export interface RamConfig {
  /** Contact distance at which vehicles touch (scaled by carScale). */
  readonly ramRadius: number;
  /** Seconds after a transfer before another can occur. */
  readonly transferCooldownS: number;
}

export const DEFAULT_RAM_CONFIG: RamConfig = {
  ramRadius: 4.2,
  transferCooldownS: 0.6
};

/**
 * Resolve one frame of vehicle-vs-vehicle contact. `onRam` fires for every
 * contacting pair (either order) so gameplay code can apply the
 * ram-to-steal rule with its own cooldown bookkeeping.
 */
export function resolveVehicleCollisions(
  vehicles: readonly VehicleBody[],
  cfg: RamConfig = DEFAULT_RAM_CONFIG,
  carScale = 1,
  onRam: (a: VehicleBody, b: VehicleBody) => void
): void {
  const RAM = cfg.ramRadius * carScale;
  for (let i = 0; i < vehicles.length; i++) {
    for (let j = i + 1; j < vehicles.length; j++) {
      const a = vehicles[i]!;
      const b = vehicles[j]!;
      const d = a.pos.distanceTo(b.pos);
      if (d >= RAM || d < 0.01) continue;
      const n = b.pos.clone().sub(a.pos).divideScalar(d);
      const overlap = RAM - d;
      const ma = a.stats.mass, mb = b.stats.mass, tot = ma + mb;
      a.pos.addScaledVector(n, -overlap * mb / tot);
      b.pos.addScaledVector(n, overlap * ma / tot);
      const va = a.vel.dot(n), vb = b.vel.dot(n);
      const newva = (va * (ma - mb) + 2 * mb * vb) / tot;
      const newvb = (vb * (mb - ma) + 2 * ma * va) / tot;
      a.vel.addScaledVector(n, newva - va);
      b.vel.addScaledVector(n, newvb - vb);
      const rel = Math.abs(va - vb);
      if (rel > 8) {
        const light = ma < mb ? a : b;
        const heavy = ma < mb ? b : a;
        if (light.stats.mass < heavy.stats.mass * 0.8) {
          light.angVel.add(
            new Vector3(
              (Math.random() - 0.5) * 4,
              (Math.random() - 0.5) * 2,
              (Math.random() - 0.5) * 4
            )
          );
          light.damage = Math.min(1, light.damage + rel * 0.01 / light.stats.durability);
        }
      }
      onRam(a, b);
    }
  }
}
