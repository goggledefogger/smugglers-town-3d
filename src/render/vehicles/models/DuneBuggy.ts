import type { VehicleMeshBuilder } from '../VehicleMeshBuilder.ts';
import type { VehiclePalette, VehicleLayout } from '../types.ts';

/**
 * Dune Buggy silhouette: open-cockpit sand rail with roll cage, exposed rear engine,
 * dipped nose with Skate-Punk "TOWN" drip tag, and oversized rear paddle wheels.
 */
export function buildDuneBuggy(b: VehicleMeshBuilder, p: VehiclePalette, r: number): VehicleLayout {
  const y = r + 0.35;

  // Main tub: uses p.body (sides have side livery, rear has rear tag)
  b.box(1.7, 0.45, 2.8, p.body, 0, y, 0.2);

  // Dipped nose: top and front faces feature the Punk "TOWN" drip tag
  const noseMats = [p.paint, p.paint, p.hood, p.paint, p.paint, p.hood];
  b.box(1.4, 0.3, 1.0, noseMats, 0, y - 0.05, -1.7, -0.18);

  // Bucket seats
  for (const x of [-0.42, 0.42]) {
    b.box(0.55, 0.45, 0.6, p.dark, x, y + 0.4, 0.2);
    b.box(0.55, 0.55, 0.1, p.dark, x, y + 0.7, 0.5);
  }

  // Exposed rear engine + chrome air filter
  b.box(0.9, 0.36, 0.55, p.dark, 0, y + 0.3, 1.4);
  b.cyl(0.18, 0.28, p.chrome, 0, y + 0.62, 1.4, 'y');

  // Tubular roll cage
  for (const z of [-0.45, 0.85]) {
    for (const x of [-0.8, 0.8]) b.cyl(0.05, 1.15, p.accent, x, y + 0.75, z, 'y', 6);
    b.cyl(0.05, 1.7, p.accent, 0, y + 1.3, z, 'x', 6);
  }
  for (const x of [-0.8, 0.8]) b.cyl(0.05, 1.4, p.accent, x, y + 1.3, 0.2, 'z', 6);

  // Headlights and taillights
  for (const x of [-0.45, 0.45]) b.cyl(0.14, 0.08, p.head, x, y + 0.15, -2.15, 'z', 10);
  for (const x of [-0.6, 0.6]) b.box(0.3, 0.12, 0.06, p.tail, x, y + 0.1, 1.85);

  return { rearR: r * 1.22, wheelW: 0.45 };
}
