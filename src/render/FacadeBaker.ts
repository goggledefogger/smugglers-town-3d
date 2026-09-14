/**
 * Painted 3D: photographs of the Google 3D Tiles baked onto the collision
 * boxes. For every wall face of every box, a flat (orthographic) camera in
 * the street looks straight at the face and renders the tiles into that
 * face's rectangle of one big atlas texture; the box then wears the photo.
 * Only satellite ground and painted boxes are ever drawn in the mode, so
 * nothing can float and no road is ever covered: whatever a wall shows is
 * whatever stood in front of it, taken once, never re-projected.
 *
 * The camera looks from `out` metres in front of the face to `IN_M` behind
 * it. `out` is half the gap to the nearest box across the street (capped),
 * so a narrow street's far side cannot leak into the near wall's photo; the
 * inside reach exists because the box is the cell-quantized hull and the real
 * wall can stand several metres inside its face.
 *
 * Faces are baked nearest the car first, a time budget per frame, and a box
 * that survives a collider rebuild with the same bounds keeps its photos.
 */
import {
  OrthographicCamera, WebGLRenderTarget, Vector3, Color, LinearFilter, RGBAFormat, UnsignedByteType,
  type WebGLRenderer, type Scene, type Object3D, type Texture
} from 'three';
import type { BuildingCollider } from '../core/physics/VehicleBody.ts';

/** Wall faces in the order the box shader's rect attributes use. */
export type WallFace = 0 | 1 | 2 | 3; // -x, +x, -z, +z
export const ATLAS_SIZE = 4096;
/** Furthest the face camera stands into the street (m): half a wide avenue. */
const MAX_OUT_M = 25;
/** How far behind the face the camera still sees (m): a wall inside its cell-quantized box. */
const IN_M = 12;
/** Longest side of one face's rectangle in texels. */
const MAX_FACE_PX = 768;
/** Shelf rows are this granular in texels; keeps packing simple. */
const ROW_STEP = 16;
/** Atlas fill target when choosing the texel size (m per texel) from the total wall area. */
const FILL_TARGET = 0.7;
/** Texel size bounds (m). */
const TEXEL_MIN = 0.35, TEXEL_MAX = 2.0;
/** After everything is painted, the nearest faces are refreshed this often (ms) to pick up refined tiles. */
const REFRESH_MS = 4000;

export interface AtlasRect { x: number; y: number; w: number; h: number }

interface FaceJob {
  readonly box: number;
  readonly face: WallFace;
  /** face centre and size in world units */
  readonly cx: number; readonly cy: number; readonly cz: number;
  readonly width: number; readonly height: number;
  /** how far into the street the camera stands; 0 means an internal face, never baked */
  readonly out: number;
  rect: AtlasRect | null;
  done: boolean;
  bakedAt: number;
}

const FACE_NORMAL: readonly [number, number, number][] = [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]];

/** Key identical boxes across collider rebuilds so their photos survive. */
export function boxKey(b: BuildingCollider): string {
  return `${b.min.x.toFixed(1)},${b.min.y.toFixed(1)},${b.min.z.toFixed(1)}|${b.max.x.toFixed(1)},${b.max.y.toFixed(1)},${b.max.z.toFixed(1)}`;
}

/**
 * How far a wall face may look into the street before it would see the box
 * on the other side: half the gap to the nearest box that overlaps it
 * across, capped. 0 for a face another box is flush against (internal).
 */
