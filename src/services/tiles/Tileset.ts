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
import { Matrix4, Vector3, Group, type Object3D, type Mesh, type Material, type Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { tileTransformChain } from '../../core/geo/projection.ts';
import { latLonToEcef, WORLD_M_PER_M, type Ecef, type GeoOrigin } from '../../core/geo/ecef.ts';
import type { BuildingCollider } from '../../core/physics/VehicleBody.ts';
import type { TerrainProvider } from '../../core/terrain/TerrainProvider.ts';
import {
  gridFor, sampleTerrain, rasterizeTile, collidersFromRasters, tileGroundOffset,
  type Grid, type TileRaster
} from './tileColliders.ts';

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
 * of 16.05, 32.1, 64.2 m (525957 m halved per level), so the clamps sit just
 * above them. 16 m tiles within 640 m, 32 m out to 1.3 km, 64 m beyond:
 * ~85 tiles, ~20 MB for a downtown.
 */
export const DEFAULT_LOD: LodPolicy = { minErrorM: 20, maxErrorM: 70, errorPerMeter: 1 / 20 };
/** Streaming, relative to the player: 8 m tiles within 360 m, 16 m to 640 m, 32 m to 1.3 km. */
export const STREAM_LOD: LodPolicy = { minErrorM: 9, maxErrorM: 70, errorPerMeter: 1 / 40 };

/** The field is 840 units = 5.6 km across; 4 km reaches its corners. */
const LOAD_RADIUS_M = 4000;
/** Initial-load cap; the closest win. */
const MAX_INITIAL_TILES = 150;
/**
 * Streaming stops adding detail past this many tiles (~1 MB of GPU each).
 * ponytail: no coarsening; evict the farthest tiles first if memory bites
 */
const MAX_TILES = 250;
const CONCURRENCY = 6;
/** After calibration the tile ground sits this far (world units) under the satellite drape. */
const TILE_GROUND_GAP = 0.6;
const TILE_BASE = 'https://tile.googleapis.com';
const gltfLoader = new GLTFLoader();
// glTF is Y-up, 3D Tiles content is Z-up ECEF: rotate +90° about X (y→z, z→−y)
const GLTF_TO_ECEF = new Matrix4().makeRotationX(Math.PI / 2);

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

export async function fetchTilesRoot(apiKey: string): Promise<TilesetRoot> {
  const res = await fetch(TILE_BASE + '/v1/3dtiles/root', { headers: { 'X-Goog-Api-Key': apiKey } });
  if (!res.ok) throw new Error('3D tiles root HTTP ' + res.status);
  return res.json();
}

async function fetchSubTileset(url: string, apiKey: string): Promise<TilesetRoot | null> {
  try {
    const res = await fetch(url, { headers: { 'X-Goog-Api-Key': apiKey } });
    if (!res.ok) {
      console.warn('sub-tileset HTTP ' + res.status, uriPath(url).slice(-40));
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn('sub-tileset fetch threw', e);
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
  // GLTFLoader's own fetch can't set headers, so fetch the bytes ourselves
  let buf: ArrayBuffer;
  try {
    const res = await fetch(url, { headers: { 'X-Goog-Api-Key': apiKey } });
    if (!res.ok) {
      console.warn('tile HTTP ' + res.status, uriPath(url).slice(-40));
      return null;
    }
    buf = await res.arrayBuffer();
  } catch (e) {
    console.warn('tile fetch threw', e);
    return null;
  }
  const root = (await gltfLoader.parseAsync(buf, '')).scene;
  root.matrixAutoUpdate = false;
  root.matrix.copy(placement);
  root.matrixWorldNeedsUpdate = true;
  // the ground is seen at grazing angles from the chase cam; without
  // anisotropy the mip chain smears it into mush
  forEachMap(root, map => { map.anisotropy = anisotropy; });
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
  private readonly grid: Grid;
  private readonly terrainTop: Float32Array;
  private readonly reliefBoost: number;
  private readonly placement: Matrix4;
  private readonly worldToEcef: Matrix4;
  private inFlight = false;
  private lastPickMs = 0;
  private dirty = false;

  constructor(
    private readonly apiKey: string,
    terrain: TerrainProvider,
    origin: GeoOrigin,
    private readonly ecef0: Ecef,
    private readonly anisotropy = 1,
    private readonly lod: LodPolicy = STREAM_LOD
  ) {
    this.grid = gridFor(terrain.heightfield);
    this.terrainTop = sampleTerrain(this.grid, terrain.heightfield);
    this.reliefBoost = terrain.reliefBoost;
    this.placement = glbPlacement(origin, ecef0, terrain.reliefBoost);
    this.worldToEcef = tileTransformChain(new Matrix4(), origin, ecef0, terrain.reliefBoost).invert();
  }

  get tileCount(): number {
    return this.tiles.length;
  }

  /** True once tiles changed since the last `colliders()` call. */
  get collidersDirty(): boolean {
    return this.dirty;
  }

  async loadInitial(root: TileNode, onProgress?: (loaded: number, total: number) => void): Promise<void> {
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
    this.calibrateGround();
  }

  /** Shift every tile so the tile ground sits just under the satellite drape (see tileGroundOffset). */
  private calibrateGround(): void {
    const offset = tileGroundOffset(this.tiles.map(t => t.raster), this.grid, this.terrainTop);
    if (offset === null) return;
    this.group.position.y -= offset + TILE_GROUND_GAP;
    this.group.updateMatrixWorld(true);
    for (const t of this.tiles) t.raster = rasterizeTile(t.group, this.grid);
    this.dirty = true;
    console.info(`3D tiles: ground datum shifted ${(-(offset + TILE_GROUND_GAP) / WORLD_M_PER_M / this.reliefBoost).toFixed(1)} m`);
  }

  /**
   * Call every frame with the player's world position. Picks at most one
   * refinement every 250 ms and never runs two at once.
   */
  update(playerWorld: Vector3, nowMs: number): void {
    if (this.inFlight || nowMs - this.lastPickMs < 250 || this.tiles.length >= MAX_TILES) return;
    this.lastPickMs = nowMs;
    const p = _ecef.copy(playerWorld).applyMatrix4(this.worldToEcef);
    let best: LoadedTile | null = null;
    let bestD = Infinity;
    for (const t of this.tiles) {
      if (t.done) continue;
      const d = nodeDistM(t.node, p);
      if (d < bestD && (t.node.geometricError ?? 0) > allowedErrorM(d, this.lod)) {
        best = t;
        bestD = d;
      }
    }
    if (!best) return;
    const tile = best;
    this.inFlight = true;
    this.refine(tile)
      .catch(e => {
        console.warn('tile refine failed', e);
        tile.done = true;
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  /** Rebuild building colliders from the current tiles (~15 ms for a city). */
  colliders(): BuildingCollider[] {
    this.dirty = false;
    return collidersFromRasters(this.tiles.map(t => t.raster), this.grid, this.terrainTop, this.reliefBoost);
  }

  dispose(): void {
    for (const t of this.tiles) disposeTiles(t.group);
    this.tiles.length = 0;
    this.group.clear();
  }

  private async add(tile: CollectedTile): Promise<LoadedTile | null> {
    let g: Group | null = null;
    try {
      g = await loadTileGlb(tile, this.placement, this.apiKey, this.anisotropy);
    } catch (e) {
      console.warn('tile parse failed', e);
    }
    if (!g) return null;
    this.group.add(g);
    const loaded: LoadedTile = { ...tile, group: g, raster: rasterizeTile(g, this.grid), done: !tile.node.children?.length };
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
    const loaded = await Promise.all(kids.map(k => this.add(k)));
    if (loaded.some(l => l === null)) {
      for (const l of loaded) if (l) this.remove(l);
      return;
    }
    this.remove(tile);
  }
}

export interface LoadTilesOptions {
  readonly lat: number;
  readonly lon: number;
  readonly apiKey: string;
  readonly terrain: TerrainProvider;
  /** Renderer max anisotropy for tile textures. */
  readonly anisotropy?: number;
  readonly onProgress?: (loaded: number, total: number) => void;
}

/** Load the tiles around the match center; the returned streamer keeps refining. */
export async function load3DTiles(opts: LoadTilesOptions): Promise<TileStreamer> {
  const { lat, lon, apiKey, terrain } = opts;
  const root = await fetchTilesRoot(apiKey);
  // datum altitude puts the tile ground at world y≈0 alongside the terrain mesh
  const ecef0 = latLonToEcef(lat, lon, terrain.datumAltM);
  const streamer = new TileStreamer(apiKey, terrain, { lat, lon }, ecef0, opts.anisotropy ?? 1);
  await streamer.loadInitial(root.root ?? root, opts.onProgress);
  return streamer;
}
