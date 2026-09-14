/**
 * Google Photorealistic 3D Tiles: tree traversal, GLB placement, and
 * streaming refinement around the player. Building colliders live in
 * tileColliders.ts.
 *
 * Endpoint https://tile.googleapis.com/v1/3dtiles/root, auth via the
 * X-Goog-Api-Key header (CORS-confirmed). What Google's tree actually looks
 * like, as probed against Portland:
 * - WGS84 ECEF throughout. Bounding volumes are OBBs (center + 3 half-axis
 *   vectors); no regions, no tileset transforms. Placement lives in each
 *   GLB's node matrix, in glTF Y-up — the spec's +90° X rotation turns that
 *   into Z-up ECEF.
 * - ~22 levels deep, refine REPLACE. Content URIs alternate between .glb and
 *   external .json sub-tilesets. Root URIs carry a ?session= query that every
 *   nested fetch must forward or Google answers 400.
 * - Every level has a GLB and geometricError halves per level (16 km at
 *   depth 8, 32 m at depth 20), so a loader must pick ONE level per area:
 *   collecting ancestors renders continent-sized slabs over the play field.
 * - A tile is one merged photogrammetry mesh (ground + buildings + trees),
 *   ~5k triangles, 100–450 KB.
 */
import {
  Matrix4, Vector3, Group, LinearMipmapLinearFilter, LinearFilter,
  type Object3D, type Mesh, type Material, type Texture
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { tileTransformChain } from '../../core/geo/projection.ts';
import { latLonToEcef, WORLD_M_PER_M, type Ecef, type GeoOrigin } from '../../core/geo/ecef.ts';
import type { BuildingCollider } from '../../core/physics/VehicleBody.ts';
import type { TerrainProvider } from '../../core/terrain/TerrainProvider.ts';
import { Heightfield } from '../../core/heightfield.ts';
import { logger } from '../../app/log.ts';
import { tileCache } from './TileCache.ts';
import { fetchRoadPolylines, rasterizeRoads, rasterizeRoadRaster, type RoadGrid } from '../osm/roads.ts';
import { fetchRoadRasters, type RoadRaster } from '../maps/MapsApi.ts';
import type { ColliderJob, ColliderResult } from './colliderWorker.ts';
import {
  gridFor, sampleTerrain, rasterizeTile, collidersFromRasters, tileGroundOffset, groundField,
  AmortizedGroundBuilder, TILE_GROUND_GAP, NO_DATA,
  type Grid, type TileRaster, type ColliderExperimentMode, thresholdsForMode
} from './tileColliders.ts';
import {
  type Resolution3DMode, type Resolution3DProfile, RESOLUTION_3D_PROFILES, getResolutionProfile
} from './resolutionProfiles.ts';

export {
  type Resolution3DMode, type Resolution3DProfile, RESOLUTION_3D_PROFILES, getResolutionProfile
};

export interface TileNode {
  boundingVolume?: { box?: number[] };
  geometricError?: number;
  content?: { uri?: string };
  children?: TileNode[];
}

interface TilesetRoot extends TileNode {
  root?: TileNode;
}

/** Level of detail: the geometricError accepted grows with distance from a center. */
export interface LodPolicy {
  /** Finest error accepted (m), used near the center. */
  readonly minErrorM: number;
  /** Coarsest error accepted (m), used toward the load radius. */
  readonly maxErrorM: number;
  /** Error allowed per meter of distance, between the two clamps. */
  readonly errorPerMeter: number;
}

/**
 * Initial load, relative to the match center. Google's levels carry errors
 * of 16.05, 32.1, 64.2 m (525957 m halved per level). We accept ~16m tiles
 * near center so the initial load is quick (~1-2s) and light.
 */
export const DEFAULT_LOD: LodPolicy = { minErrorM: 10, maxErrorM: 60, errorPerMeter: 1 / 30 };
/** Streaming, relative to the player: 1.5 m tiles within 90 m, 3 m to 180 m, 5 m to 300 m, 8 m to 500 m. */
export const STREAM_LOD: LodPolicy = { minErrorM: 1.5, maxErrorM: 40, errorPerMeter: 1 / 60 };

/** The field is 5600 units = 5.6 km across; 4 km reaches its corners. */
const LOAD_RADIUS_M = 4000;
/** Initial-load cap; the closest win. */
const MAX_INITIAL_TILES = 150;
/**
 * Streaming stops adding detail past this many tiles (~1 MB of GPU each).
 * Evicts the farthest tiles beyond the fog horizon when reaching capacity.
 */
const MAX_TILES = 350;
/** Tiles beyond this distance (into the fog horizon) can be evicted under budget pressure. */
const FOG_HORIZON_M = 1500;
const CONCURRENCY = 6;
/** Before play, tiles within visible range of the start are refined to the streaming LOD. */
export const CORE_RADIUS_M = 500;
/** ...in rounds of this many refinements. */
const CORE_REFINE_BATCH = 6;
const TILE_BASE = 'https://tile.googleapis.com';
const gltfLoader = new GLTFLoader();
// glTF is Y-up, 3D Tiles content is Z-up ECEF: rotate +90° about X (y→z, z→−y)
const GLTF_TO_ECEF = new Matrix4().makeRotationX(Math.PI / 2);

function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * Distance from a point to a 3D Tiles OBB (center + 3 half-axis vectors).
 * Projects the point onto each half-axis and clamps to the half-length, so
 * distance is 0 inside the box regardless of orientation.
 */
export function boxDistanceM(p: Ecef, box: readonly number[]): number {
  let sq = 0;
  for (let k = 0; k < 3; k++) {
    const ax = box[3 + k * 3] ?? 0;
    const ay = box[4 + k * 3] ?? 0;
    const az = box[5 + k * 3] ?? 0;
    const h = Math.hypot(ax, ay, az);
    if (h < 1e-9) continue;
    const d = ((p.x - (box[0] ?? 0)) * ax + (p.y - (box[1] ?? 0)) * ay + (p.z - (box[2] ?? 0)) * az) / h;
    const over = Math.max(0, Math.abs(d) - h);
    sq += over * over;
  }
  return Math.sqrt(sq);
}

function nodeDistM(node: TileNode, p: Ecef): number {
  const box = node.boundingVolume?.box;
  return box ? boxDistanceM(p, box) : 0;
}

/** path part of a content uri, minus any ?session=... query */
function uriPath(uri: string): string {
  return uri.split('?')[0] ?? uri;
}

function sessionOf(uri: string | undefined): string | null {
  return uri?.match(/[?&]session=([^&]+)/)?.[1] ?? null;
}

function fullUrl(uri: string): string {
  return uri.startsWith('http') ? uri : TILE_BASE + (uri.startsWith('/') ? '' : '/') + uri;
}

function withSession(url: string, session: string | null): string {
  if (!session || /[?&]session=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'session=' + session;
}

const isJson = (uri: string | undefined): uri is string => uri !== undefined && /\.json$/i.test(uriPath(uri));
const isGlb = (uri: string | undefined): uri is string => uri !== undefined && /\.glb$/i.test(uriPath(uri));

const log = logger('tiles');

/**
 * Streaming a city drops tiles routinely, so each failure is debug noise while
 * the tally is the thing worth carrying: it is the difference between "Tokyo
 * looks sparse" and "Tokyo half loaded and here is why".
 */
const failures = new Map<string, number>();

function noteFailure(kind: string, data: unknown): void {
  failures.set(kind, (failures.get(kind) ?? 0) + 1);
  log.debug(kind, data);
}

export async function fetchTilesRoot(apiKey: string): Promise<TilesetRoot> {
  const res = await fetchWithTimeout(TILE_BASE + '/v1/3dtiles/root', { headers: { 'X-Goog-Api-Key': apiKey } });
  if (!res.ok) throw new Error('3D tiles root HTTP ' + res.status);
  return res.json();
}

async function fetchSubTileset(url: string, apiKey: string): Promise<TilesetRoot | null> {
  try {
    const cached = await tileCache.getJson<TilesetRoot>(url);
    if (cached) return cached;
    const res = await fetchWithTimeout(url, { headers: { 'X-Goog-Api-Key': apiKey } });
    if (!res.ok) {
      noteFailure('sub-tileset http', { status: res.status, path: uriPath(url).slice(-40) });
      return null;
    }
    const data = await res.json();
    await tileCache.putJson(url, data);
    return data;
  } catch (e) {
    noteFailure('sub-tileset threw', e);
    return null;
  }
}

export interface CollectedTile {
  readonly node: TileNode;
  /** session of the tileset this node came from, forwarded to its content fetch */
  readonly session: string | null;
  readonly distM: number;
}

export function allowedErrorM(distM: number, lod: LodPolicy): number {
  return Math.min(lod.maxErrorM, Math.max(lod.minErrorM, distM * lod.errorPerMeter));
}

/**
 * Walk the tree level by level, keeping only nodes whose OBB comes within
 * radiusM of ecef0, and collect one GLB per area: the first node on each
 * path whose geometricError meets the LOD policy (or a leaf). Sub-tileset
 * fetches within a level run in parallel.
 */
export async function collectTiles(
  root: TileNode,
  ecef0: Ecef,
  radiusM: number,
  apiKey: string,
  lod: LodPolicy = DEFAULT_LOD,
  maxTiles = MAX_INITIAL_TILES
): Promise<CollectedTile[]> {
  const tiles: CollectedTile[] = [];
  let frontier: CollectedTile[] = [{ node: root, session: sessionOf(root.content?.uri), distM: 0 }];
  // the depth cap only guards against a malformed tree; Google's ends ~22
  for (let depth = 0; depth < 40 && frontier.length > 0; depth++) {
    const next: CollectedTile[] = [];
    await Promise.all(frontier.map(async ({ node, session }) => {
      const distM = nodeDistM(node, ecef0);
      if (distM > radiusM) return;
      const uri = node.content?.uri;
      if (isJson(uri)) {
        const sub = await fetchSubTileset(withSession(fullUrl(uri), session), apiKey);
        if (sub) next.push({ node: sub.root ?? sub, session: sessionOf(uri) ?? session, distM });
        return;
      }
      const fineEnough = (node.geometricError ?? 0) <= allowedErrorM(distM, lod) || !node.children?.length;
      if (isGlb(uri) && fineEnough) {
        tiles.push({ node, session, distM });
        return;
      }
      for (const c of node.children ?? []) next.push({ node: c, session, distM });
    }));
    frontier = next;
  }
  return tiles.sort((a, b) => a.distM - b.distM).slice(0, maxTiles);
}

/**
 * The GLB nodes one level below `node`, resolving external sub-tilesets and
 * content-less nodes on the way. Throws if a sub-tileset fetch fails.
 */
async function nextLevel(node: TileNode, session: string | null, apiKey: string): Promise<CollectedTile[]> {
  const out: CollectedTile[] = [];
  await Promise.all((node.children ?? []).map(async child => {
    const uri = child.content?.uri;
    if (isJson(uri)) {
      const sub = await fetchSubTileset(withSession(fullUrl(uri), session), apiKey);
      if (!sub) throw new Error('sub-tileset fetch failed');
      const root = sub.root ?? sub;
      const s = sessionOf(uri) ?? session;
      if (isGlb(root.content?.uri)) out.push({ node: root, session: s, distM: 0 });
      else out.push(...await nextLevel(root, s, apiKey));
    } else if (isGlb(uri)) {
      out.push({ node: child, session, distM: 0 });
    } else {
      out.push(...await nextLevel(child, session, apiKey));
    }
  }));
  return out;
}

/**
 * World matrix for a Google GLB. There are no per-tile transforms, so one
 * matrix places every tile; the chain's Translate(-ecef0) is what keeps the
 * ~6.4M m ECEF node positions from projecting the earth radius onto Y.
 */
export function glbPlacement(origin: GeoOrigin, ecef0: Ecef, reliefBoost: number): Matrix4 {
  return tileTransformChain(new Matrix4(), origin, ecef0, reliefBoost).multiply(GLTF_TO_ECEF);
}

function forEachMap(root: Object3D, fn: (map: Texture) => void): void {
  root.traverse(obj => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const map = (m as Material & { map?: Texture | null }).map;
      if (map) fn(map);
    }
  });
}

