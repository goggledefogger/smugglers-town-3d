/**
 * Level of detail: the geometricError accepted grows with distance from a center.
 * Lives here rather than beside the streamer so a profile can be typed without
 * importing Tileset, which imports this back.
 */
export interface LodPolicy {
  /** Finest error accepted (m), used near the center. */
  readonly minErrorM: number;
  /** Coarsest error accepted (m), used toward the load radius. */
  readonly maxErrorM: number;
  /** Error allowed per meter of distance, between the two clamps. */
  readonly errorPerMeter: number;
}
