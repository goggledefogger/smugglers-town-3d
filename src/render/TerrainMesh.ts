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
import type { BuildingCollider } from '../core/physics/VehicleBody.ts';

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
  private _lastNeutralizedCount = -1;

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

  /**
   * Neutralizes 2D aerial satellite building footprints/roofs under and around 3D buildings.
   *
   * Aerial photography contains off-nadir parallax/relief displacement (building rooftops
   * and facades in 2D imagery are shifted 5-18m away from building bases). When 3D buildings
   * are placed or 3D tiles meet the terrain, these displaced 2D rooftops appear as duplicate
   * "ghost" buildings printed on the ground.
   *
   * For each building collider, this samples the ambient street/ground color along its perimeter
   * and paints the footprint with that neutral ground tone (with a soft blend margin),
   * seamlessly replacing flat rooftop graphics with clean street pavement.
   */
  neutralizeBuildingFootprints(
    colliders: readonly BuildingCollider[],
    mapSize: number
  ): void {
    if (colliders.length === 0 || colliders.length === this._lastNeutralizedCount) return;
    if (typeof HTMLCanvasElement === 'undefined') return;
    const canvas = this._texture?.image;
    if (!(canvas instanceof HTMLCanvasElement)) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cw = canvas.width;
    const ch = canvas.height;
    if (cw <= 0 || ch <= 0) return;

    let imgData: ImageData;
    try {
      imgData = ctx.getImageData(0, 0, cw, ch);
    } catch {
      return;
    }

    const data = imgData.data;
    const scaleX = cw / mapSize;
    const scaleY = ch / mapSize;
    const half = mapSize / 2;

    let modified = false;

    for (const b of colliders) {
      if (b.kind === 'prop') continue;
      const w = b.max.x - b.min.x;
      const d = b.max.z - b.min.z;
      const h = b.max.y - b.min.y;
      // Skip tiny props or boxes that are not buildings
      if (w < 4 || d < 4 || h < 3) continue;

      // Project world bounds to canvas pixel coordinates
      const x0 = (b.min.x + half) * scaleX;
      const x1 = (b.max.x + half) * scaleX;
      const y0 = (b.min.z + half) * scaleY;
      const y1 = (b.max.z + half) * scaleY;

      // Relief displacement padding: building roofs tilt away from nadir by up to h * 0.15
      // Adding 2 to 6 pixels (~3 to 10 meters) covers the displaced roof and eaves
      const pad = Math.max(2, Math.min(6, Math.round(h * 0.12 * scaleX)));
      const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
      const bx1 = Math.min(cw - 1, Math.ceil(Math.max(x0, x1) + pad));
      const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
      const by1 = Math.min(ch - 1, Math.ceil(Math.max(y0, y1) + pad));

      const bw = bx1 - bx0 + 1;
      const bh = by1 - by0 + 1;
      if (bw <= 0 || bh <= 0) continue;

      // Sample ambient ground color around the perimeter (outer ring of border pixels)
      let sumR = 0, sumG = 0, sumB = 0, sampleCount = 0;

      const ring = 2; // 2 pixels outside footprint
      const sx0 = Math.max(0, bx0 - ring);
      const sx1 = Math.min(cw - 1, bx1 + ring);
      const sy0 = Math.max(0, by0 - ring);
      const sy1 = Math.min(ch - 1, by1 + ring);

      const stepX = Math.max(1, Math.floor((sx1 - sx0) / 4));
      const stepY = Math.max(1, Math.floor((sy1 - sy0) / 4));

      for (let px = sx0; px <= sx1; px += stepX) {
        // Top edge
        const idxTop = (sy0 * cw + px) * 4;
        sumR += data[idxTop]!;
        sumG += data[idxTop + 1]!;
        sumB += data[idxTop + 2]!;
        // Bottom edge
        const idxBot = (sy1 * cw + px) * 4;
        sumR += data[idxBot]!;
        sumG += data[idxBot + 1]!;
        sumB += data[idxBot + 2]!;
        sampleCount += 2;
      }

      for (let py = sy0 + stepY; py < sy1; py += stepY) {
        // Left edge
        const idxLeft = (py * cw + sx0) * 4;
        sumR += data[idxLeft]!;
        sumG += data[idxLeft + 1]!;
        sumB += data[idxLeft + 2]!;
        // Right edge
        const idxRight = (py * cw + sx1) * 4;
        sumR += data[idxRight]!;
        sumG += data[idxRight + 1]!;
        sumB += data[idxRight + 2]!;
        sampleCount += 2;
      }

      if (sampleCount === 0) continue;

      const avgR = Math.round(sumR / sampleCount);
      const avgG = Math.round(sumG / sampleCount);
      const avgB = Math.round(sumB / sampleCount);

      // Fill footprint with ambient ground color, with a 1-pixel soft blend at the outer edge
      for (let py = by0; py <= by1; py++) {
        const rowOffset = py * cw;
        const edgeDistY = Math.min(py - by0, by1 - py);

        for (let px = bx0; px <= bx1; px++) {
          const edgeDistX = Math.min(px - bx0, bx1 - px);
          const edgeDist = Math.min(edgeDistX, edgeDistY);
          const idx = (rowOffset + px) * 4;

          if (edgeDist === 0) {
            // 50% blend with original at border
            data[idx] = (data[idx]! + avgR) >> 1;
            data[idx + 1] = (data[idx + 1]! + avgG) >> 1;
            data[idx + 2] = (data[idx + 2]! + avgB) >> 1;
          } else {
            // Full ambient ground fill
            data[idx] = avgR;
            data[idx + 1] = avgG;
            data[idx + 2] = avgB;
          }
        }
      }
      modified = true;
    }

    if (modified) {
      ctx.putImageData(imgData, 0, 0);
      this._lastNeutralizedCount = colliders.length;
      this.markTextureNeedsUpdate();
    }
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
    this._lastNeutralizedCount = -1;
  }
}