async function loadTileGlb(
  tile: CollectedTile,
  placement: Matrix4,
  apiKey: string,
  anisotropy: number
): Promise<Group | null> {
  const url = withSession(fullUrl(tile.node.content!.uri!), tile.session);
  // Check TileCache first: avoid network roundtrips and billing sessions for cached geometry
  let buf: ArrayBuffer | null = await tileCache.getBuffer(url);
  if (!buf) {
    try {
      const res = await fetchWithTimeout(url, { headers: { 'X-Goog-Api-Key': apiKey } });
      if (!res.ok) {
        noteFailure('tile http', { status: res.status, path: uriPath(url).slice(-40) });
        return null;
      }
      buf = await res.arrayBuffer();
      await tileCache.putBuffer(url, buf, 'model/gltf-binary');
    } catch (e) {
      noteFailure('tile threw', e);
      return null;
    }
  }
  const root = (await gltfLoader.parseAsync(buf, '')).scene;
  root.matrixAutoUpdate = false;
  root.matrix.copy(placement);
  root.matrixWorldNeedsUpdate = true;
  // Enforce trilinear mipmapping + anisotropy so grazing ground and facades stay sharp without GPU texture sampler stalls
  forEachMap(root, map => {
    map.anisotropy = Math.min(anisotropy, 16);
    map.minFilter = LinearMipmapLinearFilter;
    map.magFilter = LinearFilter;
  });
  // a photo is already display-referred: running it through the scene's filmic
  // curve again crushed the facades and darkened every street; show it as shot
  root.traverse(obj => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.toneMapped = false;
  });
  return root;
}

