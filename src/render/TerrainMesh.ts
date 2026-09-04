/**
 * Terrain mesh built from a Heightfield. Procedural terrain gets a
 * height-tinted vertex color palette; real terrain gets the satellite canvas
 * as an sRGB texture with mipmaps + anisotropy for crisp detail.
 *
 * Renders continuously across the entire 5.6km map with positive polygon offset
 * so that where 3D photogrammetry tiles exist, the opaque 3D pavement, buildings,
 * and river surfaces cleanly win depth testing without z-fighting, while seamlessly
 * continuing outside the 3D tile boundary with zero gaps or holes.
 */
import {
  Mesh, PlaneGeometry, MeshStandardMaterial, BufferAttribute, CanvasTexture,
  SRGBColorSpace, ClampToEdgeWrapping, RepeatWrapping, LinearMipmapLinearFilter,
  LinearFilter, Color, type BufferAttribute as BufferAttributeT
} from 'three';
import type { TerrainProvider } from '../core/terrain/TerrainProvider.ts';
import type { Heightfield } from '../core/heightfield.ts';

export interface TileFootprint {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

function createGridTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#1e232a';
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = '#2d3748';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, 64, 64);
    const tex = new CanvasTexture(c);
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = true;
    return tex;
  } catch {
    return null;
  }
}

export class TerrainMesh {
  private _mesh: Mesh | null = null;
  private _texture: CanvasTexture | null = null;
  private _gridTexture: CanvasTexture | null = null;
  private _photorealMat: MeshStandardMaterial | null = null;
  private _game3dMat: MeshStandardMaterial | null = null;
  private _mode: 'photoreal' | 'game3d' = 'photoreal';

  get mesh(): Mesh | null {
    return this._mesh;
  }

  get texture(): CanvasTexture | null {
    return this._texture;
  }

  get gridTexture(): CanvasTexture | null {
    return this._gridTexture;
  }

  setMode(mode: 'photoreal' | 'game3d'): void {
    this._mode = mode;
    if (this._mesh) {
      this._mesh.material = (mode === 'game3d' && this._game3dMat)
        ? this._game3dMat
        : (this._photorealMat ?? this._mesh.material);
    }
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

    // 1. Build Photoreal material
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

      this._photorealMat = new MeshStandardMaterial({
        map: tex,
        roughness: 0.96,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: 3,
        polygonOffsetUnits: 3
      });
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
      this._photorealMat = new MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: 3,
        polygonOffsetUnits: 3
      });
    }

    // 2. Build Game 3D stylized material (crisp 10m grid)
    const gridTex = createGridTexture();
    if (gridTex) {
      gridTex.repeat.set(size / 10, size / 10);
      this._gridTexture = gridTex;
    }
    this._game3dMat = new MeshStandardMaterial({
      color: gridTex ? 0xffffff : 0x1e232a,
      ...(gridTex ? { map: gridTex } : {}),
      roughness: 0.88,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: 3,
      polygonOffsetUnits: 3
    });

    const mat = (this._mode === 'game3d' && this._game3dMat) ? this._game3dMat : this._photorealMat;
    this._mesh = new Mesh(geo, mat);
    geo.computeVertexNormals();
    return this._mesh;
  }

  /** No-op compatibility hook */
  updateCutout(_bounds: readonly TileFootprint[]): void {
    // Continuous seamless terrain underlay; no alpha cutouts
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
    if (this._mesh) {
      this._mesh.geometry.dispose();
      this._photorealMat?.map?.dispose();
      this._photorealMat?.dispose();
      this._game3dMat?.map?.dispose();
      this._game3dMat?.dispose();
      this._mesh = null;
    }
    this._photorealMat = null;
    this._game3dMat = null;
    this._texture = null;
    this._gridTexture = null;
  }
}
