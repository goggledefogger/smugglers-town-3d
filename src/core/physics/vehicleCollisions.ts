/**
 * Vehicle-vs-vehicle collisions: positional separation, impulse exchange, and
 * the ram-to-steal hook that lets gameplay transfer contraband on contact.
 *
 * Contact comes from each vehicle's own collider (collision.ts), so a
 * Monster Truck touches sooner than a Buggy and a nose hits before a flank.
 */
import { Vector3 } from 'three';
import type { VehicleBody } from './VehicleBody.ts';
import { compoundVsCompound } from './collision.ts';
import type { Rng } from '../rng.ts';

const _n = new Vector3();

/**
 * Resolve one frame of vehicle-vs-vehicle contact. `onRam` fires for every
 * contacting pair (either order) so gameplay code can apply the
 * ram-to-steal rule with its own cooldown bookkeeping.
 */
export function resolveVehicleCollisions(
  vehicles: readonly VehicleBody[],
  onRam: (a: VehicleBody, b: VehicleBody) => void,
  rng: Rng = Math.random
): void {
  for (let i = 0; i < vehicles.length; i++) {
    for (let j = i + 1; j < vehicles.length; j++) {
      const a = vehicles[i]!;
      const b = vehicles[j]!;
      const overlap = compoundVsCompound(
        a.pos, a.quat, a.stats.collider,
        b.pos, b.quat, b.stats.collider,
        _n
      );
      if (overlap <= 0) continue;
      const n = _n;
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
          light.angVel.x += (rng() - 0.5) * 4;
          light.angVel.y += (rng() - 0.5) * 2;
          light.angVel.z += (rng() - 0.5) * 4;
          light.damage = Math.min(1, light.damage + rel * 0.01 / light.stats.durability);
        }
      }
      onRam(a, b);
    }
  }
}