/** Free the GPU resources of a tiles group that has been removed from the scene. */
export function disposeTiles(group: Object3D): void {
  group.traverse(obj => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      (m as Material & { map?: Texture | null }).map?.dispose();
      m.dispose();
    }
  });
}

interface LoadedTile extends CollectedTile {
  readonly group: Group;
  raster: TileRaster | null;
  /** leaf, refined, or failed: never pick again */
  done: boolean;
}

const _ecef = new Vector3();

/**
 * Owns the loaded tiles. `loadInitial` fills the field at DEFAULT_LOD; then
 * `update` swaps the nearest tile that is too coarse for its distance to the
 * player with its children, one swap at a time, until MAX_TILES. Colliders
 * are rebuilt on demand from the per-tile rasters.
 */
export class TileStreamer {
  readonly group = new Group();
  private readonly tiles: LoadedTile[] = [];
  grid: Grid;
  private terrainTop: Float32Array;
  private readonly reliefBoost: number;
  private readonly placement: Matrix4;
  private readonly worldToEcef: Matrix4;
  /** OSM road-centreline mask on the same grid; null until fetched or when the fetch failed. */
  private roadGrid: RoadGrid | null = null;
  private inFlight = false;
  private lastPickMs = 0;
  private dirty = false;
  private shiftY = 0;
  /** n*n cells, 1 = building/deck/ramp as of the last colliders() call; render filters sample it. */
  structureGrid: Uint8Array;
  /** Called with each tile's scene graph as it loads, before it joins the group. */
  onTileLoaded: ((group: Group) => void) | null = null;
  /** Called when OSM road network geometry finishes downloading in background. */
  onRoadsLoaded: (() => void) | null = null;
  private currentExperiment: ColliderExperimentMode = 'baseline';
  private roadPolys: { east: number; north: number; widthM: number }[][] | null = null;
  private roadRaster: RoadRaster[] | null = null;
  private resolutionMode: Resolution3DMode = 'balanced';
  private lod: LodPolicy = STREAM_LOD;
  private maxTiles = MAX_TILES;
  private refineIntervalMs = 250;
  private refineBatchSize = 1;

