import type { VehicleMeshBuilder } from '../VehicleMeshBuilder.ts';
import type { VehiclePalette, VehicleLayout } from '../types.ts';

/**
 * Trophy Truck silhouette: desert pre-runner with flared fenders, high-mount
 * roof light bar, and Desert Wasteland Military Stencil "T O W N" on the tailgate.
 */
export function buildTrophyTruck(b: VehicleMeshBuilder, p: VehiclePalette, r: number): VehicleLayout {
  const lift = 0.22;
  const y = r + 0.5 + lift;

  // Chassis
  b.box(2.1, 0.5, 4.2, p.body, 0, y, 0);

  // Cab and glass
  b.box(2.0, 0.7, 1.75, p.paint, 0, y + 0.6, -0.55);
  b.box(2.03, 0.34, 1.35, p.glass, 0, y + 0.7, -0.55);
  b.box(1.85, 0.08, 0.7, p.glass, 0, y + 0.72, -1.45, -0.62);

  // Truck bed walls
  for (const x of [-1.0, 1.0]) {
    b.box(0.08, 0.36, 1.8, p.paint, x, y + 0.43, 1.2);
  }

  // Tailgate with Desert Stencil "T O W N" graffiti on the rear face
  const tailgateMats = [p.paint, p.paint, p.paint, p.paint, p.tailgate, p.paint];
  b.box(2.0, 0.36, 0.08, tailgateMats, 0, y + 0.43, 2.06);

  // Hood accent stripe
  b.box(0.5, 0.02, 1.2, p.accent, 0, y + 0.26, -1.55);

  // Flared pre-runner fenders
  for (const x of [-1.15, 1.15]) {
    for (const z of [-1.3, 1.3]) {
      b.box(0.45, 0.22, 1.35, p.dark, x, r * 1.75 + lift, z);
    }
  }

  // Roof LED light bar
  b.box(1.8, 0.12, 0.14, p.dark, 0, y + 1.02, -0.6);
  for (const x of [-0.6, -0.2, 0.2, 0.6]) {
    b.box(0.24, 0.14, 0.12, p.head, x, y + 1.02, -0.68);
  }

  b.bumpers(p, y - 0.28, 2.15, 2.12);
  b.lights(p, y + 0.05, -2.12, 2.12, 0.4);

  return { rearR: r, wheelW: 0.55 };
}
