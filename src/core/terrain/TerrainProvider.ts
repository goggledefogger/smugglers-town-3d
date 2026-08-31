/**
 * Terrain providers produce the heightfield a match plays on. The procedural
 * desert plays instantly with no network; the real provider is built from a
 * Google Elevation grid draped with satellite imagery.
 */
import type { Heightfield } from '../heightfield.ts';

export interface TerrainProvider {
  /** Human-readable location label shown in the HUD. */
  readonly label: string;
  /** True when this terrain came from real-world data. */
  readonly isReal: boolean;
  /** The heightfield driving physics and the terrain mesh. */
  readonly heightfield: Heightfield;
  /** Optional satellite texture draped over the mesh (real terrain only). */
  readonly satelliteCanvas: HTMLCanvasElement | null;
  /** Relief exaggeration applied to real elevations (1 = true scale). */
  readonly reliefBoost: number;
}