  constructor(
    private readonly apiKey: string,
    private readonly terrain: TerrainProvider,
    private readonly origin: GeoOrigin,
    private readonly ecef0: Ecef,
    private anisotropy = 1,
    resolutionModeOrLod: Resolution3DMode | LodPolicy = 'balanced'
  ) {
    if (typeof resolutionModeOrLod === 'string') {
      this.resolutionMode = resolutionModeOrLod;
      const profile = getResolutionProfile(resolutionModeOrLod);
      this.lod = profile.lod;
      this.maxTiles = profile.maxTiles;
      this.refineIntervalMs = profile.refineIntervalMs;
      this.refineBatchSize = profile.refineBatchSize;
      this.anisotropy = Math.max(this.anisotropy, profile.anisotropy);
    } else {
      this.lod = resolutionModeOrLod;
    }
    this.grid = gridFor(terrain.heightfield);
    this.terrainTop = sampleTerrain(this.grid, terrain.heightfield);
    this.reliefBoost = terrain.reliefBoost;
    this.placement = glbPlacement(origin, ecef0, terrain.reliefBoost);
    this.worldToEcef = tileTransformChain(new Matrix4(), origin, ecef0, terrain.reliefBoost).invert();
    this.deckGrid = new Float32Array(this.grid.n * this.grid.n).fill(NO_DATA);
    this.topGrid = new Float32Array(this.grid.n * this.grid.n).fill(NO_DATA);
    this.structureGrid = new Uint8Array(this.grid.n * this.grid.n);
  }

  get activeResolutionMode(): Resolution3DMode {
    return this.resolutionMode;
  }

  get activeLodPolicy(): LodPolicy {
    return this.lod;
  }

  get activeMaxTiles(): number {
    return this.maxTiles;
  }

  setResolutionMode(mode: Resolution3DMode): void {
    if (this.resolutionMode === mode) return;
    this.resolutionMode = mode;
    const profile = getResolutionProfile(mode);
    this.lod = profile.lod;
    this.maxTiles = profile.maxTiles;
    this.refineIntervalMs = profile.refineIntervalMs;
    this.refineBatchSize = profile.refineBatchSize;
    this.anisotropy = Math.max(this.anisotropy, profile.anisotropy);
    // Allow tiles that stopped at a coarser LOD to be refined further
    for (const t of this.tiles) {
      if ((t.node.children?.length ?? 0) > 0) {
        t.done = false;
      }
    }
    this.dirty = true;
    log.info('3D resolution profile set', {
      mode,
      maxTiles: this.maxTiles,
      minErrorM: this.lod.minErrorM,
      intervalMs: this.refineIntervalMs,
      anisotropy: this.anisotropy
    });
  }

  get tileCount(): number {
    return this.tiles.length;
  }

  /** True once tiles changed since the last `colliders()` call. */
  get collidersDirty(): boolean {
    return this.dirty;
  }

  /** World-space X/Z rectangular footprint of all currently loaded tiles. */
  getTileBounds(): readonly { minX: number; maxX: number; minZ: number; maxZ: number }[] {
    const half = this.grid.half;
    const cell = this.grid.cell;
    const out: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
    for (const t of this.tiles) {
      if (!t.raster) continue;
      out.push({
        minX: -half + t.raster.i0 * cell,
        maxX: -half + (t.raster.i0 + t.raster.w) * cell,
        minZ: -half + t.raster.j0 * cell,
        maxZ: -half + (t.raster.j0 + t.raster.h) * cell
      });
    }
    return out;
  }

