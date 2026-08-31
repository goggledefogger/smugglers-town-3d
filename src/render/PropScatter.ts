/**
 * Scattered cover props (rocks, cacti) seated on the current terrain.
 * Re-seated whenever the terrain changes so they never float after a
 * relocation — sampling the CURRENT ground is the whole point.
 */
import { Mesh, DodecahedronGeometry, CapsuleGeometry, MeshStandardMaterial, Group } from 'three';
import type { Heightfield } from '../core/heightfield.ts';

export class PropScatter {
  private readonly group = new Group();
  private readonly meshes: Mesh[] = [];

  constructor(scene: { add(g: Group): void }) {
    scene.add(this.group);
  }

  scatter(hf: Heightfield, mapHalf: number, real: boolean): void {
    this.clear();
    // On real satellite terrain the imagery already carries visual detail,
    // so keep props sparse (cover only) and skip the desert-only cacti
    const nRocks = real ? 36 : 80;
    const nCacti = real ? 0 : 60;
    const rockMat = new MeshStandardMaterial({ color: 0x6a5a4a, roughness: 0.95 });
    const rockGeo = new DodecahedronGeometry(2, 0);
    for (let i = 0; i < nRocks; i++) {
      const x = (Math.random() - 0.5) * mapHalf * 1.9;
      const z = (Math.random() - 0.5) * mapHalf * 1.9;
      const y = hf.sample(x, z);
      const r = new Mesh(rockGeo, rockMat);
      const s = 0.5 + Math.random() * 1.8;
      r.scale.set(s, s * 0.8, s);
      r.position.set(x, y + s * 1.2, z);
      r.rotation.set(Math.random(), Math.random(), Math.random());
      this.group.add(r);
      this.meshes.push(r);
    }
    const cactMat = new MeshStandardMaterial({ color: 0x3a7a3a, roughness: 0.9 });
    const cactGeo = new CapsuleGeometry(0.6, 3, 2, 6);
    for (let i = 0; i < nCacti; i++) {
      const x = (Math.random() - 0.5) * mapHalf * 1.9;
      const z = (Math.random() - 0.5) * mapHalf * 1.9;
      const y = hf.sample(x, z);
      const c = new Mesh(cactGeo, cactMat);
      c.position.set(x, y + 2, z);
      c.scale.set(1, 1 + Math.random(), 1);
      this.group.add(c);
      this.meshes.push(c);
    }
  }

  clear(): void {
    for (const m of this.meshes) {
      this.group.remove(m);
    }
    this.meshes.length = 0;
  }

  dispose(): void {
    this.clear();
  }
}
