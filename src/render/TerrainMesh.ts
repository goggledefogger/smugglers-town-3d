/**
 * Terrain mesh built from a Heightfield. Procedural terrain gets a
 * height-tinted vertex color palette; real terrain gets the satellite canvas
 * as an sRGB texture with mipmaps + anisotropy for crisp detail.
 */
import {
  Mesh, PlaneGeometry, MeshStandardMaterial, BufferAttribute, CanvasTexture,
  SRGBColorSpace, ClampToEdgeWrapping, LinearMipmapLinearFilter, LinearFilter, Color,
  type BufferAttribute as BufferAttributeT
} from 'three';
import type { TerrainProvider } from '../core/terrain/TerrainProvider.ts';
import type { Heightfield } from '../core/heightfield.ts';

export class TerrainMesh {
  private _mesh: Mesh | null = null;
  private _texture: CanvasTexture | null = null;

  get mesh(): Mesh | null {
    return this._mesh;
  }

  get texture(): CanvasTexture | null {
    return this._texture;
  }

  markTextureNeedsUpdate(): void {
    if (this._texture) this._texture.needsUpdate = true;
  }

  build(provider: TerrainProvider, anisotropy: number): Mesh {
    this.dispose();
    const hf = provider.heightfield;
    const seg = hf.segs;
    const size = hf.size;
    const geo = new PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as BufferAttributeT;

    if (provider.isReal && provider.satelliteCanvas) {
      for (let i = 0; i < pos.count; i++) {
        pos.setY(i, hf.sample(pos.getX(i), pos.getZ(i)));
      }
      const tex = new CanvasTexture(provider.satelliteCanvas);
      tex.colorSpace = SRGBColorSpace;
      tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.magFilter = LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = anisotropy;
      tex.needsUpdate = true;
      this._texture = tex;
      const mat = new MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0 });
      this._mesh = new Mesh(geo, mat);
    } else {
      // Desert palette: low=sand, mid=rock, high=snow cap, canyon=dark
      const colors = new Float32Array(pos.count * 3);
      const col = new Color();
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const h = hf.sample(x, z);
        pos.setY(i, h);
        let r: number, g: number, b: number;
        if (h < 7) { r = 0.76; g = 0.62; b = 0.42; }
        else if (h < 65) { r = 0.82; g = 0.68; b = 0.45; }
        else if (h < 175) { r = 0.6; g = 0.5; b = 0.36; }
        else { r = 0.85; g = 0.85; b = 0.82; }
        const n = (Math.sin(x * 0.045) + Math.cos(z * 0.04)) * 0.03;
        col.setRGB(
          Math.max(0, Math.min(1, r + n)),
          Math.max(0, Math.min(1, g + n)),
          Math.max(0, Math.min(1, b + n))
        );
        colors[i * 3] = col.r;
        colors[i * 3 + 1] = col.g;
        colors[i * 3 + 2] = col.b;
      }
      geo.setAttribute('color', new BufferAttribute(colors, 3));
      const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
      this._mesh = new Mesh(geo, mat);
    }
    geo.computeVertexNormals();
    return this._mesh;
  }

  /** Re-drape on a changed heightfield of the same size; the streamed ground sharpens after play starts. */
  refresh(hf: Heightfield): void {
    const m = this._mesh;
    if (!m) return;
    const pos = m.geometry.attributes.position as BufferAttributeT;
    for (let i = 0; i < pos.count; i++) pos.setY(i, hf.sample(pos.getX(i), pos.getZ(i)));
    pos.needsUpdate = true;
    m.geometry.computeVertexNormals();
  }

  dispose(): void {
    if (!this._mesh) return;
    this._mesh.geometry.dispose();
    const mat = this._mesh.material as MeshStandardMaterial;
    mat.map?.dispose();
    mat.dispose();
    this._mesh = null;
    this._texture = null;
  }
}