  async loadInitial(root: TileNode, onProgress?: (loaded: number, total: number) => void): Promise<void> {
    // roads are static for the match: fetch once, before the first collider
    // build; a failure just means no mask (classifier behaves as before)
    void this.loadRoads();
    const wanted = await collectTiles(root, this.ecef0, LOAD_RADIUS_M, this.apiKey);
    let next = 0;
    let loaded = 0;
    const worker = async (): Promise<void> => {
      while (next < wanted.length) {
        await this.add(wanted[next++]!);
        onProgress?.(++loaded, wanted.length);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await this.refineCore(onProgress);
    this.calibrateGround();
    // Allow a brief grace period for roads if ready during tile loading,
    // but never hang match startup if Overpass is slow or timing out
    if (this.roadsPromise) {
      await Promise.race([
        this.roadsPromise,
        new Promise(resolve => setTimeout(resolve, 1500))
      ]);
    }
  }

  private roadsPromise: Promise<void> | null = null;
  private roadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private roadRetryMs = 20000;

  private async loadRoads(): Promise<void> {
    if (this.roadsPromise) return this.roadsPromise;
    const origin = this.origin;
    this.roadsPromise = (async () => {
      // two layers, unioned (docs/ROAD-MASK.md): Google's styled roadmap, same key and uptime
      // as the imagery, lands first; OSM ways from Overpass add the alleys Google omits
      // whenever a mirror answers, and stand alone if the Google raster fails
      try {
        this.roadRaster = await fetchRoadRasters(origin.lat, origin.lon, this.apiKey);
        log.info('road mask from google roadmap');
        this.publishRoadGrid();
      } catch (e) {
        log.warn('google road raster failed', String(e).slice(0, 120));
      }
      try {
        const polys = await fetchRoadPolylines({ lat: origin.lat, lon: origin.lon, halfM: this.grid.half });
        if (polys) {
          this.roadPolys = polys;
          log.info('road mask: osm ways added', { ways: polys.length });
          this.publishRoadGrid();
        }
      } catch (e) {
        log.warn('osm road mask failed', e);
      }
      if (this.roadGrid) return;
      // Overpass is down for hours at a time, and without the corridor mask whole blocks
      // merge into one collider: keep asking, backing off to two minutes, until it answers
      this.roadRetryTimer = setTimeout(() => {
        this.roadRetryTimer = null;
        this.roadsPromise = null;
        void this.loadRoads();
      }, this.roadRetryMs);
      this.roadRetryMs = Math.min(120000, this.roadRetryMs * 2);
    })();
    return this.roadsPromise;
  }

  /** The union of every road layer that has landed, on the active grid; `fire` announces it to the collider pass. */
  private publishRoadGrid(fire = true): void {
    const slack = thresholdsForMode(this.currentExperiment).roadReachSlackMultiplier ?? 0.5;
    const layers: RoadGrid[] = [];
    if (this.roadRaster) layers.push(rasterizeRoadRaster(this.roadRaster, this.grid, this.origin, slack));
    if (this.roadPolys) layers.push(rasterizeRoads(this.roadPolys, this.grid, slack));
    const first = layers[0];
    if (!first) return;
    for (let k = 1; k < layers.length; k++) {
      const m = layers[k]!.mask;
      for (let c = 0; c < first.mask.length; c++) if (m[c]) first.mask[c] = 1;
    }
    this.roadGrid = first;
    this.dirty = true;
    if (fire) this.onRoadsLoaded?.();
  }

  /** True if any loaded 3D tile covers (or comes within radiusM of) the world coordinate. */
  hasTileNear(wx: number, wz: number, radiusM = 150): boolean {
    const half = this.grid.half;
    const cell = this.grid.cell;
    const pad = Math.ceil(radiusM / cell);
    const i = Math.floor((wx + half) / cell);
    const j = Math.floor((wz + half) / cell);
    if (i < -pad || i >= this.grid.n + pad || j < -pad || j >= this.grid.n + pad) return false;
    for (const t of this.tiles) {
      const r = t.raster;
      if (!r) continue;
      if (i >= r.i0 - pad && i <= r.i0 + r.w + pad && j >= r.j0 - pad && j <= r.j0 + r.h + pad) {
        return true;
      }
    }
    return false;
  }

  private deckGrid: Float32Array;
  /** Photogrammetry top of every building cell (NO_DATA elsewhere): the per-cell roof heights Best 3D+ draws. */
  private topGrid: Float32Array;

  get activeDeckGrid(): Float32Array {
    return this.deckGrid;
  }

  get activeTopGrid(): Float32Array {
    return this.topGrid;
  }

  get activeGrid(): Grid {
    return this.grid;
  }

  get experimentMode(): ColliderExperimentMode {
    return this.currentExperiment;
  }

  get hasRoadGrid(): boolean {
    return this.roadGrid != null;
  }

  /** OSM road corridor mask on the active grid (1 = road), null until the fetch lands. */
  get roadMask(): Uint8Array | null {
    return this.roadGrid?.mask ?? null;
  }

  setExperimentMode(mode: ColliderExperimentMode): void {
    if (this.currentExperiment === mode) return;
    this.currentExperiment = mode;
    const th = thresholdsForMode(mode);
    const targetCell = th.cell;
    if (this.grid.cell !== targetCell) {
      const half = this.grid.half;
      const n = Math.ceil((half * 2) / targetCell);
      this.grid = { cell: targetCell, half, n };
      this.terrainTop = sampleTerrain(this.grid, this.terrain.heightfield);
      this.deckGrid = new Float32Array(n * n).fill(NO_DATA);
      this.topGrid = new Float32Array(n * n).fill(NO_DATA);
      this.structureGrid = new Uint8Array(n * n);
      for (const t of this.tiles) {
        t.raster = rasterizeTile(t.group, this.grid);
      }
    }
    if (this.roadRaster || this.roadPolys) {
      this.publishRoadGrid(false);
    } else if (mode === 'road_carve') {
      void this.loadRoads();
    }
    this.dirty = true;
  }

  /**
   * O(1) mathematical lookup of elevated drivable surfaces (e.g. bridge decks, overpasses, ramps)
   * sampled bilinearly from the classified deck grid. Zero raycasts, zero allocations.
   */
  surfaceElevation(x: number, z: number, currentY: number, groundY: number, maxDrop = 4.0): number | null {
    if (!this.deckGrid) return null;
    const half = this.grid.half;
    const cell = this.grid.cell;
    const n = this.grid.n;

    // Fractional coordinates relative to cell centers
    const u = (x + half) / cell - 0.5;
    const v = (z + half) / cell - 0.5;
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const i1 = i0 + 1;
    const j1 = j0 + 1;

    if (i0 < 0 || i1 >= n || j0 < 0 || j1 >= n) {
      const i = Math.floor((x + half) / cell);
      const j = Math.floor((z + half) / cell);
      if (i < 0 || i >= n || j < 0 || j >= n) return null;
      const h = this.deckGrid[j * n + i]!;
      if (h === NO_DATA) return null;
      const deckH = h + TILE_GROUND_GAP;
      // Car can only land on or ride a deck from above, never snap up onto it from underneath
      if (deckH > currentY + 0.5) return null;
      if (currentY - deckH > maxDrop) return null;
      if (deckH < groundY - 0.5) return null;
      return Math.max(deckH, groundY);
    }

    const c00 = j0 * n + i0;
    const c10 = j0 * n + i1;
    const c01 = j1 * n + i0;
    const c11 = j1 * n + i1;

    const h00 = this.deckGrid[c00]!;
    const h10 = this.deckGrid[c10]!;
    const h01 = this.deckGrid[c01]!;
    const h11 = this.deckGrid[c11]!;

    // If none of the 4 corners have deck data, this is not a deck or ramp
    if (h00 === NO_DATA && h10 === NO_DATA && h01 === NO_DATA && h11 === NO_DATA) {
      return null;
    }

    const tx = u - i0;
    const tz = v - j0;

    let deckH: number;
    if (h00 !== NO_DATA && h10 !== NO_DATA && h01 !== NO_DATA && h11 !== NO_DATA) {
      const a = h00 + (h10 - h00) * tx;
      const b = h01 + (h11 - h01) * tx;
      deckH = (a + (b - a) * tz) + TILE_GROUND_GAP;
    } else {
      // Edge of deck/ramp: average available valid samples weighted by distance
      let sum = 0, weight = 0;
      if (h00 !== NO_DATA) { const w = (1 - tx) * (1 - tz); sum += h00 * w; weight += w; }
      if (h10 !== NO_DATA) { const w = tx * (1 - tz); sum += h10 * w; weight += w; }
      if (h01 !== NO_DATA) { const w = (1 - tx) * tz; sum += h01 * w; weight += w; }
      if (h11 !== NO_DATA) { const w = tx * tz; sum += h11 * w; weight += w; }
      if (weight < 1e-4) return null;
      deckH = (sum / weight) + TILE_GROUND_GAP;
    }

    // Car can only land on or ride a deck from above, never snap up onto it from underneath
    if (deckH > currentY + 0.5) return null;
    if (currentY - deckH > maxDrop) return null;
    if (deckH < groundY - 0.5) return null;
    return Math.max(deckH, groundY);
  }

  /**
   * Refine tiles near the start to a crisp core before the match begins.
   * Capped at 2 quick rounds with ~10m error threshold so initial load completes
   * in ~1-2s; the streaming loop (update) takes over and refines down to 1.5m
   * during gameplay without stalling.
   */
  private async refineCore(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const profile = getResolutionProfile(this.resolutionMode);
    const CORE_TARGET_ERROR_M = this.lod.minErrorM;
    const coreRadius = profile.coreRadiusM;
    const maxRounds = profile.coreRefineRounds;
    for (let round = 0; round < maxRounds && this.tiles.length < this.maxTiles; round++) {
      const coarse = this.tiles
        .filter(t => !t.done && nodeDistM(t.node, this.ecef0) < coreRadius
          && (t.node.geometricError ?? 0) > CORE_TARGET_ERROR_M)
        .sort((a, b) => nodeDistM(a.node, this.ecef0) - nodeDistM(b.node, this.ecef0))
        .slice(0, CORE_REFINE_BATCH);
      if (coarse.length === 0) return;
      await Promise.all(coarse.map(t => this.refine(t).catch(e => {
        noteFailure('refine failed', e);
        t.done = true;
      })));
      onProgress?.(this.tiles.length, this.tiles.length);
    }
  }

  /**
   * The ground everything plays on: the tile surface with buildings erased,
   * the elevation grid where tiles have no data (see groundField).
   */
  groundHeightfield(): Heightfield {
    const cells = groundField(
      this.tiles.map(t => t.raster),
      this.grid,
      this.terrainTop,
      this.reliefBoost,
      undefined,
      this.roadGrid
    );
    return Heightfield.fromCells(cells, this.grid.n, this.grid.cell);
  }

  /**
   * Create an amortized ground builder that computes refined ground heights
   * incrementally over multiple animation frames without freezing the main thread.
   */
  createGroundBuilder(): AmortizedGroundBuilder {
    return new AmortizedGroundBuilder(
      this.tiles.map(t => t.raster),
      this.grid,
      this.terrainTop,
      this.reliefBoost,
      undefined,
      this.roadGrid
    );
  }

  /** Shift every tile so the tile ground sits cleanly flush or above the terrain underlay (see tileGroundOffset). */
  private calibrateGround(): void {
    const offset = tileGroundOffset(this.tiles.map(t => t.raster), this.grid, this.terrainTop);
    if (offset === null) return;
    const shiftY = -(offset - TILE_GROUND_GAP);
    this.shiftY = shiftY;
    // Bake datum shift directly into placement matrix so all future refined tiles
    // are automatically loaded and rasterized in the calibrated frame
    this.placement.elements[13] += shiftY;
    for (const t of this.tiles) {
      t.group.matrix.elements[13] += shiftY;
      t.group.matrixWorldNeedsUpdate = true;
      t.group.updateMatrixWorld(true);
      t.raster = rasterizeTile(t.group, this.grid);
    }
    this.group.position.y = 0;
    this.group.updateMatrixWorld(true);
    this.dirty = true;
    log.info('ground datum shifted', {
      metres: Number((shiftY / WORLD_M_PER_M / this.reliefBoost).toFixed(1))
    });
  }

  /**
   * Call every frame with the player's world position. Picks at most one
   * refinement every 250 ms and never runs two at once.
   */
  update(playerWorld: Vector3, nowMs: number): void {
    if (this.inFlight || nowMs - this.lastPickMs < this.refineIntervalMs) return;
    this.lastPickMs = nowMs;
    const p = _ecef.set(playerWorld.x, playerWorld.y - this.shiftY, playerWorld.z).applyMatrix4(this.worldToEcef);

    // If approaching tile capacity, evict the farthest tile beyond the fog horizon
    if (this.tiles.length >= this.maxTiles) {
      let farthest: LoadedTile | null = null;
      let farthestD = 0;
      for (const t of this.tiles) {
        const d = nodeDistM(t.node, p);
        if (d > farthestD) {
          farthestD = d;
          farthest = t;
        }
      }
      if (farthest && farthestD > FOG_HORIZON_M) {
        this.remove(farthest);
      } else {
        return;
      }
    }

    const candidates: LoadedTile[] = [];
    for (const t of this.tiles) {
      if (t.done) continue;
      const d = nodeDistM(t.node, p);
      if ((t.node.geometricError ?? 0) > allowedErrorM(d, this.lod)) {
        candidates.push(t);
      }
    }
    if (candidates.length === 0) return;
    candidates.sort((a, b) => nodeDistM(a.node, p) - nodeDistM(b.node, p));
    const batch = candidates.slice(0, this.refineBatchSize);

    this.inFlight = true;
    Promise.all(batch.map(tile => this.refine(tile).catch(e => {
      noteFailure('refine failed', e);
      tile.done = true;
    }))).finally(() => {
      this.inFlight = false;
    });
  }

  /**
   * The rasters behind the current colliders, structured-cloneable — the
   * offline measurement rigs (scripts/capture-rasters.mjs) read these to
   * reproduce the classifier's exact inputs without a live session.
   */
  captureRasters(): { grid: Grid; terrainTop: Float32Array; rasters: (TileRaster | null)[]; roadMask: Uint8Array | null } {
    return {
      grid: this.grid,
      terrainTop: this.terrainTop,
      rasters: this.tiles.map(t => t.raster),
      roadMask: this.roadGrid?.mask ?? null
    };
  }

  /** Rebuild building colliders from the current tiles, on this thread (~30 ms for a city). */
  colliders(): BuildingCollider[] {
    this.dirty = false;
    const th = thresholdsForMode(this.currentExperiment);
    return collidersFromRasters(
      this.tiles.map(t => t.raster),
      this.grid,
      this.terrainTop,
      this.reliefBoost,
      this.deckGrid,
      th,
      this.structureGrid,
      this.roadGrid,
      this.topGrid
    );
  }

  private worker: Worker | null = null;

  /**
   * The same rebuild in a worker, for the streaming loop: the frame pays a
   * clone of the rasters, not the pass. Falls back to the sync pass where
   * workers do not exist (tests).
   */
  collidersAsync(): Promise<BuildingCollider[]> {
    if (typeof Worker === 'undefined') return Promise.resolve(this.colliders());
    this.dirty = false;
    const worker = this.worker ??= new Worker(new URL('./colliderWorker.ts', import.meta.url), { type: 'module' });
    const th = thresholdsForMode(this.currentExperiment);
    return new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<ColliderResult>) => {
        this.deckGrid.set(e.data.deckGrid);
        this.structureGrid.set(e.data.structureGrid);
        this.topGrid.set(e.data.topGrid);
        resolve(e.data.boxes.map(b => ({
          min: new Vector3(b.min.x, b.min.y, b.min.z),
          max: new Vector3(b.max.x, b.max.y, b.max.z)
        })));
      };
      worker.onerror = e => reject(new Error(e.message));
      const job: ColliderJob = {
        rasters: this.tiles.map(t => t.raster), grid: this.grid, terrainTop: this.terrainTop, reliefBoost: this.reliefBoost,
        roadMask: this.roadGrid?.mask ?? null,
        thresholds: th
      };
      worker.postMessage(job);
    });
  }

  dispose(): void {
    if (this.roadRetryTimer) clearTimeout(this.roadRetryTimer);
    this.roadRetryTimer = null;
    for (const t of this.tiles) disposeTiles(t.group);
    this.tiles.length = 0;
    this.group.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private async loadChild(tile: CollectedTile): Promise<LoadedTile | null> {
    let g: Group | null = null;
    try {
      g = await loadTileGlb(tile, this.placement, this.apiKey, this.anisotropy);
    } catch (e) {
      noteFailure('parse failed', e);
    }
    if (!g) return null;
    this.onTileLoaded?.(g);
    return { ...tile, group: g, raster: rasterizeTile(g, this.grid), done: !tile.node.children?.length };
  }

  private async add(tile: CollectedTile): Promise<LoadedTile | null> {
    const loaded = await this.loadChild(tile);
    if (!loaded) return null;
    this.group.add(loaded.group);
    this.tiles.push(loaded);
    this.dirty = true;
    return loaded;
  }

  private remove(tile: LoadedTile): void {
    this.group.remove(tile.group);
    disposeTiles(tile.group);
    const i = this.tiles.indexOf(tile);
    if (i >= 0) this.tiles.splice(i, 1);
    this.dirty = true;
  }

  /** Replace a tile with its children; on any failure keep the parent intact. */
  private async refine(tile: LoadedTile): Promise<void> {
    tile.done = true;
    const kids = await nextLevel(tile.node, tile.session, this.apiKey);
    if (kids.length === 0) return;
    const loaded = await Promise.all(kids.map(k => this.loadChild(k)));
    if (loaded.some(l => l === null)) {
      for (const l of loaded) {
        if (l) disposeTiles(l.group);
      }
      return;
    }
    // Atomic swap: remove parent and add children in the exact same frame
    // so parent and child meshes never co-exist in the scene fighting/flickering
    this.group.remove(tile.group);
    disposeTiles(tile.group);
    const i = this.tiles.indexOf(tile);
    if (i >= 0) this.tiles.splice(i, 1, ...(loaded as LoadedTile[]));
    for (const l of loaded as LoadedTile[]) {
      this.group.add(l.group);
    }
    this.dirty = true;
  }
}

