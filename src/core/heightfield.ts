/**
 * Bilinearly-sampled square heightfield shared by physics, terrain rendering,
 * and prop placement. The grid covers the play field [-size/2, size/2]² with
 * `segs+1` samples per side (row-major, index = j * (segs+1) + i).
 */
import { MathUtils } from 'three';

export class Heightfield {
  private readonly data: Float32Array;
  readonly segs: number;
  readonly size: number;

  constructor(size: number, segs: number, data: Float32Array) {
    if (data.length !== (segs + 1) * (segs + 1)) {
      throw new Error(
        `heightfield data length ${data.length} != (segs+1)^2 ${(segs + 1) ** 2}`
      );
    }
    this.segs = segs;
    this.size = size;
    this.data = data;
  }

  /**
   * A heightfield over an n×n grid of cell-centre values (row-major, cells
   * `cellSize` wide): each node takes the mean of the cells that meet at it.
   */
  static fromCells(cells: Float32Array, n: number, cellSize: number): Heightfield {
    const data = new Float32Array((n + 1) * (n + 1));
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        let sum = 0, count = 0;
        for (let dj = -1; dj <= 0; dj++) {
          for (let di = -1; di <= 0; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
            sum += cells[jj * n + ii]!;
            count++;
          }
        }
        data[j * (n + 1) + i] = sum / count;
      }
    }
    return new Heightfield(n * cellSize, n, data);
  }

  /** Take another field's heights in place, so every holder of this one sees them. */
  copyFrom(other: Heightfield): void {
    if (other.segs !== this.segs || other.size !== this.size) {
      throw new Error(`heightfield shape mismatch: ${other.segs}/${other.size} vs ${this.segs}/${this.size}`);
    }
    this.data.set(other.data);
  }

  /** Bilinear height at world (x, z), clamped to the field edges. */
  sample(x: number, z: number): number {
    const seg = this.segs;
    const s = this.size;
    // world [-s/2, s/2] maps to normalized [0, 1] across the grid, matching
    // PlaneGeometry UVs so satellite imagery lines up with elevation data
    const u = x / s + 0.5;
    const v = z / s + 0.5;
    const fx = MathUtils.clamp(u * seg, 0, seg);
    const fz = MathUtils.clamp(v * seg, 0, seg);
    const i0 = Math.floor(fx), j0 = Math.floor(fz);
    const i1 = Math.min(i0 + 1, seg), j1 = Math.min(j0 + 1, seg);
    const tx = fx - i0, tz = fz - j0;
    const h00 = this.h(i0, j0), h10 = this.h(i1, j0);
    const h01 = this.h(i0, j1), h11 = this.h(i1, j1);
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return a + (b - a) * tz;
  }

  private h(i: number, j: number): number {
    const idx = j * (this.segs + 1) + i;
    const v = this.data[idx];
    if (v === undefined) throw new Error(`heightfield index ${idx} out of range`);
    return v;
  }
}
