/**
 * Coarse occupancy grid over the play field with BFS flow fields, so bots
 * route around buildings and props instead of driving straight at a target.
 * Cells are 3 units (20 m); a cell is blocked when its center lies within a
 * car's half-width of any collider footprint. A flow field is the BFS
 * distance from a target cell; following it downhill is the route.
 */
import { Vector3 } from 'three';
import type { BuildingCollider } from '../physics/VehicleBody.ts';
import type { OpenSpace, Vec2 } from './OpenSpace.ts';

/** Half a car width: keeps routes from hugging walls without closing 20 m streets. */
const MARGIN = 1.0;
const UNREACHED = 0xffff;

export class NavGrid implements OpenSpace {
  readonly n: number;
  private readonly half: number;
  private readonly blocked: Uint8Array;
  private blockedCount = 0;
  private clearanceCells: Uint16Array | null = null;

  constructor(size: number, readonly cell = 3) {
    this.n = Math.ceil(size / cell);
    this.half = size / 2;
    this.blocked = new Uint8Array(this.n * this.n);
  }

  /** True when nothing is blocked: routing would only return straight lines. */
  get isEmpty(): boolean {
    return this.blockedCount === 0;
  }

  cellOf(v: number): number {
    return Math.min(this.n - 1, Math.max(0, Math.floor((v + this.half) / this.cell)));
  }

  centerOf(i: number): number {
    return -this.half + (i + 0.5) * this.cell;
  }

  isBlocked(c: number): boolean {
    return this.blocked[c] === 1;
  }

  isBlockedAt(x: number, z: number): boolean {
    return this.isBlocked(this.cellOf(z) * this.n + this.cellOf(x));
  }

  rebuild(colliders: readonly BuildingCollider[]): void {
    this.blocked.fill(0);
    this.blockedCount = 0;
    this.clearanceCells = null;
    for (const c of colliders) {
      const x0 = c.min.x - MARGIN, x1 = c.max.x + MARGIN;
      const z0 = c.min.z - MARGIN, z1 = c.max.z + MARGIN;
      for (let j = this.cellOf(z0); j <= this.cellOf(z1); j++) {
        const cz = this.centerOf(j);
        if (cz < z0 || cz > z1) continue;
        for (let i = this.cellOf(x0); i <= this.cellOf(x1); i++) {
          const cx = this.centerOf(i);
          if (cx < x0 || cx > x1) continue;
          const k = j * this.n + i;
          if (!this.blocked[k]) {
            this.blocked[k] = 1;
            this.blockedCount++;
          }
        }
      }
    }
  }

  // --- OpenSpace ---

