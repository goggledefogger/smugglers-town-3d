/**
 * Painted 3D and Footprint 3D: photographs of the Google 3D Tiles baked onto
 * building walls. For every wall (a box face in Painted 3D, a footprint
 * edge in Footprint 3D), a flat (orthographic) camera in the street looks
 * straight at the wall and renders the tiles into that wall's rectangle of
 * one big atlas texture; the wall then wears the photo. Only satellite
 * ground and painted walls are ever drawn in the modes, so nothing can
 * float and no road is ever covered: whatever a wall shows is whatever
 * stood in front of it, taken once, never re-projected.
 *
 * The camera looks from `out` metres in front of the wall to a few metres
 * behind it. `out` is half the gap to the nearest wall across the street
 * (capped), so a narrow street's far side cannot leak into the near wall's
 * photo; the inside reach exists because a box is the cell-quantized hull
 * and the real wall can stand several metres inside its face.
 *
 * Walls are baked nearest the car first, a time budget per frame, and a
 * wall that survives a rebuild in the same place keeps its photo.
 */
import {
  OrthographicCamera, WebGLRenderTarget, Vector3, Color, LinearFilter, RGBAFormat, UnsignedByteType,
  type WebGLRenderer, type Scene, type Object3D, type Texture
} from 'three';
import type { BuildingCollider } from '../core/physics/VehicleBody.ts';

/** Wall faces in the order the box shader's rect attributes use. */
type WallFace = 0 | 1 | 2 | 3; // -x, +x, -z, +z
export const ATLAS_SIZE = 4096;
/** Furthest the wall camera stands into the street (m): half a wide avenue. */
const MAX_OUT_M = 25;
/** How far behind a box face the camera still sees (m): a wall inside its cell-quantized box. */
const IN_M = 12;
/** A footprint wall is metre-exact: the camera need not see far behind it. */
const IN_EXACT_M = 3;
/** Longest side of one wall's rectangle in texels. */
const MAX_FACE_PX = 768;
/** Shelf rows are this granular in texels; keeps packing simple. */
const ROW_STEP = 16;
/** Atlas fill target when choosing the texel size (m per texel) from the total wall area; shelf packing wastes the rest. */
const FILL_TARGET = 0.5;
/** Texel size bounds (m). */
const TEXEL_MIN = 0.35, TEXEL_MAX = 2.0;
/** After everything is painted, the nearest walls are refreshed this often (ms) to pick up refined tiles. */
const REFRESH_MS = 4000;
/**
 * Walls baked per frame at most. The CPU budget cannot see the GPU: each
 * bake draws every loaded tile once more, and a downtown frame that queued
 * six of them read 50 ms even though the CPU side sat under 4
 */
const MAX_WALLS_PER_FRAME = 2;

interface AtlasRect { x: number; y: number; w: number; h: number }

/** A vertical wall segment in world space with its outward normal. */
export interface Wall {
  readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number;
  readonly nx: number; readonly nz: number;
  readonly y0: number; readonly y1: number;
}

interface WallJob {
  readonly kind: 'box' | 'wall';
  /** box index (kind box) or wall index (kind wall) */
  readonly owner: number;
  readonly face: WallFace;
  /** what the wall is, so a rebuild in the same place keeps the photo */
  readonly key: string;
  /** wall centre, size and outward normal in world units */
  readonly cx: number; readonly cy: number; readonly cz: number;
  readonly nx: number; readonly nz: number;
  readonly width: number; readonly height: number;
  /** how far into the street the camera stands; 0 means an internal wall, never baked */
  readonly out: number;
  /** how far behind the wall the camera sees */
  readonly inM: number;
  /** where the photo starts, as a fraction of the wall height: the part below is hidden by a flush neighbour */
  readonly pv0: number;
  rect: AtlasRect | null;
  done: boolean;
  bakedAt: number;
}

const FACE_NORMAL: readonly [number, number, number][] = [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]];

