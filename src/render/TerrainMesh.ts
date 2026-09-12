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
  Mesh, PlaneGeometry, MeshStandardMaterial, MeshBasicMaterial, BufferAttribute, CanvasTexture,
  DataTexture, RedFormat, UnsignedByteType, NearestFilter,
  SRGBColorSpace, ClampToEdgeWrapping, RepeatWrapping, LinearMipmapLinearFilter,
  LinearFilter, Color, type BufferAttribute as BufferAttributeT, type BufferGeometry, type Material
} from 'three';
import { TERRAIN_COLORS } from '../core/theme.ts';
import type { TerrainProvider } from '../core/terrain/TerrainProvider.ts';
import type { Heightfield } from '../core/heightfield.ts';
import type { BuildingCollider } from '../core/physics/VehicleBody.ts';
import { injectDetailGrain } from './DetailGrain.ts';

/**
 * Where a streamed high-res satellite patch is loaded, the base terrain under
 * it is discarded per fragment instead of fought for with polygon offset: the
 * patch is a coarser triangulation of the same heightfield, so it dips below
 * the base mesh between its vertices and the blurry zoom-15 imagery (with its
 * painted building footprints) bled through as dark polygons.
 */
const COVER_PARS_VERTEX = `
varying vec2 vCoverXZ;
`;
const COVER_VERTEX = `
vCoverXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
`;
const COVER_PARS_FRAGMENT = `
uniform sampler2D uCover;
uniform float uCoverCell;
uniform float uCoverN;
varying vec2 vCoverXZ;
`;
const COVER_FRAGMENT = `
if (uCoverCell > 0.0) {
  vec2 cc = floor(vCoverXZ / uCoverCell + 0.5) + uCoverN * 0.5;
  if (all(greaterThanEqual(cc, vec2(0.0))) && all(lessThan(cc, vec2(uCoverN)))
      && texelFetch(uCover, ivec2(cc), 0).r > 0.0) discard;
}
`;

export interface TileFootprint {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * Procedural micro-surface sand and dune ripple texture for procedural terrain.
 * Multiplied over vertex colors to provide crisp, high-resolution physical sand & pebble
 * grain detail up close to the vehicle without any additional draw calls or fill-rate penalty.
 */
function createSandDetailTexture(anisotropy: number): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d');
    if (!ctx) return null;

    // Neutral base tone (~0.93 luminance) so multiplying by vertex colors preserves theme hue
    ctx.fillStyle = '#eeebe4';
    ctx.fillRect(0, 0, 512, 512);

    // 1. Natural wind-blown dune ripple ridges (transverse ripples)
    for (let y = 0; y < 512; y++) {
      const w1 = Math.sin((y / 512) * Math.PI * 16);
      const w2 = Math.sin((y / 512) * Math.PI * 32 + 1.2);
      const intensity = w1 * 0.045 + w2 * 0.025;
      const alpha = Math.abs(intensity);
      ctx.fillStyle = intensity > 0 ? `rgba(255, 255, 255, ${alpha})` : `rgba(160, 145, 125, ${alpha})`;
      ctx.fillRect(0, y, 512, 1);
    }

    // 2. High-frequency sand grain & pebble noise
    const imgData = ctx.getImageData(0, 0, 512, 512);
    const d = imgData.data;
    let s = 123456789;
    const nextRng = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s & 0xff) / 255;
    };

    for (let i = 0; i < d.length; i += 4) {
      const n = (nextRng() - 0.5) * 26;
      d[i] = Math.max(0, Math.min(255, d[i]! + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1]! + n * 0.95));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2]! + n * 0.85));
    }
    ctx.putImageData(imgData, 0, 0);

    const tex = new CanvasTexture(c);
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = Math.min(anisotropy, 4);
    return tex;
  } catch {
    return null;
  }
}

function createGridTexture(anisotropy: number): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = TERRAIN_COLORS.gridBg;
    ctx.fillRect(0, 0, 256, 256);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.fillRect(4, 4, 248, 248);

    ctx.strokeStyle = TERRAIN_COLORS.gridLine;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 252, 252);

    const tex = new CanvasTexture(c);
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = Math.min(anisotropy, 4);
    return tex;
  } catch {
    return null;
  }
}

/**
 * Set the plane's heights and normals straight from the heightfield grid.
 * PlaneGeometry(size, size, segs, segs) rotated to XZ puts vertex k at node k
 * of a heightfield with the same segs, so this is a copy plus central
 * differences: ~2 ms for the 315k-vertex field, where sampling every vertex
 * and computeVertexNormals was a 55 ms hitch each time the ground refined.
 */
