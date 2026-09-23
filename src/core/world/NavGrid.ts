/**
 * Coarse occupancy grid over the play field with BFS flow fields, so bots
 * route around buildings and props instead of driving straight at a target.
 * A cell is blocked when its center lies within a car's half-width of any
 * collider footprint. A flow field is the BFS distance from a target cell;
 * following it downhill is the route.
 *
 * `Game` builds this at 6 units per cell over the 5600-unit field: ~870k
 * cells, so anything that sweeps the whole grid costs tens of milliseconds.
 * Both full sweeps here are therefore avoided rather than optimised — see
 * `FlowField.reach` and `clearWithin`.
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

  /**
   * Cells the flow fields may still expand before the caller resets it. A
   * field that runs out answers "drive straight" and picks up where it left
   * off next time, so a burst of new targets costs a few frames of straight
   * lines instead of one frozen frame. Unlimited unless the caller meters it
   */
  expandBudget = Infinity;

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

  /**
   * clearance() >= k at cell (i0, j0) without the field: no blocked cell and
   * no world edge within k - 1 cells. A respawn asks this for a few cells
   * near a base; the whole-grid multi-source BFS it replaced measured a 30 ms
   * hitch after every collider rebuild.
   */
  private clearWithin(i0: number, j0: number, k: number): boolean {
    const n = this.n;
    const r = k - 1;
    if (i0 - r < 1 || j0 - r < 1 || i0 + r > n - 2 || j0 + r > n - 2) return false;
    for (let j = j0 - r; j <= j0 + r; j++) {
      const row = j * n;
      for (let i = i0 - r; i <= i0 + r; i++) if (this.blocked[row + i]) return false;
    }
    return true;
  }

  findOpen(x: number, z: number, need: number): Vec2 | null {
    const n = this.n;
    const needCells = Math.ceil(need / this.cell);
    const i0 = this.cellOf(x), j0 = this.cellOf(z);
    if (this.clearWithin(i0, j0, needCells)) return { x, z };
    // ponytail: 100 cells (300 units) is as far as a respawn looks; SpawnPlanner falls back to mostOpen
    for (let r = 1; r < 100; r++) {
      let best = -1;
      let bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = i0 + di, j = j0 + dj;
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          const c = j * n + i;
          if (!this.clearWithin(i, j, needCells)) continue;
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

  /**
   * BFS distance in cells from the target (nearest free cell if it is
   * blocked). The search runs lazily, only as far as the cells that are
   * queried: sweeping all ~870k cells measured 25-60 ms, while a bot a few
   * streets away needs a few thousand of them.
   */
  flowField(tx: number, tz: number): FlowField {
    let start = this.cellOf(tz) * this.n + this.cellOf(tx);
    if (this.blocked[start]) start = this.nearestFree(start);
    return new FlowField(this, this.blocked, start);
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
  private readonly dist: Uint16Array;
  private queue = new Int32Array(1 << 14);
  private head = 0;
  private tail = 0;

  constructor(
    private readonly grid: NavGrid,
    private readonly blocked: Uint8Array,
    start: number
  ) {
    this.dist = new Uint16Array(grid.n * grid.n).fill(UNREACHED);
    if (start >= 0) {
      this.dist[start] = 0;
      this.queue[this.tail++] = start;
    }
  }

  /**
   * Expand the search until `c` has a distance or nothing is left. A cell's
   * distance is final on discovery and every neighbour closer to the target
   * was discovered before it, so a reached cell can be routed from at once.
   */
  private reach(c: number): void {
    const n = this.grid.n;
    const dist = this.dist;
    const blocked = this.blocked;
    const grid = this.grid;
    while (this.head < this.tail && dist[c] === UNREACHED && grid.expandBudget > 0) {
      grid.expandBudget--;
      const cur = this.queue[this.head++]!;
      const d = dist[cur]! + 1;
      const i = cur % n, j = (cur - i) / n;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
          const nc = nj * n + ni;
          if (blocked[nc] || dist[nc] !== UNREACHED) continue;
          // no cutting corners between two blocked orthogonal neighbours
          if (di !== 0 && dj !== 0 && (blocked[j * n + ni] || blocked[nj * n + i])) continue;
          dist[nc] = d;
          if (this.tail === this.queue.length) {
            const bigger = new Int32Array(this.queue.length * 2);
            bigger.set(this.queue);
            this.queue = bigger;
          }
          this.queue[this.tail++] = nc;
        }
      }
    }
  }

  /** Reach `c`, or if it is blocked and can never be reached, its free neighbours. */
  private reachAround(c: number): void {
    this.reach(c);
    if (this.dist[c] !== UNREACHED || !this.blocked[c]) return;
    const n = this.grid.n;
    const i0 = c % n, j0 = (c - i0) / n;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = i0 + di, j = j0 + dj;
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        if (!this.blocked[j * n + i]) this.reach(j * n + i);
      }
    }
  }

  distanceAt(x: number, z: number): number {
    const c = this.grid.cellOf(z) * this.grid.n + this.grid.cellOf(x);
    this.reach(c);
    const d = this.dist[c]!;
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
    this.reachAround(c);
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
