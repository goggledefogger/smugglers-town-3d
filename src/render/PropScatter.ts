/**
 * Scattered cover props (rocks, cacti) seated on the current terrain.
 * Re-seated whenever the terrain changes so they never float after a
 * relocation — sampling the CURRENT ground is the whole point. Each kind is
 * one InstancedMesh (two draw calls for the field) and each prop yields an
 * AABB so vehicles collide with what they can see.
 */
import {
  InstancedMesh, DodecahedronGeometry, CapsuleGeometry, MeshStandardMaterial, Group, Vector3, Matrix4,
  Quaternion, Euler
} from 'three';
import type { Heightfield } from '../core/heightfield.ts';
import type { BuildingCollider } from '../core/physics/VehicleBody.ts';

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3();

export class PropScatter {
  private readonly group = new Group();
  private meshes: InstancedMesh[] = [];
  readonly colliders: BuildingCollider[] = [];

  constructor(scene: { add(g: Group): void }) {
    scene.add(this.group);
  }

  /** Re-seat the props; `rng` seeded from the match makes every player's rocks the same rocks. */
  scatter(hf: Heightfield, mapHalf: number, real: boolean, rng: () => number = Math.random): void {
    this.clear();
    // On real satellite terrain the imagery already carries visual detail,
    // so keep props sparse (cover only) and skip the desert-only cacti
    const nRocks = real ? 180 : 400;
    const nCacti = real ? 0 : 300;
    const rocks = new InstancedMesh(
      new DodecahedronGeometry(2, 0), new MeshStandardMaterial({ color: 0x6a5a4a, roughness: 0.95 }), nRocks
    );
    for (let i = 0; i < nRocks; i++) {
      const x = (rng() - 0.5) * mapHalf * 1.9;
      const z = (rng() - 0.5) * mapHalf * 1.9;
      const y = hf.sample(x, z);
      const s = 0.5 + rng() * 1.8;
      _q.setFromEuler(_e.set(rng(), rng(), rng()));
      rocks.setMatrixAt(i, _m.compose(_p.set(x, y + s * 1.2, z), _q, _s.set(s, s * 0.8, s)));
      this.colliders.push({
        min: new Vector3(x - 1.8 * s, y, z - 1.8 * s),
        max: new Vector3(x + 1.8 * s, y + 2.8 * s, z + 1.8 * s),
        kind: 'prop'
      });
    }
    this.add(rocks);
    if (nCacti > 0) {
      const cacti = new InstancedMesh(
        new CapsuleGeometry(0.6, 3, 2, 6), new MeshStandardMaterial({ color: 0x3a7a3a, roughness: 0.9 }), nCacti
      );
      _q.identity();
      for (let i = 0; i < nCacti; i++) {
        const x = (rng() - 0.5) * mapHalf * 1.9;
        const z = (rng() - 0.5) * mapHalf * 1.9;
        const y = hf.sample(x, z);
        const sy = 1 + rng();
        cacti.setMatrixAt(i, _m.compose(_p.set(x, y + 2, z), _q, _s.set(1, sy, 1)));
        this.colliders.push({
          min: new Vector3(x - 0.6, y, z - 0.6),
          max: new Vector3(x + 0.6, y + 2 + 2.1 * sy, z + 0.6),
          kind: 'prop'
        });
      }
      this.add(cacti);
    }
  }

  private add(mesh: InstancedMesh): void {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.meshes.push(mesh);
  }

  clear(): void {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as MeshStandardMaterial).dispose();
      m.dispose();
    }
    this.meshes = [];
    this.colliders.length = 0;
  }

  dispose(): void {
    this.clear();
  }
}