/**
 * Key a wall plane across collider rebuilds so its photo survives: the face's
 * plane, its span and its top. Not the box's bottom: the ground under a box
 * moves as the heightfield refines, and a key on it lost every photo in the
 * field each time. The photo's own bottom rounds to 2 m so a small ground
 * shift keeps the rect (stretched by at most that much).
 */
export function faceKey(b: BuildingCollider, face: WallFace, bottom: number): string {
  const plane = face === 0 ? b.min.x : face === 1 ? b.max.x : face === 2 ? b.min.z : b.max.z;
  const s0 = face < 2 ? b.min.z : b.min.x, s1 = face < 2 ? b.max.z : b.max.x;
  return `${face}:${plane.toFixed(1)}:${s0.toFixed(1)}-${s1.toFixed(1)}:${b.max.y.toFixed(1)}:${Math.round(bottom / 2) * 2}`;
}

export function wallKey(w: Wall): string {
  return `${w.ax.toFixed(1)},${w.az.toFixed(1)},${w.bx.toFixed(1)},${w.bz.toFixed(1)},${w.y0.toFixed(1)},${w.y1.toFixed(1)}`;
}

/** A neighbour must cover this much of a face's width to count as the box across from it. */
const BLOCK_COVER = 0.6;

/** Where a face's photo starts (world y) and how far its camera stands out; out 0 = nothing exposed. */
interface FaceReach { out: number; bottom: number }

/**
 * How far a wall face may look into the street before it would see the box
 * on the other side, and from what height the face is exposed at all.
 * Buildings come out of the collider pass as stacks of 10 m strips of
 * different heights, so a face another strip is flush against is internal
 * only up to that strip's roof; above it the face is open air and wants a
 * photo like any other. Out is half the gap to the nearest box that covers
 * most of the face's width and reaches above that line, capped. A box
 * covering only a sliver of the face (a stray one-cell column, a narrower
 * strip) does not count: it would have declared a whole 60 m wall internal,
 * and it simply shows up in the photo as foreground.
 */
export function faceReach(boxes: readonly BuildingCollider[], i: number, face: WallFace, candidates?: readonly number[]): FaceReach {
  const a = boxes[i]!;
  const along = face < 2 ? a.max.z - a.min.z : a.max.x - a.min.x;
  const coverAndGap = (b: BuildingCollider): [number, number] => {
    if (face === 0 || face === 1) {
      return [Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z), face === 0 ? a.min.x - b.max.x : b.min.x - a.max.x];
    }
    return [Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x), face === 2 ? a.min.z - b.max.z : b.min.z - a.max.z];
  };
  const ks = candidates ?? boxes.map((_, k) => k);
  // flush neighbours hide the face up to the tallest of their roofs
  let bottom = a.min.y;
  for (const k of ks) {
    if (k === i) continue;
    const b = boxes[k]!;
    if (b.max.y < a.min.y + 1) continue;
    const [cover, g] = coverAndGap(b);
    if (cover < BLOCK_COVER * along || g < -0.01 || g >= 0.5) continue;
    bottom = Math.max(bottom, Math.min(b.max.y, a.max.y));
  }
  if (bottom >= a.max.y - 2) return { out: 0, bottom: a.max.y };
  let gap = Infinity;
  for (const k of ks) {
    if (k === i) continue;
    const b = boxes[k]!;
    if (b.max.y < bottom + 1) continue;
    const [cover, g] = coverAndGap(b);
    if (cover < BLOCK_COVER * along) continue;
    if (g >= 0.5 && g < gap) gap = g;
  }
  return { out: Math.min(MAX_OUT_M, Math.max(2, gap / 2)), bottom };
}

/**
 * Boxes bucketed on a coarse grid, so a face only tests the boxes that could
 * be flush against it or across the street from it. Every face against every
 * box was 120 M tests a rebuild downtown, 150 ms on the frame each tile load.
 */
