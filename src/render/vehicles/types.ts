import type { Group, MeshStandardMaterial, MeshPhysicalMaterial } from 'three';
import type { VehicleMeshBuilder } from './VehicleMeshBuilder.ts';

export interface VehicleMesh {
  readonly root: Group;
  /** Spin groups (rotate about local Y = axle) with their radii. */
  readonly wheels: readonly { readonly spin: Group; readonly r: number }[];
  readonly frontPivots: readonly Group[];
  /** Front wheel radius: the ride-height reference for the body. */
  readonly wheelR: number;
  /** Tail-light material; brightened while braking. */
  readonly tail: MeshStandardMaterial;
}

export interface VehicleLayout {
  /** Rear wheel radius (front is wheelR). */
  readonly rearR: number;
  /** Width of the tire cylinder. */
  readonly wheelW: number;
}

export interface VehiclePalette {
  readonly paint: MeshPhysicalMaterial;
  /** Body box faces: [+x right, -x left, +y top, -y bottom, +z back/rear, -z front]. */
  readonly body: MeshPhysicalMaterial[];
  readonly top: MeshPhysicalMaterial;
  readonly roof: MeshPhysicalMaterial;
  readonly rear: MeshPhysicalMaterial;
  readonly tailgate: MeshPhysicalMaterial;
  readonly hood: MeshPhysicalMaterial;
  readonly dark: MeshStandardMaterial;
  readonly glass: MeshStandardMaterial;
  readonly accent: MeshStandardMaterial;
  readonly chrome: MeshStandardMaterial;
  /** Tire cylinder groups: [tread around, sidewall cap, sidewall cap]. */
  readonly tire: MeshStandardMaterial[];
  readonly head: MeshStandardMaterial;
  readonly tail: MeshStandardMaterial;
}

export type VehicleModelBuilder = (b: VehicleMeshBuilder, p: VehiclePalette, r: number) => VehicleLayout;
export type VehicleArchetype = 'Dune Buggy' | 'Rally Car' | 'SUV' | 'Trophy Truck' | 'Monster Truck';
