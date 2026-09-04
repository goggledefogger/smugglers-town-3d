import { satelliteUrl } from './MapsApi.ts';
import { tileCache } from '../tiles/TileCache.ts';
import { logger } from '../../app/log.ts';

const log = logger('ground-streamer');

export interface GroundStreamerOptions {
  readonly apiKey: string;
  readonly center: { lat: number; lon: number };
  readonly canvas: HTMLCanvasElement;
  onUpdate?: () => void;
  /** High-resolution zoom level (17 = ~0.5m/px, 18 = ~0.25m/px). Defaults to 18. */
  readonly zoom?: number;
  /** Maximum number of high-res detail tiles to stream (keeps quota & memory bounded). */
  readonly maxTiles?: number;
}

/**
 * Progressively streams high-resolution (zoom 18, ~0.25m/pixel) Google Maps
 * satellite imagery directly onto the terrain's satellite canvas around the
 * player's vehicle, mirroring the dynamic LOD refinement of 3D building tiles.
 */
export class GroundStreamer {
  private readonly apiKey: string;
  private readonly center: { lat: number; lon: number };
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  public onUpdate?: (() => void) | undefined;
  private readonly zoom: number;
  private readonly maxTiles: number;

  private readonly cosLat: number;
  private readonly spanLatDeg: number;
  private readonly spanLonDeg: number;
  private readonly latNorth: number;
  private readonly lonWest: number;

  private readonly dLon: number;
  private readonly dLat: number;

  private readonly fetched = new Set<string>();
  private inFlight = false;
  private lastPickMs = 0;
  private disposed = false;

  constructor(opts: GroundStreamerOptions) {
    this.apiKey = opts.apiKey;
    this.center = opts.center;
    this.canvas = opts.canvas;
    this.ctx = opts.canvas.getContext('2d');
    this.onUpdate = opts.onUpdate;
    this.zoom = opts.zoom ?? 18;
    this.maxTiles = opts.maxTiles ?? 36;

    this.cosLat = Math.max(0.2, Math.cos((this.center.lat * Math.PI) / 180));
    this.spanLatDeg = 0.05;
    this.spanLonDeg = this.spanLatDeg / this.cosLat;
    this.latNorth = this.center.lat + this.spanLatDeg / 2;
    this.lonWest = this.center.lon - this.spanLonDeg / 2;

    // Google Static Maps 640px tile spans in degrees at target zoom:
    // 360 * 640 / (256 * 2^zoom) = 900 / 2^zoom
    this.dLon = 900 / Math.pow(2, this.zoom);
    this.dLat = this.dLon * this.cosLat;
  }

  get tileCount(): number {
    return this.fetched.size;
  }

  dispose(): void {
    this.disposed = true;
    this.fetched.clear();
  }

  /**
   * Called with the vehicle world position (or showroom camera position).
   * Picks the closest un-fetched high-res tile under/near the player and streams it.
   */
  update(playerWorld: { x: number; z: number }, nowMs: number): void {
    if (this.disposed || this.inFlight || this.fetched.size >= this.maxTiles) return;
    if (nowMs - this.lastPickMs < 350) return; // rate limit to at most 1 pick every 350ms
    this.lastPickMs = nowMs;

    // Map world units (-420 to +420) to geographic coordinates
    const u = (playerWorld.x + 420) / 840;
    const v = (playerWorld.z + 420) / 840;
    const pLon = this.lonWest + u * this.spanLonDeg;
    const pLat = this.latNorth - v * this.spanLatDeg;

    // Determine the cell coordinates
    const centerCol = Math.floor((pLon - this.lonWest) / this.dLon);
    const centerRow = Math.floor((this.latNorth - pLat) / this.dLat);

    // Search in a 3x3 ring of neighbors around the player's current cell
    let bestKey: string | null = null;
    let bestDist = Infinity;
    let bestCol = 0, bestRow = 0;

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const c = centerCol + dc;
        const r = centerRow + dr;
        const key = `${this.zoom}:${c}:${r}`;
        if (this.fetched.has(key)) continue;

        // Check if cell is within the terrain bounds
        const cellLon = this.lonWest + (c + 0.5) * this.dLon;
        const cellLat = this.latNorth - (r + 0.5) * this.dLat;
        if (cellLon < this.lonWest || cellLon > this.lonWest + this.spanLonDeg) continue;
        if (cellLat > this.latNorth || cellLat < this.latNorth - this.spanLatDeg) continue;

        const dist = Math.hypot(dc, dr);
        if (dist < bestDist) {
          bestDist = dist;
          bestKey = key;
          bestCol = c;
          bestRow = r;
        }
      }
    }

    if (!bestKey) return;

    this.inFlight = true;
    const tileKey = bestKey;
    const col = bestCol;
    const row = bestRow;

    const cellLon = this.lonWest + (col + 0.5) * this.dLon;
    const cellLat = this.latNorth - (row + 0.5) * this.dLat;

    this.fetchTile(cellLat, cellLon, col, row)
      .then(() => {
        this.fetched.add(tileKey);
      })
      .catch(err => {
        log.warn('ground tile stream failed', { key: tileKey, err });
        // Mark as fetched on failure so we don't spam repeat failed attempts
        this.fetched.add(tileKey);
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  private async fetchTile(lat: number, lon: number, col: number, row: number): Promise<void> {
    const url = satelliteUrl(lat, lon, this.apiKey, this.zoom, 640, 640, 2);

    let img: HTMLImageElement | null = null;
    const cachedBuf = await tileCache.getBuffer(url);

    if (cachedBuf) {
      img = await this.decodeBlob(new Blob([cachedBuf]));
    } else {
      if (typeof Image === 'undefined') return;

      img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        const timer = setTimeout(() => {
          image.src = '';
          reject(new Error('ground tile fetch timeout'));
        }, 8000);
        image.onload = () => {
          clearTimeout(timer);
          resolve(image);
        };
        image.onerror = () => {
          clearTimeout(timer);
          reject(new Error('ground tile image error'));
        };
        image.src = url;
      });

      // Cache asynchronously in tileCache
      fetch(url)
        .then(r => r.ok ? r.arrayBuffer() : null)
        .then(buf => { if (buf) void tileCache.putBuffer(url, buf, 'image/jpeg'); })
        .catch(() => {});
    }

    if (this.disposed || !this.ctx || !img) return;

    // Compute pixel destination on the canvas
    const W = this.canvas.width;
    const H = this.canvas.height;
    const px0 = (col * this.dLon / this.spanLonDeg) * W;
    const py0 = (row * this.dLat / this.spanLatDeg) * H;
    const pw = (this.dLon / this.spanLonDeg) * W;
    const ph = (this.dLat / this.spanLatDeg) * H;

    // Draw high-res tile into canvas with a slight 0.5px margin to prevent seams
    this.ctx.drawImage(img, px0, py0, pw + 0.5, ph + 0.5);

    // Notify TerrainMesh that canvas contents changed
    this.onUpdate?.();
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
