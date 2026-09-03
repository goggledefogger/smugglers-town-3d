/**
 * Pure radar maths for the minimap, kept out of the Lit component so it runs
 * in node under test — the same split as navArrow.ts, and for the same reason:
 * rotations and sign conventions are where the bugs live.
 */

/** Light direction for the relief, from the north-west and above. */
const LIGHT = { x: -0.55, y: 0.62, z: -0.55 };

/**
 * Lambert shading for a terrain sample, from the height gradient.
 *
 * Smuggler's Run's whole navigation trick is that the objective arrow ignores
 * terrain, so the map has to show it: a ridge you cannot see is a ridge you
 * drive into at 200 km/h. Returns 0 (facing away from the light) to 1.
 */
export function hillshade(dhdx: number, dhdz: number): number {
  // surface normal of a heightfield is (-dh/dx, 1, -dh/dz), unnormalised
  const nx = -dhdx;
  const nz = -dhdz;
  const len = Math.hypot(nx, 1, nz);
  const dot = (nx * LIGHT.x + LIGHT.y + nz * LIGHT.z) / len;
  return Math.max(0, Math.min(1, dot));
}

export interface RadarPoint {
  readonly x: number;
  readonly y: number;
  /** The target is beyond the radar's range and is pinned to the rim. */
  readonly clamped: boolean;
}

/**
 * A world offset from the player, as canvas pixels from the radar's centre.
 *
 * Heading-up: the player's forward always points up the canvas, so "turn
 * towards the gap in the ridge" is the same direction on the map as on the
 * screen. Canvas y grows downward and world forward is -Z, so world +z maps to
 * canvas +y before rotation.
 *
 * yaw: player heading, radians clockwise from world north (-Z).
 * range: world units from centre to rim. radius: canvas pixels for that range.
 */
export function radarProject(
  dx: number, dz: number, yaw: number, range: number, radius: number
): RadarPoint {
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  const rx = dx * c - dz * s;
  const ry = dx * s + dz * c;
  const scale = radius / range;
  let x = rx * scale;
  let y = ry * scale;
  const dist = Math.hypot(x, y);
  if (dist <= radius) return { x, y, clamped: false };
  // pinned to the rim: an objective off the radar still has to say which way
  const k = radius / (dist || 1);
  x *= k;
  y *= k;
  return { x, y, clamped: true };
}

/** Player heading in radians clockwise from world north (-Z). */
export function headingOf(forwardX: number, forwardZ: number): number {
  return Math.atan2(forwardX, -forwardZ);
}