export function faceReach(boxes: readonly BuildingCollider[], i: number, face: WallFace): number {
  const a = boxes[i]!;
  let gap = Infinity;
  for (let k = 0; k < boxes.length; k++) {
    if (k === i) continue;
    const b = boxes[k]!;
    if (b.max.y < a.min.y + 1) continue;
    let g: number;
    if (face === 0 || face === 1) {
      if (b.max.z <= a.min.z || b.min.z >= a.max.z) continue;
      g = face === 0 ? a.min.x - b.max.x : b.min.x - a.max.x;
    } else {
      if (b.max.x <= a.min.x || b.min.x >= a.max.x) continue;
      g = face === 2 ? a.min.z - b.max.z : b.min.z - a.max.z;
    }
    if (g >= -0.01 && g < gap) gap = g;
  }
  if (gap < 0.5) return 0;
  return Math.min(MAX_OUT_M, Math.max(2, gap / 2));
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

export interface BakerHooks {
  /** the tiles root; hidden in the mode, made visible for each bake */
  readonly tiles: () => Object3D | null;
  /** turn the clutter filter and snap off for the photo, and back after */
  readonly before: () => void;
  readonly after: () => void;
  /** a face's photo landed: hand the box mesh its atlas rect (texels) */
  readonly onRect: (box: number, face: WallFace, rect: AtlasRect) => void;
}

export class FacadeBaker {
  readonly atlas: WebGLRenderTarget;
  private jobs: FaceJob[] = [];
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

  /** Faces painted so far, for the diag line. */
  get progress(): { done: number; total: number; texel: number; atlasUsed: number } {
    let done = 0, total = 0;
    for (const j of this.jobs) { if (j.out > 0) { total++; if (j.done) done++; } }
    return { done, total, texel: this.texel, atlasUsed: this.packer.used };
  }

  /** The colliders were rebuilt: keep photos of boxes that did not change, queue the rest. */
  setColliders(boxes: readonly BuildingCollider[]): void {
    const keep = new Map<string, FaceJob[]>();
    for (const j of this.jobs) {
      if (!j.done || !j.rect) continue;
      const key = j.box < this.lastBoxes.length ? boxKey(this.lastBoxes[j.box]!) : '';
      let list = keep.get(key);
      if (!list) keep.set(key, list = []);
      list.push(j);
    }
    this.lastBoxes = boxes;
    // texel size from the total wall area, so a whole downtown fits the atlas
    let area = 0;
    for (const b of boxes) {
      const h = Math.max(0, b.max.y - b.min.y);
      area += 2 * ((b.max.x - b.min.x) + (b.max.z - b.min.z)) * h;
    }
    let texel = Math.min(TEXEL_MAX, Math.max(TEXEL_MIN, Math.sqrt(area / (ATLAS_SIZE * ATLAS_SIZE * FILL_TARGET))));
    // the last layout ran out of room: go coarser rather than leave the rest bare
    if (this.full) texel = Math.max(texel, this.texel * 1.25);
    if (Math.abs(texel - this.texel) > 0.05 || this.full) {
      // a new density means a new layout: start the atlas over
      this.texel = texel;
      this.packer = new ShelfPacker(ATLAS_SIZE);
      this.full = false;
      keep.clear();
    }
    const jobs: FaceJob[] = [];
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      const kept = keep.get(boxKey(b));
      for (let f = 0; f < 4; f++) {
        const face = f as WallFace;
        const along = face < 2 ? b.max.z - b.min.z : b.max.x - b.min.x;
        const height = b.max.y - b.min.y;
        const cx = face === 0 ? b.min.x : face === 1 ? b.max.x : (b.min.x + b.max.x) / 2;
        const cz = face === 2 ? b.min.z : face === 3 ? b.max.z : (b.min.z + b.max.z) / 2;
        const prev = kept?.find(j => j.face === face);
        const job: FaceJob = {
          box: i, face, cx, cy: (b.min.y + b.max.y) / 2, cz, width: along, height,
          out: faceReach(boxes, i, face),
          rect: prev?.rect ?? null, done: !!prev, bakedAt: prev?.bakedAt ?? 0
        };
        if (job.done && job.rect) this.hooks.onRect(i, face, job.rect);
        jobs.push(job);
      }
    }
    this.jobs = jobs;
    this.orderFor.set(Infinity, Infinity, Infinity);
  }

  private lastBoxes: readonly BuildingCollider[] = [];

  private reorder(camPos: Vector3): void {
    if (camPos.distanceTo(this.orderFor) < 40) return;
    this.orderFor.copy(camPos);
    const d = (j: FaceJob) => (j.cx - camPos.x) * (j.cx - camPos.x) + (j.cz - camPos.z) * (j.cz - camPos.z);
    this.order = this.jobs.map((_, i) => i).filter(i => this.jobs[i]!.out > 0).sort((a, b) => d(this.jobs[a]!) - d(this.jobs[b]!));
    this.refreshCursor = 0;
  }

  /** Bake pending faces nearest the camera first, within `budgetMs` of wall clock. */
  update(camPos: Vector3, nowMs: number, budgetMs = 4): void {
    if (this.jobs.length === 0) return;
    this.reorder(camPos);
    const t0 = performance.now();
    let began = false;
    const begin = () => {
      if (began) return;
      began = true;
      this.renderer.getClearColor(this._clear);
      this._clearAlpha = this.renderer.getClearAlpha();
      this.hooks.before();
    };
    for (const i of this.order) {
      if (performance.now() - t0 > budgetMs) break;
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
      j.done = true;
      j.bakedAt = nowMs;
      this.hooks.onRect(j.box, j.face, j.rect);
    }
    // everything painted: refresh the nearest faces slowly so tiles that refined since show up
    if (!began && this.order.length > 0) {
      const n = Math.min(6, this.order.length);
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

  private bake(j: FaceJob): void {
    const r = j.rect!;
    const tiles = this.hooks.tiles();
    const wasVisible = tiles?.visible ?? false;
    if (tiles) tiles.visible = true;
    const bg = this.scene.background;
    this.scene.background = null;
    const n = FACE_NORMAL[j.face]!;
    this.cam.left = -j.width / 2; this.cam.right = j.width / 2;
    this.cam.top = j.height / 2; this.cam.bottom = -j.height / 2;
    this.cam.near = 0.1; this.cam.far = j.out + IN_M;
    this.cam.updateProjectionMatrix();
    this.cam.position.set(j.cx + n[0] * j.out, j.cy, j.cz + n[2] * j.out);
    this.cam.lookAt(this._c.set(j.cx, j.cy, j.cz));
    this.cam.updateMatrixWorld();
    // the target's own viewport and scissor, applied by setRenderTarget: renderer.setViewport
    // would move the canvas viewport and leave the main view drawing into one small rectangle
    this.atlas.viewport.set(r.x, r.y, r.w, r.h);
    this.atlas.scissor.set(r.x, r.y, r.w, r.h);
    this.atlas.scissorTest = true;
    this.renderer.setRenderTarget(this.atlas);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, this.cam);
    this.scene.background = bg;
    if (tiles) tiles.visible = wasVisible;
  }

  dispose(): void {
    this.atlas.dispose();
    this.jobs = [];
  }
}
