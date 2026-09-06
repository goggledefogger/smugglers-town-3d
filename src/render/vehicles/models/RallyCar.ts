import type { VehicleMeshBuilder } from '../VehicleMeshBuilder.ts';
import type { VehiclePalette, VehicleLayout } from '../types.ts';

/**
 * Rally Car silhouette: low-slung, aerodynamic touring body with raked glass,
 * high-downforce rear wing, and Chisel-Tip Drift "TOWN" graffiti across the rear hatch.
 */
export function buildRallyCar(b: VehicleMeshBuilder, p: VehiclePalette, r: number): VehicleLayout {
  const y = r + 0.32;

  // Main body: p.body face 4 (+Z) renders the Drift Tag "TOWN" across the rear trunk/hatch
  b.box(2.1, 0.5, 4.2, p.body, 0, y, 0);

  // Cabin and glasshouse
  b.box(1.85, 0.5, 1.9, p.paint, 0, y + 0.45, 0.35);
  b.box(1.8, 0.08, 1.0, p.glass, 0, y + 0.5, -0.78, -0.62); // Raked windshield
  b.box(1.7, 0.08, 0.75, p.glass, 0, y + 0.5, 1.42, 0.7);   // Rear window
  b.box(1.86, 0.28, 1.5, p.glass, 0, y + 0.52, 0.35);       // Side windows

  // Aerodynamic side sill skirts
  for (const x of [-1.06, 1.06]) {
    b.box(0.03, 0.16, 3.7, p.accent, x, y + 0.08, 0);
  }

  // High-downforce rear spoiler
  b.box(2.0, 0.06, 0.42, p.accent, 0, y + 0.85, 1.95);
  for (const x of [-0.7, 0.7]) {
    b.box(0.08, 0.4, 0.08, p.dark, x, y + 0.62, 1.95);
  }

  b.bumpers(p, y - 0.15, 2.15, 2.12);
  b.lights(p, y + 0.15, -2.12, 2.12);

  return { rearR: r, wheelW: 0.45 };
}
