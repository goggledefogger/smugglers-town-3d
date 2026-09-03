/**
 * Where there is room to put something.
 *
 * The one question spawning, base placement and item drops all ask, behind a
 * two-method interface so callers never touch a grid. `NavGrid` implements it
 * over the same occupancy the AI routes on; tests use `EMPTY_SPACE`.
 */
export interface Vec2 {
  readonly x: number;
  readonly z: number;
}

export interface OpenSpace {
  /** Radius of open ground around a point, in world units; 0 if blocked. */
  clearanceAt(x: number, z: number): number;
  /**
   * Nearest point with at least `need` clearance, searching outward from
   * (x, z). Null when nowhere in the world qualifies.
   */
  findOpen(x: number, z: number, need: number): Vec2 | null;
  /**
   * The point with the most room, preferring ones near (x, z). Falls back to
   * the roomiest place available when nothing meets `need`, so a caller
   * always gets the best on offer rather than nothing.
   */
  mostOpen(x: number, z: number, need: number): Vec2 | null;
}

/** An unobstructed world — the default for tests and the procedural desert. */
export const EMPTY_SPACE: OpenSpace = {
  clearanceAt: () => Infinity,
  findOpen: (x, z) => ({ x, z }),
  mostOpen: (x, z) => ({ x, z })
};
