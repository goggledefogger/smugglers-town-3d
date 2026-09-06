import {
  Group, Mesh, BoxGeometry, CylinderGeometry,
  type MeshStandardMaterial, type MeshPhysicalMaterial
} from 'three';
import type { VehiclePalette } from './types.ts';

type Mat = MeshStandardMaterial | MeshPhysicalMaterial | (MeshStandardMaterial | MeshPhysicalMaterial)[];

/**
 * Geometric assembly builder bound to a vehicle root group.
 * Provides fluent primitive construction for vehicle silhouettes.
 */
export class VehicleMeshBuilder {
  constructor(readonly g: Group) {}

  /** Box placed at (x, y, z) with optional rotation about local X. */
  box(w: number, h: number, d: number, m: Mat, x: number, y: number, z: number, rx = 0): Mesh {
    const mesh = new Mesh(new BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    if (rx) mesh.rotation.x = rx;
    this.g.add(mesh);
    return mesh;
  }

  /** Cylinder aligned along 'x', 'y', or 'z' axis. */
  cyl(r: number, len: number, m: Mat, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y', segs = 10): Mesh {
    const mesh = new Mesh(new CylinderGeometry(r, r, len, segs), m);
    mesh.position.set(x, y, z);
    if (axis === 'x') mesh.rotation.z = Math.PI / 2;
    if (axis === 'z') mesh.rotation.x = Math.PI / 2;
    this.g.add(mesh);
    return mesh;
  }

  /** Headlights and taillights placed symmetrically at front and rear Z coordinates. */
  lights(p: VehiclePalette, y: number, frontZ: number, rearZ: number, w = 0.36): void {
    for (const x of [-0.7, 0.7]) {
      this.box(w, 0.16, 0.06, p.head, x, y, frontZ);
      this.box(w, 0.12, 0.06, p.tail, x, y, rearZ);
    }
  }

  /** Front and rear bumper blocks. */
  bumpers(p: VehiclePalette, y: number, w: number, z: number): void {
    this.box(w, 0.22, 0.18, p.dark, 0, y, -z);
    this.box(w, 0.22, 0.18, p.dark, 0, y, z);
  }

  /** A treaded wheel with rim-textured sidewall caps, nested inside an axle spin group. */
  wheel(r: number, width: number, p: VehiclePalette): Group {
    const spin = new Group();
    spin.rotation.z = Math.PI / 2;
    spin.add(new Mesh(new CylinderGeometry(r, r, width, 20), p.tire));
    return spin;
  }
}
