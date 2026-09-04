import {
  Group, Mesh, PlaneGeometry, MeshStandardMaterial, Texture, BufferAttribute,
  SRGBColorSpace, ClampToEdgeWrapping, LinearMipmapLinearFilter, LinearFilter
} from 'three';
import { satelliteUrl, latLonToWorldPixel, worldPixelToLatLon } from './MapsApi.ts';
import { tileCache } from '../tiles/TileCache.ts';
import { logger } from '../../app/log.ts';
import { EARTH_RADIUS_M, WORLD_M_PER_M } from '../../core/geo/ecef.ts';
import type { Heightfield } from '../../core/heightfield.ts';

const log = logger('ground-streamer');

export interface GroundStreamerOptions {
  readonly apiKey: string;
  readonly center: { lat: number; lon: number };
  readonly heightfield: Heightfield;
  readonly anisotropy?: number | undefined;
  /** High-resolution zoom level (default 18 for ~0.25m/px, 19 for ~0.12m/px). */
  readonly zoom?: number | undefined;
  /** Keep radius around player in world units (default 800 units = ~800m). */
  readonly keepRadiusUnits?: number | undefined;
  /** Max patches in memory. */
  readonly maxPatches?: number | undefined;
  /** Optional filter to skip streaming 2D patches over areas already covered by 3D tiles. */
  readonly isTileCovered?: ((wx: number, wz: number) => boolean) | undefined;
}

interface LoadedPatch {
  readonly key: string;
  readonly col: number;
  readonly row: number;
  readonly mesh: Mesh;
  readonly centerWx: number;
  readonly centerWz: number;
}

/**
 * Progressively streams high-resolution (Zoom 18, ~0.25m/pixel) Google Maps
 * satellite ground patches around the player's vehicle, draped directly onto
 * the terrain heightfield with zero downsampling or texture squishing.
 */
export class GroundStreamer {
  readonly group = new Group();
  private readonly apiKey: string;
  private readonly center: { lat: number; lon: number };
  private readonly heightfield: Heightfield;
  private readonly anisotropy: number;
  private readonly zoom: number;
  private readonly keepRadiusUnits: number;
  private readonly maxPatches: number;
  private readonly isTileCovered?: ((wx: number, wz: number) => boolean) | undefined;

  private readonly cosLat: number;
  readonly tileSizeUnits: number;

  private readonly patches = new Map<string, LoadedPatch>();
  private readonly inFlightKeys = new Set<string>();
  private inFlight = false;
  private lastPickMs = 0;
  private disposed = false;

  constructor(opts: GroundStreamerOptions) {
    this.apiKey = opts.apiKey;
    this.center = opts.center;
    this.heightfield = opts.heightfield;
    this.anisotropy = opts.anisotropy ?? 1;
    this.zoom = opts.zoom ?? 18;
    this.keepRadiusUnits = opts.keepRadiusUnits ?? 800;
    this.maxPatches = opts.maxPatches ?? 16;
    this.isTileCovered = opts.isTileCovered;

    this.cosLat = Math.max(0.2, Math.cos((this.center.lat * Math.PI) / 180));
    // Physical tile size on ground in meters:
    // In Web Mercator, a 640px image at zoom Z covers:
    // 640 * (2 * PI * EARTH_RADIUS_M * cosLat) / (256 * 2^zoom) = 5 * PI * EARTH_RADIUS_M * cosLat / 2^zoom
    this.tileSizeUnits = (5 * Math.PI * EARTH_RADIUS_M * this.cosLat) / Math.pow(2, this.zoom) * WORLD_M_PER_M;
  }

  get patchCount(): number {
    return this.patches.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.patches.values()) {
      this.group.remove(p.mesh);
      p.mesh.geometry.dispose();
      const mat = p.mesh.material as MeshStandardMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
    this.patches.clear();
    this.inFlightKeys.clear();
    this.group.clear();
  }

