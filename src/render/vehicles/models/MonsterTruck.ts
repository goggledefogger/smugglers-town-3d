import type { VehicleMeshBuilder } from '../VehicleMeshBuilder.ts';
import type { VehiclePalette, VehicleLayout } from '../types.ts';

/**
 * Monster Truck silhouette: massive 0.85m suspension lift, exposed solid axles,
 * chrome coilover shocks, dual vertical exhaust stacks, giant wide tires, and
 * Heavy-Metal Chrome Wildstyle "TOWN" graffiti across the top cab roof.
 */
export function buildMonsterTruck(b: VehicleMeshBuilder, p: VehiclePalette, r: number): VehicleLayout {
  const lift = 0.85;
  const y = r + 0.5 + lift;

  // Heavy solid tubular axles
  for (const z of [-1.3, 1.3]) {
    b.cyl(0.12, 2.3, p.dark, 0, r, z, 'x');
  }

  // Central chassis ladder frame / spine
  b.box(0.5, 0.3, 3.2, p.dark, 0, r + 0.35, 0);

  // Chrome high-travel coilover shock absorbers
  for (const x of [-0.75, 0.75]) {
    for (const z of [-1.3, 1.3]) {
      b.box(0.12, lift + 0.3, 0.12, p.chrome, x, r + lift / 2 + 0.3, z);
    }
  }

  // Main lifted body / chassis
  b.box(2.1, 0.5, 4.2, p.body, 0, y, 0);

  // Cab: top roof face features the Heavy-Metal Chrome Wildstyle "TOWN" graffiti
  const cabMats = [p.paint, p.paint, p.roof, p.paint, p.paint, p.paint];
  b.box(2.0, 0.7, 1.75, cabMats, 0, y + 0.6, -0.55);

  b.box(2.03, 0.34, 1.35, p.glass, 0, y + 0.7, -0.55); // Side glass
  b.box(1.85, 0.08, 0.7, p.glass, 0, y + 0.72, -1.45, -0.62); // Windshield

  // Bed walls
  for (const x of [-1.0, 1.0]) {
    b.box(0.08, 0.36, 1.8, p.paint, x, y + 0.43, 1.2);
  }

  // Tailgate
  const tailgateMats = [p.paint, p.paint, p.paint, p.paint, p.tailgate, p.paint];
  b.box(2.0, 0.36, 0.08, tailgateMats, 0, y + 0.43, 2.06);

  // Dual chrome vertical exhaust stacks
  for (const x of [-0.55, 0.55]) {
    b.cyl(0.08, 0.9, p.chrome, x, y + 1.0, 0.35, 'y', 8);
  }

  // Heavy-duty rock sliders / side nerf bars
  for (const x of [-1.06, 1.06]) {
    b.box(0.03, 0.18, 3.6, p.accent, x, y + 0.05, 0);
  }

  b.bumpers(p, y - 0.28, 2.15, 2.12);
  b.lights(p, y + 0.05, -2.12, 2.12, 0.4);

  return { rearR: r, wheelW: 0.75 };
}