export class BoxIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly cell: number;
  constructor(private readonly boxes: readonly BuildingCollider[], cell = 50) {
    this.cell = cell;
    boxes.forEach((b, k) => {
      for (let j = Math.floor(b.min.z / cell); j <= Math.floor(b.max.z / cell); j++) {
        for (let i = Math.floor(b.min.x / cell); i <= Math.floor(b.max.x / cell); i++) {
          const key = i * 100003 + j;
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, list = []);
          list.push(k);
        }
      }
    });
  }

  /** Indices of every box within `pad` metres of box `i`'s bounds (itself included, duplicates removed). */
  near(i: number, pad: number): number[] {
    const a = this.boxes[i]!;
    const cell = this.cell;
    const seen = new Set<number>();
    for (let j = Math.floor((a.min.z - pad) / cell); j <= Math.floor((a.max.z + pad) / cell); j++) {
      for (let x = Math.floor((a.min.x - pad) / cell); x <= Math.floor((a.max.x + pad) / cell); x++) {
        const list = this.cells.get(x * 100003 + j);
        if (list) for (const k of list) seen.add(k);
      }
    }
    return [...seen];
  }
}

/** Spatial hash cell for wallReaches (m). */
const HASH_CELL = 40;

/**
 * How far each footprint wall may look into the street: half the distance
 * from its midpoint, along its normal, to the first other wall that rises
 * above its base (capped); 0 when that wall is flush against it, which is
 * what two OpenStreetMap buildings sharing a party wall look like. Walls
 * hash into 40 m cells so a downtown of 50k walls stays a few million
 * segment tests.
 */
export function wallReaches(walls: readonly Wall[]): Float32Array {
  const out = new Float32Array(walls.length);
  const cells = new Map<string, number[]>();
  const cellOf = (v: number) => Math.floor(v / HASH_CELL);
  walls.forEach((w, k) => {
    const i0 = cellOf(Math.min(w.ax, w.bx)), i1 = cellOf(Math.max(w.ax, w.bx));
    const j0 = cellOf(Math.min(w.az, w.bz)), j1 = cellOf(Math.max(w.az, w.bz));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const kk = `${i},${j}`;
      let list = cells.get(kk);
      if (!list) cells.set(kk, list = []);
      list.push(k);
    }
  });
  const reach = 2 * MAX_OUT_M;
  const seen = new Set<number>();
  walls.forEach((w, k) => {
    // the ray starts a quarter metre behind the wall so a party wall on the same line still counts as a hit
    const px = (w.ax + w.bx) / 2 - w.nx * 0.25, pz = (w.az + w.bz) / 2 - w.nz * 0.25;
    const qx = px + w.nx * reach, qz = pz + w.nz * reach;
    const i0 = cellOf(Math.min(px, qx)), i1 = cellOf(Math.max(px, qx));
    const j0 = cellOf(Math.min(pz, qz)), j1 = cellOf(Math.max(pz, qz));
    let best = Infinity;
    seen.clear();
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const list = cells.get(`${i},${j}`);
      if (!list) continue;
      for (const m of list) {
        if (m === k || seen.has(m)) continue;
        seen.add(m);
        const o = walls[m]!;
        if (o.y1 < w.y0 + 1 || o.y0 > w.y1 - 1) continue;
        // a wall facing the same way on the same line is a duplicate (a building part
        // tracing its building's outline), not something standing in front of us
        if (o.nx * w.nx + o.nz * w.nz > 0.9) continue;
        const dx = o.bx - o.ax, dz = o.bz - o.az;
        const den = w.nx * dz - w.nz * dx;
        if (Math.abs(den) < 1e-6) continue;
        const ex = o.ax - px, ez = o.az - pz;
        const t = (ex * dz - ez * dx) / den;
        const s = (ex * w.nz - ez * w.nx) / den;
        if (t > 0.01 && s >= 0 && s <= 1 && t < best) best = t;
      }
    }
    const gap = best - 0.25;
    out[k] = gap < 0.5 ? 0 : Math.min(MAX_OUT_M, Math.max(2, gap / 2));
  });
  return out;
}

/**
 * Shelf packer: rows, faces placed left to right, never frees. A face takes
 * the shortest existing row it fits with room to spare; a new row opens only
 * when no row fits or the best fit would waste over half the row's height.
 */
export class ShelfPacker {
  private readonly shelves: { y: number; h: number; x: number }[] = [];
  private nextY = 0;
  constructor(readonly size: number) {}