  /** Re-sample vertex heights if heightfield is updated (e.g. 3D tiles datum calibration). */
  refresh(): void {
    for (const p of this.patches.values()) {
      const pos = p.mesh.geometry.attributes.position as BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const lx = pos.getX(i);
        const lz = pos.getZ(i);
        const wx = p.centerWx + lx;
        const wz = p.centerWz + lz;
        pos.setY(i, this.heightfield.sample(wx, wz));
      }
      pos.needsUpdate = true;
      p.mesh.geometry.computeVertexNormals();
    }
  }

  /**
   * Called with the vehicle world position (or showroom camera position).
   * Picks the closest un-fetched high-res patch under/near the player and streams it.
   */
  update(playerWorld: { x: number; z: number }, nowMs: number): void {
    if (this.disposed) return;

    // Evict patches farther than keepRadiusUnits
    for (const [key, p] of this.patches) {
      const dist = Math.hypot(p.centerWx - playerWorld.x, p.centerWz - playerWorld.z);
      if (dist > this.keepRadiusUnits) {
        this.group.remove(p.mesh);
        p.mesh.geometry.dispose();
        const mat = p.mesh.material as MeshStandardMaterial;
        mat.map?.dispose();
        mat.dispose();
        this.patches.delete(key);
      }
    }

    if (this.inFlight || nowMs - this.lastPickMs < 300) return;
    this.lastPickMs = nowMs;

    const half = this.heightfield.size / 2;
    const centerCol = Math.round(playerWorld.x / this.tileSizeUnits);
    const centerRow = Math.round(playerWorld.z / this.tileSizeUnits);

    let bestKey: string | null = null;
    let bestDist = Infinity;
    let bestCol = 0, bestRow = 0;
    let bestWx = 0, bestWz = 0;

    // Check a 3x3 ring of neighborhood patches around the player
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const c = centerCol + dc;
        const r = centerRow + dr;
        const key = `${this.zoom}:${c}:${r}`;
        if (this.patches.has(key) || this.inFlightKeys.has(key)) continue;

        const cellWx = c * this.tileSizeUnits;
        const cellWz = r * this.tileSizeUnits;
        if (cellWx < -half || cellWx > half || cellWz < -half || cellWz > half) continue;
        if (this.isTileCovered?.(cellWx, cellWz)) continue;

        const dist = Math.hypot(cellWx - playerWorld.x, cellWz - playerWorld.z);
        if (dist < bestDist) {
          bestDist = dist;
          bestKey = key;
          bestCol = c;
          bestRow = r;
          bestWx = cellWx;
          bestWz = cellWz;
        }
      }
    }

    if (!bestKey || this.patches.size >= this.maxPatches) return;

    this.inFlight = true;
    const tileKey = bestKey;
    const col = bestCol;
    const row = bestRow;
    const wx = bestWx;
    const wz = bestWz;
    this.inFlightKeys.add(tileKey);

    this.createPatch(tileKey, col, row, wx, wz)
      .catch(err => {
        log.warn('ground patch failed', { key: tileKey, err });
      })
      .finally(() => {
        this.inFlight = false;
        this.inFlightKeys.delete(tileKey);
      });
  }

  private async createPatch(
    key: string, col: number, row: number, cellWx: number, cellWz: number
  ): Promise<void> {
    const centerPix = latLonToWorldPixel(this.center.lat, this.center.lon, this.zoom);
    const patchPixX = centerPix.x + col * 640;
    const patchPixY = centerPix.y + row * 640;
    const { lat, lon } = worldPixelToLatLon(patchPixX, patchPixY, this.zoom);
    const url = satelliteUrl(lat, lon, this.apiKey, this.zoom, 640, 640, 2);

    let buf: ArrayBuffer | null = await tileCache.getBuffer(url);
    if (!buf) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
        if (res.ok) {
          buf = await res.arrayBuffer();
          await tileCache.putBuffer(url, buf, 'image/jpeg');
        }
      } catch (err) {
        log.debug('patch fetch error', err);
        return;
      }
    }

    if (this.disposed || !buf) return;
    if (typeof Image === 'undefined') return;

    let img: HTMLImageElement | null = null;
    try {
      img = await this.decodeBlob(new Blob([buf]));
    } catch {
      return;
    }

    if (this.disposed || !img) return;

    const tex = new Texture(img);
    tex.colorSpace = SRGBColorSpace;
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = this.anisotropy;
    tex.needsUpdate = true;

    const segs = 16;
    const geo = new PlaneGeometry(this.tileSizeUnits, this.tileSizeUnits, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const lz = pos.getZ(i);
      const wx = cellWx + lx;
      const wz = cellWz + lz;
      // Drape onto heightfield cleanly; polygonOffset ensures GroundStreamer sits
      // above base TerrainMesh (offset 3) while 3D tiles (offset 0) cleanly win depth
      pos.setY(i, this.heightfield.sample(wx, wz));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const mat = new MeshStandardMaterial({
      map: tex,
      roughness: 0.94,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2
    });

    const mesh = new Mesh(geo, mat);
    mesh.position.set(cellWx, 0, cellWz);

    this.group.add(mesh);
    this.patches.set(key, {
      key,
      col,
      row,
      mesh,
      centerWx: cellWx,
      centerWz: cellWz
    });
  }

  private decodeBlob(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objUrl = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(objUrl);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        reject(new Error('blob decode failed'));
      };
      img.src = objUrl;
    });
  }
}
