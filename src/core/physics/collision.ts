/**
 * Collision shapes and the primitive tests between them.
 *
 * Physics shapes are separate from render meshes and deliberately simple —
 * that is the standard practice, because simple shapes are cheap, stable,
 * and never wedge. A vehicle's collider is a *compound of spheres* in body
 * space: one sphere is the arcade default; two along the length give a car a
 * nose and a tail (it reads as longer than it is wide) with none of the cost
 * or edge cases of oriented boxes. Radii come from the roster, so a Monster
 * Truck really is bigger than a Buggy.
 *
 * Extension path, in order of likely need:
 * - More spheres per vehicle (each wheel, a bumper): same code path.
 * - Other shapes (capsule, oriented box): add a `kind` to the world shape
 *   and a matching `*VsAabb` / `*VsSphere` test below.
 * - Per-layer rules: `CollisionLayer` tags every world collider; the
 *   resolver can branch on it (props softer than buildings, triggers that
 *   report but don't push) without touching the shape code.
 */
import { Vector3, type Quaternion } from 'three';

/** What a world collider is, so the resolver can treat kinds differently later. */
export type CollisionLayer = 'building' | 'prop';

/** A sphere in body space: +X right, +Y up, -Z forward. */
export interface LocalSphere {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
}

export interface VehicleCollider {
  readonly spheres: readonly LocalSphere[];
  /** Farthest any sphere surface reaches from the body origin (broadphase bound). */
  readonly bound: number;
}

/** One sphere at the body origin. */
export function sphereCollider(r: number): VehicleCollider {
  return { spheres: [{ x: 0, y: 0, z: 0, r }], bound: r };
}

/**
 * Two spheres along the length — a sphere-swept line, the usual arcade
 * stand-in for a capsule. `halfLength` is the distance from the origin to
 * each sphere centre.
 */
export function capsuleCollider(r: number, halfLength: number): VehicleCollider {
  return {
    spheres: [{ x: 0, y: 0, z: -halfLength, r }, { x: 0, y: 0, z: halfLength, r }],
    bound: halfLength + r
  };
}

/** Result of a contact test: unit normal pointing out of the obstacle, and how far to move. */
export interface Contact {
  nx: number;
  ny: number;
  nz: number;
  push: number;
}

/**
 * Sphere against an axis-aligned box. Outside the box the normal points
 * from the nearest face point to the sphere centre. Inside it, the way out
 * is the NEAREST face — the smallest penetration — which matters: leaving by
 * the deepest face drives a body further through the obstacle.
 */
export function sphereVsAabb(
  cx: number, cy: number, cz: number, r: number,
  min: Vector3, max: Vector3, out: Contact
): boolean {
  const px = Math.min(Math.max(cx, min.x), max.x);
  const py = Math.min(Math.max(cy, min.y), max.y);
  const pz = Math.min(Math.max(cz, min.z), max.z);
  const dx = cx - px, dy = cy - py, dz = cz - pz;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= r * r) return false;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    out.nx = dx / d;
    out.ny = dy / d;
    out.nz = dz / d;
    out.push = r - d;
    return true;
  }
  // centre inside: exit through the nearest face
  const ex = Math.min(cx - min.x, max.x - cx);
  const ey = Math.min(cy - min.y, max.y - cy);
  const ez = Math.min(cz - min.z, max.z - cz);
  out.nx = 0;
  out.ny = 0;
  out.nz = 0;
  if (ex <= ey && ex <= ez) {
    out.nx = cx < (min.x + max.x) / 2 ? -1 : 1;
    out.push = ex + r;
  } else if (ey <= ez) {
    out.ny = cy < (min.y + max.y) / 2 ? -1 : 1;
    out.push = ey + r;
  } else {
    out.nz = cz < (min.z + max.z) / 2 ? -1 : 1;
    out.push = ez + r;
  }
  return true;
}

const _a = new Vector3();
const _b = new Vector3();

/**
 * Deepest overlap between two compound colliders placed in the world.
 * Returns the push distance (0 when apart) and writes the contact normal
 * from A toward B into `out`.
 */
export function compoundVsCompound(
  posA: Vector3, quatA: Quaternion, colA: VehicleCollider,
  posB: Vector3, quatB: Quaternion, colB: VehicleCollider,
  out: Vector3
): number {
  // broadphase: bounding spheres
  const reach = colA.bound + colB.bound;
  if (posA.distanceToSquared(posB) >= reach * reach) return 0;
  let deepest = 0;
  for (const sa of colA.spheres) {
    _a.set(sa.x, sa.y, sa.z).applyQuaternion(quatA).add(posA);
    for (const sb of colB.spheres) {
      _b.set(sb.x, sb.y, sb.z).applyQuaternion(quatB).add(posB);
      const d = _a.distanceTo(_b);
      const overlap = sa.r + sb.r - d;
      if (overlap > deepest) {
        deepest = overlap;
        if (d > 1e-6) out.copy(_b).sub(_a).divideScalar(d);
        else out.set(1, 0, 0);
      }
    }
  }
  return deepest;
}

/**
 * Where a segment from `a` to `b` first enters a box grown by `pad` on every
 * side: the fraction along the segment in [0, 1], or Infinity when it never
 * does. Slab test; a segment starting inside the box hits at 0.
 */
export function segmentVsAabb(a: Vector3, b: Vector3, min: Vector3, max: Vector3, pad = 0): number {
  let t0 = 0, t1 = 1;
  const axes = ['x', 'y', 'z'] as const;
  for (const k of axes) {
    const lo = min[k] - pad, hi = max[k] + pad;
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) {
      if (a[k] < lo || a[k] > hi) return Infinity;
      continue;
    }
    let tn = (lo - a[k]) / d, tf = (hi - a[k]) / d;
    if (tn > tf) [tn, tf] = [tf, tn];
    if (tn > t0) t0 = tn;
    if (tf < t1) t1 = tf;
    if (t0 > t1) return Infinity;
  }
  return t0;
}