  alloc(w: number, h: number): AtlasRect | null {
    const rh = Math.ceil(h / ROW_STEP) * ROW_STEP;
    let best: { y: number; h: number; x: number } | null = null;
    for (const s of this.shelves) {
      if (s.h >= rh && s.x + w <= this.size && (!best || s.h < best.h)) best = s;
    }
    if (best && (best.h - rh <= rh / 2 || this.nextY + rh > this.size)) {
      const r = { x: best.x, y: best.y, w, h };
      best.x += w;
      return r;
    }
    if (this.nextY + rh > this.size) return null;
    const s = { y: this.nextY, h: rh, x: w };
    this.shelves.push(s);
    this.nextY += rh;
    return { x: 0, y: s.y, w, h };
  }

  get used(): number {
    return this.nextY / this.size;
  }
}

interface BakerHooks {
  /** the tiles root; hidden in the mode, made visible for each bake */
  readonly tiles: () => Object3D | null;
  /** turn the clutter filter and snap off for the photo, and back after */
  readonly before: () => void;
  readonly after: () => void;
  /** a box face's photo landed: hand the box mesh its atlas rect (texels) and where on the face it starts */
  readonly onRect: (box: number, face: WallFace, rect: AtlasRect, pv0: number) => void;
  /** a footprint wall's photo landed: the same for the prism mesh */
  readonly onWallRect: (wall: number, rect: AtlasRect, pv0: number) => void;
}