  /**
   * Chebyshev distance in cells from every cell to the nearest blocked cell,
   * treating the world edge as blocked. One multi-source BFS, cached until
   * the next rebuild; every spawn and placement query reads it.
   */
  private clearance(): Uint16Array {
    if (this.clearanceCells) return this.clearanceCells;
    const n = this.n;
    const dist = new Uint16Array(n * n).fill(0xffff);
    const queue = new Int32Array(n * n);
    let head = 0, tail = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i;
        if (this.blocked[c] === 1 || i === 0 || j === 0 || i === n - 1 || j === n - 1) {
          dist[c] = 0;
          queue[tail++] = c;
        }
      }
    }
    while (head < tail) {
      const c = queue[head++]!;
      const d = dist[c]! + 1;
      const i = c % n, j = (c - i) / n;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
          const nc = nj * n + ni;
          if (dist[nc]! <= d) continue;
          dist[nc] = d;
          queue[tail++] = nc;
        }
      }
    }
    this.clearanceCells = dist;
    return dist;
  }

  clearanceAt(x: number, z: number): number {
    const c = this.cellOf(z) * this.n + this.cellOf(x);
    return this.clearance()[c]! * this.cell;
  }

  findOpen(x: number, z: number, need: number): Vec2 | null {
    const dist = this.clearance();
    const n = this.n;
    const needCells = Math.ceil(need / this.cell);
    const i0 = this.cellOf(x), j0 = this.cellOf(z);
    if (dist[j0 * n + i0]! >= needCells) return { x, z };
    for (let r = 1; r < n; r++) {
      let best = -1;
      let bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = i0 + di, j = j0 + dj;
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          const c = j * n + i;
          if (dist[c]! < needCells) continue;
          const d = di * di + dj * dj;
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }
      if (best >= 0) return this.pointAt(best);
    }
    return null;
  }

  mostOpen(x: number, z: number, need: number): Vec2 | null {
    const dist = this.clearance();
    const n = this.n;
    let max = 0;
    for (let c = 0; c < n * n; c++) if (dist[c]! !== 0xffff && dist[c]! > max) max = dist[c]!;
    if (max === 0) return null;
    // take `need` when the world offers it, otherwise the roomiest there is
    const target = Math.min(max, Math.ceil(need / this.cell));
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i;
        if (dist[c]! < target) continue;
        const dx = this.centerOf(i) - x, dz = this.centerOf(j) - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
    return best < 0 ? null : this.pointAt(best);
  }

  private pointAt(c: number): Vec2 {
    const i = c % this.n;
    return { x: this.centerOf(i), z: this.centerOf((c - i) / this.n) };
  }

  /** BFS distance in cells from the target (nearest free cell if it is blocked). */
  flowField(tx: number, tz: number): FlowField {
    const n = this.n;
    const dist = new Uint16Array(n * n).fill(UNREACHED);
    let start = this.cellOf(tz) * n + this.cellOf(tx);
    if (this.blocked[start]) start = this.nearestFree(start);
    if (start < 0) return new FlowField(this, dist);
    const queue = new Int32Array(n * n);
    let head = 0, tail = 0;
    dist[start] = 0;
    queue[tail++] = start;
    while (head < tail) {
      const c = queue[head++]!;
      const d = dist[c]! + 1;
      const i = c % n, j = (c - i) / n;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
          const nc = nj * n + ni;
          if (this.blocked[nc] || dist[nc] !== UNREACHED) continue;
          // no cutting corners between two blocked orthogonal neighbours
          if (di !== 0 && dj !== 0 && (this.blocked[j * n + ni] || this.blocked[nj * n + i])) continue;
          dist[nc] = d;
          queue[tail++] = nc;
        }
      }
    }
    return new FlowField(this, dist);
  }

  private nearestFree(c: number): number {
    const n = this.n;
    const i0 = c % n, j0 = (c - i0) / n;
    for (let r = 1; r <= 4; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = i0 + di, j = j0 + dj;
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          if (!this.blocked[j * n + i]) return j * n + i;
        }
      }
    }
    return -1;
  }
}

export class FlowField {
  constructor(
    private readonly grid: NavGrid,
    private readonly dist: Uint16Array
  ) {}

  distanceAt(x: number, z: number): number {
    const d = this.dist[this.grid.cellOf(z) * this.grid.n + this.grid.cellOf(x)]!;
    return d === UNREACHED ? Infinity : d;
  }

  /**
   * Point to steer toward from (x, z): the cell `lookahead` steps down the
   * field. Null means drive straight — already next to the target, or the
   * field can't help (unreachable).
   */
  waypoint(x: number, z: number, lookahead: number, out: Vector3): Vector3 | null {
    const n = this.grid.n;
    let c = this.grid.cellOf(z) * n + this.grid.cellOf(x);
    if (this.dist[c] === UNREACHED) {
      c = this.bestNeighbour(c);
      if (c < 0) return null;
    }
    if (this.dist[c]! <= 1) return null;
    for (let k = 0; k < lookahead; k++) {
      const nc = this.bestNeighbour(c);
      if (nc < 0) break;
      c = nc;
      if (this.dist[c] === 0) break;
    }
    const i = c % n, j = (c - i) / n;
    return out.set(this.grid.centerOf(i), 0, this.grid.centerOf(j));
  }

  /** Neighbour with the lowest distance below this cell's own; -1 if none improves. */
  private bestNeighbour(c: number): number {
    const n = this.grid.n;
    const i0 = c % n, j0 = (c - i0) / n;
    let best = -1;
    let bestD = this.dist[c]!;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const i = i0 + di, j = j0 + dj;
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const nc = j * n + i;
        if (di !== 0 && dj !== 0 && (this.grid.isBlocked(j0 * n + i) || this.grid.isBlocked(j * n + i0))) continue;
        const d = this.dist[nc]!;
        if (d < bestD) {
          bestD = d;
          best = nc;
        }
      }
    }
    return best;
  }
}
