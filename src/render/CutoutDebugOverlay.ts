/**
 * Cutout 3D collision debug (?cutoutDebug=1, window.__cutoutDebug(on)):
 * every wall the car can hit, drawn as a low fence of lines from 0.3 m to
 * 1.8 m above the ground, coloured by where it came from. Built only while
 * debug is on; off, nothing exists and nothing is computed.
 */
import { BufferAttribute, BufferGeometry, Group, LineBasicMaterial, LineSegments } from 'three';
import type { BuildingCollider } from '../core/physics/VehicleBody.ts';
import { SEG_STRIDE, SEG_SRC_GAP } from '../services/overture/stencilTrace.ts';

/** Overture-derived stencil walls, classifier-gap walls, fallback classifier boxes. */
export const DEBUG_COLOURS = { overture: [0, 0.9, 1], gap: [1, 0, 0.85], box: [1, 0.85, 0] } as const;
const FENCE_LOW_M = 0.3;
const FENCE_HIGH_M = 1.8;

export interface DebugLines {
  positions: Float32Array;
  colors: Float32Array;
}

/**
 * Line vertices for the fence: per wall a bottom and a top rail plus two
 * posts (8 vertices). Traced segments are coloured by their source byte;
 * boxes (the pre-stencil fallback) draw their four sides.
 */
export function debugLines(
  segs: Float32Array | null, boxes: readonly BuildingCollider[] | null, groundAt: (x: number, z: number) => number
): DebugLines {
  const walls: [number, number, number, number, readonly number[]][] = [];
  if (segs) {
    for (let o = 0; o + SEG_STRIDE <= segs.length; o += SEG_STRIDE) {
      walls.push([segs[o]!, segs[o + 1]!, segs[o + 2]!, segs[o + 3]!, segs[o + 5] === SEG_SRC_GAP ? DEBUG_COLOURS.gap : DEBUG_COLOURS.overture]);
    }
  }
  if (boxes) {
    for (const b of boxes) {
      if (b.kind === 'prop') continue;
      const { x: x0, z: z0 } = b.min, { x: x1, z: z1 } = b.max;
      walls.push([x0, z0, x1, z0, DEBUG_COLOURS.box], [x1, z0, x1, z1, DEBUG_COLOURS.box],
        [x1, z1, x0, z1, DEBUG_COLOURS.box], [x0, z1, x0, z0, DEBUG_COLOURS.box]);
    }
  }
  const positions = new Float32Array(walls.length * 8 * 3);
  const colors = new Float32Array(walls.length * 8 * 3);
  let v = 0;
  const put = (x: number, y: number, z: number, c: readonly number[]): void => {
    positions[v * 3] = x; positions[v * 3 + 1] = y; positions[v * 3 + 2] = z;
    colors[v * 3] = c[0]!; colors[v * 3 + 1] = c[1]!; colors[v * 3 + 2] = c[2]!;
    v++;
  };
  for (const [ax, az, bx, bz, c] of walls) {
    const ga = groundAt(ax, az), gb = groundAt(bx, bz);
    put(ax, ga + FENCE_LOW_M, az, c); put(bx, gb + FENCE_LOW_M, bz, c);
    put(ax, ga + FENCE_HIGH_M, az, c); put(bx, gb + FENCE_HIGH_M, bz, c);
    put(ax, ga + FENCE_LOW_M, az, c); put(ax, ga + FENCE_HIGH_M, az, c);
    put(bx, gb + FENCE_LOW_M, bz, c); put(bx, gb + FENCE_HIGH_M, bz, c);
  }
  return { positions, colors };
}

export class CutoutDebugOverlay {
  readonly group = new Group();
  private lines: LineSegments | null = null;
  private readonly material = new LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true });

  set(segs: Float32Array | null, boxes: readonly BuildingCollider[] | null, groundAt: (x: number, z: number) => number): void {
    this.clear();
    const { positions, colors } = debugLines(segs, boxes, groundAt);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('color', new BufferAttribute(colors, 3));
    this.lines = new LineSegments(geo, this.material);
    this.lines.renderOrder = 999;
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
  }

  clear(): void {
    if (!this.lines) return;
    this.group.remove(this.lines);
    this.lines.geometry.dispose();
    this.lines = null;
  }
}
