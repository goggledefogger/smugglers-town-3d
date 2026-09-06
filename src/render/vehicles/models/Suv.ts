import type { VehicleMeshBuilder } from '../VehicleMeshBuilder.ts';
import type { VehiclePalette, VehicleLayout } from '../types.ts';

/**
 * SUV silhouette: heavy 4x4 with roof rack rails, upright stance,
 * and massive rear tailgate featuring classic Subway Bubble Throwie "TOWN" graffiti.
 */
export function buildSuv(b: VehicleMeshBuilder, p: VehiclePalette, r: number): VehicleLayout {
  const y = r + 0.45;

  // Main body box: face 4 (+Z) carries the NYC Subway Bubble Throwie "TOWN"
  b.box(2.2, 0.8, 4.0, p.body, 0, y, 0);

  // Cabin and windows
  b.box(2.0, 0.75, 2.5, p.paint, 0, y + 0.75, 0.1);
  b.box(2.03, 0.4, 2.25, p.glass, 0, y + 0.85, 0.1);
  b.box(1.9, 0.08, 0.75, p.glass, 0, y + 0.85, -1.2, -0.62); // Windshield

  // Roof rack rails
  for (const x of [-0.8, 0.8]) {
    b.box(0.08, 0.08, 2.3, p.dark, x, y + 1.17, 0.1);
  }
  for (const z of [-0.8, 0.1, 1.0]) {
    b.box(1.7, 0.06, 0.06, p.dark, 0, y + 1.17, z);
  }

  // Side accent moldings
  for (const x of [-1.11, 1.11]) {
    b.box(0.03, 0.12, 3.6, p.accent, x, y - 0.1, 0);
  }

  b.bumpers(p, y - 0.28, 2.25, 2.05);
  b.lights(p, y + 0.12, -2.03, 2.03, 0.42);

  return { rearR: r, wheelW: 0.5 };
}