export class FacadeBaker {
  readonly atlas: WebGLRenderTarget;
  private jobs: WallJob[] = [];
  private packer = new ShelfPacker(ATLAS_SIZE);
  private texel = 1;
  private readonly cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  private readonly _c = new Vector3();
  private readonly _clear = new Color();
  private _clearAlpha = 1;
  private order: number[] = [];
  private orderFor = new Vector3(Infinity, Infinity, Infinity);
  private refreshCursor = 0;
  private full = false;
  /** a new layout: the whole atlas is cleared before the first bake into it */
  private needsClear = true;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly hooks: BakerHooks
  ) {
    this.atlas = new WebGLRenderTarget(ATLAS_SIZE, ATLAS_SIZE, {
      minFilter: LinearFilter, magFilter: LinearFilter, format: RGBAFormat, type: UnsignedByteType,
      depthBuffer: true, generateMipmaps: false
    });
    this.cam.layers.set(1);
    this.cam.up.set(0, 1, 0);
  }

  get texture(): Texture {
    return this.atlas.texture;
  }

  /** Walls painted so far, for the diag line. */
  get progress(): { done: number; total: number; texel: number; atlasUsed: number } {
    let done = 0, total = 0;
    for (const j of this.jobs) { if (j.out > 0) { total++; if (j.done) done++; } }
    return { done, total, texel: this.texel, atlasUsed: this.packer.used };
  }

  /**
   * Swap the job list for a new one: photos of walls with the same key
   * survive, and the texel size follows the total wall area (so a whole
   * downtown fits the atlas). The layout is only thrown away, photos and all,
   * when the area changed by a quarter (a relocation, not a tile load): the
   * old rule wiped the atlas on every collider rebuild while driving, and a
   * full atlas restarting coarser wiped it again a few seconds later. A full
   * atlas now just stops taking new walls; the nearest were packed first.
   */
  private relayout(area: number, build: (kept: Map<string, WallJob>) => WallJob[]): void {
    const kept = new Map<string, WallJob>();
    for (const j of this.jobs) if (j.done && j.rect) kept.set(j.key, j);
    const texel = Math.min(TEXEL_MAX, Math.max(TEXEL_MIN, Math.sqrt(area / (ATLAS_SIZE * ATLAS_SIZE * FILL_TARGET))));
    if (this.jobs.length === 0 || Math.abs(texel - this.texel) > this.texel * 0.25) {
      this.texel = texel;
      this.packer = new ShelfPacker(ATLAS_SIZE);
      this.full = false;
      this.needsClear = true;
      kept.clear();
    }
    this.jobs = build(kept);
    for (const j of this.jobs) if (j.done) this.landed(j);
    this.orderFor.set(Infinity, Infinity, Infinity);
  }

  /** Painted 3D: the colliders were rebuilt; keep photos of boxes that did not change, queue the rest. */
  setColliders(boxes: readonly BuildingCollider[]): void {
    // texel size from the area that will actually be photographed: internal faces never are
    const reaches: FaceReach[] = [];
    let area = 0;
    const index = new BoxIndex(boxes);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      // a box across a gap wider than twice the cap changes nothing: out is capped there
      const near = index.near(i, MAX_OUT_M * 2 + 1);
      for (let f = 0; f < 4; f++) {
        const reach = faceReach(boxes, i, f as WallFace, near);
        reaches.push(reach);
        if (reach.out > 0) area += (f < 2 ? b.max.z - b.min.z : b.max.x - b.min.x) * Math.max(0, b.max.y - reach.bottom);
      }
    }
    this.relayout(area, kept => {
      const jobs: WallJob[] = [];
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!;
        for (let f = 0; f < 4; f++) {
          const face = f as WallFace;
          const along = face < 2 ? b.max.z - b.min.z : b.max.x - b.min.x;
          const reach = reaches[i * 4 + f]!;
          const n = FACE_NORMAL[face]!;
          const key = faceKey(b, face, reach.bottom);
          const prev = kept.get(key);
          jobs.push({
            kind: 'box', owner: i, face, key,
            cx: face === 0 ? b.min.x : face === 1 ? b.max.x : (b.min.x + b.max.x) / 2,
            cy: (reach.bottom + b.max.y) / 2,
            cz: face === 2 ? b.min.z : face === 3 ? b.max.z : (b.min.z + b.max.z) / 2,
            nx: n[0], nz: n[2], width: along, height: b.max.y - reach.bottom,
            out: reach.out, inM: IN_M, pv0: (reach.bottom - b.min.y) / Math.max(0.1, b.max.y - b.min.y),
            rect: prev?.rect ?? null, done: !!prev, bakedAt: prev?.bakedAt ?? 0
          });
        }
      }
      return jobs;
    });
  }

  /** Footprint 3D: the prism walls were rebuilt; keep photos of walls that did not move. */
  setWalls(walls: readonly Wall[]): void {
    const reach = wallReaches(walls);
    let area = 0;
    walls.forEach((w, i) => { if (reach[i]! > 0) area += Math.hypot(w.bx - w.ax, w.bz - w.az) * Math.max(0, w.y1 - w.y0); });
    this.relayout(area, kept => walls.map((w, i) => {
      const key = wallKey(w);
      const prev = kept.get(key);
      return {
        kind: 'wall', owner: i, face: 0, key,
        cx: (w.ax + w.bx) / 2, cy: (w.y0 + w.y1) / 2, cz: (w.az + w.bz) / 2,
        nx: w.nx, nz: w.nz, width: Math.hypot(w.bx - w.ax, w.bz - w.az), height: w.y1 - w.y0,
        out: reach[i]!, inM: IN_EXACT_M, pv0: 0,
        rect: prev?.rect ?? null, done: !!prev, bakedAt: prev?.bakedAt ?? 0
      };
    }));
  }

  /** The box mesh was rebuilt (a ground refinement): hand every painted face its rectangle again. */
  replay(): void {
    for (const j of this.jobs) if (j.done) this.landed(j);
  }

  private reorder(camPos: Vector3): void {
    if (camPos.distanceTo(this.orderFor) < 40) return;
    this.orderFor.copy(camPos);
    const d = (j: WallJob) => (j.cx - camPos.x) * (j.cx - camPos.x) + (j.cz - camPos.z) * (j.cz - camPos.z);
    this.order = this.jobs.map((_, i) => i).filter(i => this.jobs[i]!.out > 0).sort((a, b) => d(this.jobs[a]!) - d(this.jobs[b]!));
    this.refreshCursor = 0;
  }

  private landed(j: WallJob): void {
    if (!j.rect) return;
    if (j.kind === 'box') this.hooks.onRect(j.owner, j.face, j.rect, j.pv0);
    else this.hooks.onWallRect(j.owner, j.rect, j.pv0);
  }

  /** Bake pending walls nearest the camera first, within `budgetMs` of wall clock. */
  update(camPos: Vector3, nowMs: number, budgetMs = 4, maxWalls = MAX_WALLS_PER_FRAME): void {
    if (this.jobs.length === 0) return;
    this.reorder(camPos);
    const t0 = performance.now();
    let began = false;
    let baked = 0;
    const begin = () => {
      if (began) return;
      began = true;
      this.renderer.getClearColor(this._clear);
      this._clearAlpha = this.renderer.getClearAlpha();
      this.hooks.before();
      if (this.needsClear) {
        this.needsClear = false;
        this.atlas.scissorTest = false;
        this.renderer.setRenderTarget(this.atlas);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.clear(true, true, false);
      }
    };
    for (const i of this.order) {
      if (performance.now() - t0 > budgetMs || baked >= maxWalls) break;
      const j = this.jobs[i]!;
      if (j.done) continue;
      if (!j.rect) {
        if (this.full) continue;
        const w = Math.min(MAX_FACE_PX, Math.max(4, Math.ceil(j.width / this.texel)));
        const h = Math.min(MAX_FACE_PX, Math.max(4, Math.ceil(j.height / this.texel)));
        j.rect = this.packer.alloc(w, h);
        if (!j.rect) { this.full = true; continue; }
      }
      begin();
      this.bake(j);
      baked++;
      j.done = true;
      j.bakedAt = nowMs;
      this.landed(j);
    }
    // everything painted: refresh the nearest walls slowly so tiles that refined since show up
    if (!began && this.order.length > 0) {
      const n = Math.min(maxWalls, this.order.length);
      for (let k = 0; k < n && performance.now() - t0 < budgetMs; k++) {
        const j = this.jobs[this.order[this.refreshCursor % Math.min(this.order.length, 200)]!]!;
        this.refreshCursor++;
        if (!j.rect || nowMs - j.bakedAt < REFRESH_MS) continue;
        begin();
        this.bake(j);
        j.bakedAt = nowMs;
      }
    }
    if (began) {
      this.renderer.setRenderTarget(null);
      this.renderer.setClearColor(this._clear, this._clearAlpha);
      this.hooks.after();
    }
  }

  private bake(j: WallJob): void {
    const r = j.rect!;
    const tiles = this.hooks.tiles();
    const wasVisible = tiles?.visible ?? false;
    if (tiles) tiles.visible = true;
    const bg = this.scene.background;
    this.scene.background = null;
    this.cam.left = -j.width / 2; this.cam.right = j.width / 2;
    this.cam.top = j.height / 2; this.cam.bottom = -j.height / 2;
    this.cam.near = 0.1; this.cam.far = j.out + j.inM;
    this.cam.updateProjectionMatrix();
    this.cam.position.set(j.cx + j.nx * j.out, j.cy, j.cz + j.nz * j.out);
    this.cam.lookAt(this._c.set(j.cx, j.cy, j.cz));
    this.cam.updateMatrixWorld();
    // the target's own viewport and scissor, applied by setRenderTarget: renderer.setViewport
    // would move the canvas viewport and leave the main view drawing into one small rectangle
    this.atlas.viewport.set(r.x, r.y, r.w, r.h);
    this.atlas.scissor.set(r.x, r.y, r.w, r.h);
    this.atlas.scissorTest = true;
    this.renderer.setRenderTarget(this.atlas);
    this.renderer.setClearColor(0x000000, 0);
    // a refresh keeps the old photo under the new one: a tile evicted or mid-refinement
    // would otherwise blank the wall for a few seconds and it flickered between photo and fill
    this.renderer.clear(!j.done, true, false);
    this.renderer.render(this.scene, this.cam);
    this.scene.background = bg;
    if (tiles) tiles.visible = wasVisible;
  }

  dispose(): void {
    this.atlas.dispose();
    this.jobs = [];
  }
}
