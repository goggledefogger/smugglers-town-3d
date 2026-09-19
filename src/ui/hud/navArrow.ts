/**
 * Orientation math for the 3D navigation chevron, kept out of the Lit
 * component so it runs in node under test.
 *
 * The model is the arrow painted on the road in an arcade racer: a rigid flat
 * plate lying on a ground plane leaned away from the camera, spinning about
 * that plane's normal and nothing else. One axis is the whole trick — roll is
 * never introduced, so the chevron can never read upside down, and the lean's
 * perspective does the front/back work by itself: pointing away foreshortens
 * and shrinks it, pointing back at you swings the apex toward the camera and
 * it looms.
 *
 * Deliberately ignores the target's elevation. Tipping the plate out of its
 * plane is not symmetric — nose-up flattens it face-on while nose-down drives
 * it edge-on into an unreadable sliver — and the crate and both bases sit on
 * the ground, so the cue cost more legibility than it bought.
 */

export type Axis = 'x' | 'z';

/** Lean of the ground plane away from the camera. Outermost, never animated. */
export const GROUND_LEAN = 46;
/** Inside this planar distance the beacon beam takes over: shrink and fade. */
const NEAR_M = 40;

interface NavOrientation {
  /** degrees, fixed: the ground plane the chevron lies on */
  readonly lean: number;
  /** degrees clockwise on screen; +90 means the target is to your right */
  readonly yaw: number;
  readonly scale: number;
  readonly opacity: number;
}

const DEG = 180 / Math.PI;

/**
 * yaw: radians clockwise from straight ahead. distance: planar world distance
 * to the target.
 */
export function navOrientation(yaw: number, distance: number): NavOrientation {
  const closeness = 1 - Math.min(1, Math.max(0, distance) / NEAR_M);
  return {
    lean: GROUND_LEAN,
    yaw: yaw * DEG,
    scale: 1 - closeness * 0.35,
    opacity: 1 - closeness * 0.6
  };
}

/**
 * The rotations outermost first. Order is the whole point: lean the plane,
 * then spin inside it. The other order multiplies the lean into the spun
 * frame, where it becomes roll at yaw ±90° and the chevron tumbles.
 */
export function navOps(o: NavOrientation): readonly (readonly [Axis, number])[] {
  return [['x', o.lean], ['z', o.yaw]];
}

export function navTransform(o: NavOrientation): string {
  const rot = navOps(o).map(([axis, deg]) => `rotate${axis.toUpperCase()}(${deg.toFixed(2)}deg)`).join(' ');
  return `${rot} scale(${o.scale.toFixed(3)})`;
}
