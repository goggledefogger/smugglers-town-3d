/**
 * How bright the photo ground is under a point, for shading the cars to match.
 *
 * The satellite imagery carries its own sun: a street in a tower's shadow is a
 * dark blue-grey and the next block is bright asphalt. The cars are lit by one
 * scene sun, so a car driving into that photographed shadow stayed at full
 * brightness and floated off the picture. Both imagery sources are on the CPU
 * already (the base canvas and every streamed patch), so each is reduced once
 * to a small luminance grid and cars sample it per frame: a few table lookups,
 * no readback.
 */

const BASE_N = 96;
const PATCH_N = 32;

interface Grid {
  readonly lum: Float32Array;
  readonly n: number;
  readonly minX: number;
  readonly minZ: number;
  readonly size: number;
}

function luminanceGrid(img: CanvasImageSource, n: number): Float32Array | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, n, n);
    const d = ctx.getImageData(0, 0, n, n).data;
    const out = new Float32Array(n * n);
    for (let i = 0; i < out.length; i++) {
      out[i] = (0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!) / 255;
    }
    return out;
  } catch {
    return null;
  }
}

function sample(g: Grid, x: number, z: number): number {
  const u = (x - g.minX) / g.size, v = (z - g.minZ) / g.size;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return -1;
  return g.lum[Math.floor(v * g.n) * g.n + Math.floor(u * g.n)]!;
}

export class GroundShade {
  private base: Grid | null = null;
  private readonly patches = new Map<string, Grid>();
  /** Luminance of open sunlit ground here, from the imagery itself. */
  private lit = 0.5;

  /** The field's satellite canvas, `size` world units square and centred on the origin; null for a place with no imagery. */
  setBase(canvas: HTMLCanvasElement | null, size: number): void {
    this.patches.clear();
    this.base = null;
    if (!canvas) return;
    const lum = luminanceGrid(canvas, BASE_N);
    if (!lum) return;
    this.base = { lum, n: BASE_N, minX: -size / 2, minZ: -size / 2, size };
    // ordinary sunlit asphalt sits a little under the field's median; roofs
    // and concrete are brighter, and they are not what the cars drive on
    const sorted = Float32Array.from(lum).sort();
    this.lit = Math.max(0.2, sorted[Math.floor(sorted.length * 0.45)]!);
  }

  /** A streamed patch: its image, centre and side in world units. Re-adding a cell replaces it. */
  setPatch(img: CanvasImageSource, centerX: number, centerZ: number, size: number): void {
    const lum = luminanceGrid(img, PATCH_N);
    if (!lum) return;
    const key = `${Math.round(centerX)}:${Math.round(centerZ)}`;
    this.patches.set(key, { lum, n: PATCH_N, minX: centerX - size / 2, minZ: centerZ - size / 2, size });
  }

  /**
   * Brightness factor for something standing on the ground at (x, z): 1 in the
   * open, down to 0.45 in the deepest photographed shadow.
   */
  shadeAt(x: number, z: number): number {
    let lum = -1;
    for (const p of this.patches.values()) {
      lum = sample(p, x, z);
      if (lum >= 0) break;
    }
    if (lum < 0 && this.base) lum = sample(this.base, x, z);
    if (lum < 0) return 1;
    return Math.min(1, Math.max(0.45, lum / this.lit));
  }
}