function drapeOnGrid(geo: BufferGeometry, hf: Heightfield): void {
  const pos = geo.attributes.position as BufferAttributeT;
  const nrm = geo.attributes.normal as BufferAttributeT;
  const raw = hf.raw;
  const w = hf.segs + 1;
  if (pos.count !== raw.length) throw new Error(`terrain mesh ${pos.count} verts != heightfield ${raw.length}`);
  const p = pos.array as Float32Array;
  const n = nrm.array as Float32Array;
  const cell = hf.size / hf.segs;
  for (let k = 0; k < raw.length; k++) {
    const i = k % w, j = (k - i) / w;
    p[k * 3 + 1] = raw[k]!;
    const xl = raw[k - (i > 0 ? 1 : 0)]!, xr = raw[k + (i < w - 1 ? 1 : 0)]!;
    const zl = raw[k - (j > 0 ? w : 0)]!, zr = raw[k + (j < w - 1 ? w : 0)]!;
    const dx = (xr - xl) / (cell * ((i > 0 ? 1 : 0) + (i < w - 1 ? 1 : 0)));
    const dz = (zr - zl) / (cell * ((j > 0 ? 1 : 0) + (j < w - 1 ? 1 : 0)));
    const inv = 1 / Math.hypot(dx, 1, dz);
    n[k * 3] = -dx * inv;
    n[k * 3 + 1] = inv;
    n[k * 3 + 2] = -dz * inv;
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
}

export class TerrainMesh {
  private _mesh: Mesh | null = null;
  private _texture: CanvasTexture | null = null;
  private _sandTexture: CanvasTexture | null = null;
  private _gridTexture: CanvasTexture | null = null;
  private _sourceTexture: CanvasTexture | null = null;
  private _photorealMat: Material | null = null;
  private _game3dMat: MeshStandardMaterial | null = null;
  private readonly _uCover = { value: new DataTexture(new Uint8Array(1), 1, 1, RedFormat, UnsignedByteType) };
  private readonly _uCoverCell = { value: 0 };
  private readonly _uCoverN = { value: 1 };
  private _mode: 'photoreal' | 'masked-tiles' | 'projected-3d' | 'game3d' | 'game3d-textured' | 'game3d-planar' | 'game3d-hybrid' = 'photoreal';
  private _sourceCanvas: HTMLCanvasElement | null = null;
  private _workingCanvas: HTMLCanvasElement | null = null;
  private _lastNeutralizedGeneration = -1;
  private _pendingGeneration = -1;
  private _pendingColliders: readonly BuildingCollider[] | null = null;
  private _pendingMapSize = 0;
  private _pendingStreetColor: string | undefined = undefined;

  get mesh(): Mesh | null {
    return this._mesh;
  }

  get texture(): CanvasTexture | null {
    return this._texture;
  }

  /** Pristine source satellite texture with un-neutralized building rooftops intact. */
  get sourceTexture(): CanvasTexture | null {
    if (!this._sourceTexture && this._sourceCanvas) {
      const tex = new CanvasTexture(this._sourceCanvas);
      tex.colorSpace = SRGBColorSpace;
      tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.magFilter = LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      this._sourceTexture = tex;
    }
    return this._sourceTexture ?? this._texture;
  }

  get sandTexture(): CanvasTexture | null {
    return this._sandTexture;
  }

  get gridTexture(): CanvasTexture | null {
    return this._gridTexture;
  }

  setMode(mode: 'photoreal' | 'masked-tiles' | 'projected-3d' | 'game3d' | 'game3d-textured' | 'game3d-planar' | 'game3d-hybrid'): void {
    this._mode = mode;
    const isArcadeGrid = mode === 'game3d';
    if (this._mesh) {
      this._mesh.material = (isArcadeGrid && this._game3dMat)
        ? this._game3dMat
        : (this._photorealMat ?? this._mesh.material);
    }
    // If switching to a mode showing satellite ground and we have pending un-neutralized colliders, paint now
    if (mode !== 'game3d' && this._pendingColliders && this._pendingGeneration !== this._lastNeutralizedGeneration) {
      this.neutralizeBuildingFootprints(
        this._pendingColliders,
        this._pendingMapSize,
        this._pendingGeneration,
        this._pendingStreetColor
      );
    }
  }

  markTextureNeedsUpdate(): void {
    if (this._texture) this._texture.needsUpdate = true;
  }

  build(provider: TerrainProvider, anisotropy: number): Mesh {
    this.dispose();
    this._lastNeutralizedGeneration = -1;
    this._pendingGeneration = -1;
    this._pendingColliders = null;
    this._pendingMapSize = 0;

    const hf = provider.heightfield;
    const seg = hf.segs;
    const size = hf.size;
    const geo = new PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as BufferAttributeT;

    // 1. Build Photoreal material
    if (provider.isReal && provider.satelliteCanvas) {
      if (typeof document !== 'undefined') {
        try {
          const sw = provider.satelliteCanvas.width;
          const sh = provider.satelliteCanvas.height;
          const src = document.createElement('canvas');
          src.width = sw;
          src.height = sh;
          src.getContext('2d')?.drawImage(provider.satelliteCanvas, 0, 0);
          this._sourceCanvas = src;

          const work = document.createElement('canvas');
          work.width = sw;
          work.height = sh;
          work.getContext('2d')?.drawImage(src, 0, 0);
          this._workingCanvas = work;
        } catch {
          this._sourceCanvas = null;
          this._workingCanvas = provider.satelliteCanvas;
        }
      } else if (provider.satelliteCanvas) {
        this._sourceCanvas = provider.satelliteCanvas;
        this._workingCanvas = provider.satelliteCanvas;
      }
      const texCanvas = this._workingCanvas ?? provider.satelliteCanvas;
      const tex = new CanvasTexture(texCanvas);
      tex.colorSpace = SRGBColorSpace;
      tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.magFilter = LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = Math.min(anisotropy, 4);
      tex.needsUpdate = true;
      this._texture = tex;

      // unlit like the Google tiles: the imagery already carries its own
      // daylight, and lighting it again put a blue cast on the ground that the
      // buildings standing on it did not have
      const mat = new MeshBasicMaterial({
        map: tex,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: 3,
        polygonOffsetUnits: 3
      });
      mat.onBeforeCompile = shader => {
        injectDetailGrain(shader);
        shader.uniforms.uCover = this._uCover;
        shader.uniforms.uCoverCell = this._uCoverCell;
        shader.uniforms.uCoverN = this._uCoverN;
        shader.vertexShader = COVER_PARS_VERTEX + shader.vertexShader
          .replace('#include <begin_vertex>', '#include <begin_vertex>' + COVER_VERTEX);
        shader.fragmentShader = COVER_PARS_FRAGMENT + shader.fragmentShader
          .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + COVER_FRAGMENT);
      };
      mat.customProgramCacheKey = () => 'satellite-ground';
      this._photorealMat = mat;
    } else {
      // Crisp alpine/canyon biome: low=dark slate bedrock, mid=mossy steppe, high=granite cliff, peaks=snowcap
      const colors = new Float32Array(pos.count * 3);
      const col = new Color();
      const { bedrock, steppe, cliff, snow } = TERRAIN_COLORS.biome;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const h = hf.sample(x, z);
        pos.setY(i, h);
        let r: number, g: number, b: number;
        if (h < 8) { [r, g, b] = bedrock; }
        else if (h < 65) { [r, g, b] = steppe; }
        else if (h < 175) { [r, g, b] = cliff; }
        else { [r, g, b] = snow; }
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

      // Procedural micro-surface sand detail texture multiplied over vertex colors
      const sandTex = createSandDetailTexture(anisotropy);
      if (sandTex) {
        sandTex.repeat.set(size / 32, size / 32);
        this._sandTexture = sandTex;
      }

      this._photorealMat = new MeshStandardMaterial({
        vertexColors: true,
        ...(sandTex ? { map: sandTex } : {}),
        roughness: 0.92,
        metalness: 0.02,
        polygonOffset: true,
        polygonOffsetFactor: 3,
        polygonOffsetUnits: 3
      });
    }

    // 2. Build Game 3D stylized material (crisp 10m grid)
    const gridTex = createGridTexture(anisotropy);
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
    drapeOnGrid(geo, hf);
    return this._mesh;
  }

  /**
   * Cells of the ground streamer's patch grid that currently hold a patch
   * (n*n, cell (c, r) at index (r + n/2) * n + c + n/2; cells are `cellSize`
   * wide and centred on multiples of it). The buffer is wrapped; call again
   * after every change.
   */
  setPatchCoverage(cells: Uint8Array, n: number, cellSize: number): void {
    const tex = this._uCover.value;
    if (tex.image.data !== cells) {
      tex.dispose();
      const t = new DataTexture(cells, n, n, RedFormat, UnsignedByteType);
      t.minFilter = t.magFilter = NearestFilter;
      this._uCover.value = t;
    }
    this._uCover.value.needsUpdate = true;
    this._uCoverCell.value = cellSize;
    this._uCoverN.value = n;
  }

  /** Re-drape on a changed heightfield of the same size; the streamed ground sharpens after play starts. */
  refresh(hf: Heightfield): void {
    const m = this._mesh;
    if (!m) return;
    drapeOnGrid(m.geometry, hf);
  }

  /**
   * Neutralizes 2D aerial satellite building footprints/roofs under and around 3D buildings.
   *
   * Non-destructive: restores the pristine source imagery from _sourceCanvas before
   * filling the current active building footprints with the ambient street tone.
   * Gated on mode: skipped in Game 3D mode.
   * Memoized on generation: skipped if this exact collider generation was already painted.
   */
  neutralizeBuildingFootprints(
    colliders: readonly BuildingCollider[],
    mapSize: number,
    generation: number,
    streetColor?: string
  ): void {
    this._pendingColliders = colliders;
    this._pendingMapSize = mapSize;
    this._pendingGeneration = generation;
    this._pendingStreetColor = streetColor;

    // 1. Do not run paint pass in Game 3D mode where the texture is not visible
    if (this._mode === 'game3d') return;
    // 2. Skip if this exact collider generation has already been painted
    if (generation === this._lastNeutralizedGeneration) return;
    if (typeof HTMLCanvasElement === 'undefined') return;

    const work = this._workingCanvas ?? (this._texture?.image as HTMLCanvasElement | null);
    if (!(work instanceof HTMLCanvasElement)) return;
    const ctx = work.getContext('2d');
    if (!ctx) return;

    const cw = work.width;
    const ch = work.height;
    if (cw <= 0 || ch <= 0) return;

    // 3. Non-destructively restore pristine source satellite imagery (GPU blit ~0.2ms)
    if (this._sourceCanvas) {
      ctx.drawImage(this._sourceCanvas, 0, 0);
    }

    // 4. Fill active building footprints with verified street tone
    ctx.fillStyle = streetColor ?? '#3e434a';

    const scaleX = cw / mapSize;
    const scaleY = ch / mapSize;
    const half = mapSize / 2;

    let painted = 0;
    for (const b of colliders) {
      if (b.kind === 'prop') continue;
      const w = b.max.x - b.min.x;
      const d = b.max.z - b.min.z;
      const h = b.max.y - b.min.y;
      if (w < 4 || d < 4 || h < 3) continue;

      const x0 = (b.min.x + half) * scaleX;
      const x1 = (b.max.x + half) * scaleX;
      const y0 = (b.min.z + half) * scaleY;
      const y1 = (b.max.z + half) * scaleY;

      // At ~2.9m/px, 10m cell is ~3.4px. Pad 1-2 pixels (~3-6m) to cover roof eaves & off-nadir shift
      const pad = Math.max(1, Math.min(2, Math.round(h * 0.04 * scaleX)));
      const bx = Math.floor(Math.min(x0, x1) - pad);
      const by = Math.floor(Math.min(y0, y1) - pad);
      const bw = Math.ceil(Math.abs(x1 - x0) + 2 * pad);
      const bh = Math.ceil(Math.abs(y1 - y0) + 2 * pad);

      ctx.fillRect(bx, by, bw, bh);
      painted++;
    }

    this._lastNeutralizedGeneration = generation;
    if (painted > 0 || this._sourceCanvas) {
      this.markTextureNeedsUpdate();
    }
  }

  dispose(): void {
    if (this._mesh) {
      this._mesh.geometry.dispose();
      (this._photorealMat as MeshBasicMaterial | null)?.map?.dispose();
      this._photorealMat?.dispose();
      this._game3dMat?.map?.dispose();
      this._game3dMat?.dispose();
      this._mesh = null;
    }
    if (this._sandTexture) {
      this._sandTexture.dispose();
      this._sandTexture = null;
    }
    if (this._gridTexture) {
      this._gridTexture.dispose();
      this._gridTexture = null;
    }
    if (this._sourceTexture) {
      this._sourceTexture.dispose();
      this._sourceTexture = null;
    }
    this._photorealMat = null;
    this._game3dMat = null;
    this._uCoverCell.value = 0;
    this._texture = null;
    this._sourceCanvas = null;
    this._workingCanvas = null;
    this._lastNeutralizedGeneration = -1;
    this._pendingGeneration = -1;
    this._pendingColliders = null;
    this._pendingStreetColor = undefined;
  }
}