export interface LoadTilesOptions {
  readonly lat: number;
  readonly lon: number;
  readonly apiKey: string;
  readonly terrain: TerrainProvider;
  /** Renderer max anisotropy for tile textures. */
  readonly anisotropy?: number;
  readonly resolutionMode?: Resolution3DMode;
  readonly onProgress?: (loaded: number, total: number) => void;
}

/** Load the tiles around the match center; the returned streamer keeps refining. */
export async function load3DTiles(opts: LoadTilesOptions): Promise<TileStreamer> {
  const { lat, lon, apiKey, terrain } = opts;
  failures.clear();
  const startedAt = Date.now();
  const root = await fetchTilesRoot(apiKey);
  // datum altitude puts the tile ground at world y≈0 alongside the terrain mesh
  const ecef0 = latLonToEcef(lat, lon, terrain.datumAltM);
  const streamer = new TileStreamer(
    apiKey,
    terrain,
    { lat, lon },
    ecef0,
    opts.anisotropy ?? 1,
    opts.resolutionMode ?? 'balanced'
  );
  await streamer.loadInitial(root.root ?? root, opts.onProgress);
  const tally = Object.fromEntries(failures);
  const summary = { tiles: streamer.tileCount, ms: Date.now() - startedAt, lat, lon, ...tally };
  if (failures.size > 0) log.warn('tiles loaded with failures', summary);
  else log.info('tiles loaded', summary);
  return streamer;
}
