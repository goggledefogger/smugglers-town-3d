/**
 * Cutout 3D's car colliders, built from the traced stencil (stencilTrace.ts)
 * when a new stencil lands and never otherwise: the same digest as the
 * walls already built means the same stencil, so nothing is rebuilt and the
 * physics keeps its list.
 */
import { Vector3 } from 'three';
import type { BuildingCollider } from '../../core/physics/VehicleBody.ts';
import { SEG_STRIDE } from './stencilTrace.ts';
import { ROOF_NO_CAP } from './footprintMask.ts';

/** Top of a wall with no roof cap: taller than anything the car can reach. */
export const WALL_FULL_HEIGHT = 1e4;
/** A wall starts this far below the lowest ground under it, so a hillside never opens a gap under it. */
const WALL_FOOT_M = 2;

/**
 * Traced segments as wall colliders. Each stands from just below the
 * ground under it up to the ground plus its roof cap (the stencil's G, the
 * same cap the shader cuts at, so a drawn one-storey overhang is a wall at
 * car height); no cap is full height. The outward normal is the
 * segment's right hand, where the trace put the empty side.
 */
export function stencilWallColliders(segs: Float32Array, groundAt: (x: number, z: number) => number): BuildingCollider[] {
  const out: BuildingCollider[] = [];
  for (let o = 0; o + SEG_STRIDE <= segs.length; o += SEG_STRIDE) {
    const ax = segs[o]!, az = segs[o + 1]!, bx = segs[o + 2]!, bz = segs[o + 3]!, cap = segs[o + 4]!;
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const ga = groundAt(ax, az), gb = groundAt(bx, bz), gm = groundAt((ax + bx) / 2, (az + bz) / 2);
    const y0 = Math.min(ga, gb, gm) - WALL_FOOT_M;
    const y1 = cap >= ROOF_NO_CAP ? WALL_FULL_HEIGHT : Math.max(ga, gb, gm) + cap;
    out.push({
      min: new Vector3(Math.min(ax, bx), y0, Math.min(az, bz)),
      max: new Vector3(Math.max(ax, bx), y1, Math.max(az, bz)),
      kind: 'building',
      wall: { ax, az, bx, bz, nx: dz / len, nz: -dx / len }
    });
  }
  return out;
}

export class StencilColliders {
  /** the walls of the stencil on screen, null until one lands (or with the structure-mask fallback) */
  walls: BuildingCollider[] | null = null;
  private digest: string | null = null;
  /** wall lists built, for the stats */
  builds = 0;

  /** A stencil landed: rebuild the walls unless it is the one they were built from. True when rebuilt. */
  land(digest: string, segs: Float32Array, groundAt: (x: number, z: number) => number): boolean {
    if (this.walls && digest === this.digest) return false;
    this.walls = stencilWallColliders(segs, groundAt);
    this.digest = digest;
    this.builds++;
    return true;
  }

  clear(): void {
    this.walls = null;
    this.digest = null;
  }
}
