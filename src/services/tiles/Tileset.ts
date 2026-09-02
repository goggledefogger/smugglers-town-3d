/**
 * Google Photorealistic 3D Tiles: tree traversal, GLB placement, and
 * building-collider extraction.
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
import { latLonToEcef, type Ecef, type GeoOrigin } from '../../core/geo/ecef.ts';
import type { BuildingCollider } from '../../core/physics/VehicleBody.ts';
import type { Heightfield } from '../../core/heightfield.ts';
import type { TerrainProvider } from '../../core/terrain/TerrainProvider.ts';

export interface TileNode {
  boundingVolume?: { box?: number[] };
  geometricError?: number;
  content?: { uri?: string };
  children?: TileNode[];
}

interface TilesetRoot extends TileNode {
  root?: TileNode;
}

export interface TilesResult {
  readonly tileCount: number;
  readonly buildingCount: number;
  readonly tilesGroup: Group;
  readonly colliders: BuildingCollider[];
}

/** Level of detail: the geometricError accepted grows with distance from the match center. */
export interface LodPolicy {
  /** Finest error accepted (m), used near the center. */
  readonly minErrorM: number;
  /** Coarsest error accepted (m), used toward the load radius. */
  readonly maxErrorM: number;
  /** Error allowed per meter of distance, between the two clamps. */
  readonly errorPerMeter: number;
  /** Hard cap on GLB tiles; the closest win. */
  readonly maxTiles: number;
}

/**
 * Google's levels carry errors of 16.05, 32.1, 64.2 m (525957 m halved per
 * level), so the clamps sit just above them. 16 m tiles within 640 m, 32 m
 * out to 1.3 km, 64 m beyond: ~70 tiles, ~17 MB for a downtown.
 */
export const DEFAULT_LOD: LodPolicy = { minErrorM: 20, maxErrorM: 70, errorPerMeter: 1 / 20, maxTiles: 150 };

/** The field is 840 units = 5.6 km across; 4 km reaches its corners. */
const LOAD_RADIUS_M = 4000;
const CONCURRENCY = 6;
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

function nodeDistM(node: TileNode, ecef0: Ecef): number {
  const box = node.boundingVolume?.box;
  return box ? boxDistanceM(ecef0, box) : 0;
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
  lod: LodPolicy = DEFAULT_LOD
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
      const path = uri ? uriPath(uri) : '';
      if (uri && /\.json$/i.test(path)) {
        const sub = await fetchSubTileset(withSession(fullUrl(uri), session), apiKey);
        if (sub) next.push({ node: sub.root ?? sub, session: sessionOf(uri) ?? session, distM });
        return;
      }
      const fineEnough = (node.geometricError ?? 0) <= allowedErrorM(distM, lod) || !node.children?.length;
      if (uri && /\.glb$/i.test(path) && fineEnough) {
        tiles.push({ node, session, distM });
        return;
      }
      for (const c of node.children ?? []) next.push({ node: c, session, distM });
    }));
    frontier = next;
  }
  return tiles.sort((a, b) => a.distM - b.distM).slice(0, lod.maxTiles);
}

/**
 * World matrix for a Google GLB. There are no per-tile transforms, so one
 * matrix places every tile; the chain's Translate(-ecef0) is what keeps the
 * ~6.4M m ECEF node positions from projecting the earth radius onto Y.
 */
export function glbPlacement(origin: GeoOrigin, ecef0: Ecef, reliefBoost: number): Matrix4 {
  return tileTransformChain(new Matrix4(), origin, ecef0, reliefBoost).multiply(GLTF_TO_ECEF);
}

async function loadTileGlb(tile: CollectedTile, placement: Matrix4, apiKey: string): Promise<Group | null> {
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
  return root;
}

/**
 * Building colliders from streamed tiles. A tile is one merged mesh, so
 * per-mesh bounds are useless; instead stamp each triangle's top onto a
 * coarse height grid and call any cell rising `minRise` above the terrain a
 * building. Runs of building cells along X merge into one AABB each.
 * ponytail: row runs only (a few thousand boxes); merge rows too if
 * VehicleBody.resolveBuildings ever shows up in a profile
 */
export function buildingCollidersFrom(
  tiles: Object3D,
  ground: Heightfield,
  cellSize = 3,
  minRise = 4
): BuildingCollider[] {
  const half = ground.size / 2;
  const n = Math.ceil(ground.size / cellSize);
  const top = new Float32Array(n * n).fill(-Infinity);
  const p = new Vector3();
  tiles.updateMatrixWorld(true);
  tiles.traverse(obj => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.index;
    const triCount = (index ? index.count : pos.count) / 3;
    for (let t = 0; t < triCount; t++) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = -Infinity;
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
        p.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld);
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
        if (p.y > maxY) maxY = p.y;
      }
      if (maxX < -half || minX >= half || maxZ < -half || minZ >= half) continue;
      const i0 = Math.max(0, Math.floor((minX + half) / cellSize));
      const i1 = Math.min(n - 1, Math.floor((maxX + half) / cellSize));
      const j0 = Math.max(0, Math.floor((minZ + half) / cellSize));
      const j1 = Math.min(n - 1, Math.floor((maxZ + half) / cellSize));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const c = j * n + i;
          if (maxY > top[c]!) top[c] = maxY;
        }
      }
    }
  });

  const out: BuildingCollider[] = [];
  for (let j = 0; j < n; j++) {
    const z0 = -half + j * cellSize;
    const cz = z0 + cellSize / 2;
    let run: { i0: number; top: number; floor: number } | null = null;
    for (let i = 0; i <= n; i++) {
      let building = false;
      let cellTop = -Infinity;
      let floor = 0;
      if (i < n) {
        floor = ground.sample(-half + (i + 0.5) * cellSize, cz);
        cellTop = top[j * n + i]!;
        building = cellTop - floor >= minRise;
      }
      if (building) {
        if (run) {
          run.top = Math.max(run.top, cellTop);
          run.floor = Math.min(run.floor, floor);
        } else {
          run = { i0: i, top: cellTop, floor };
        }
      } else if (run) {
        out.push({
          min: new Vector3(-half + run.i0 * cellSize, run.floor - 1, z0),
          max: new Vector3(-half + i * cellSize, run.top, z0 + cellSize)
        });
        run = null;
      }
    }
  }
  return out;
}

export interface LoadTilesOptions {
  readonly lat: number;
  readonly lon: number;
  readonly apiKey: string;
  readonly terrain: TerrainProvider;
  readonly onProgress?: (loaded: number, total: number) => void;
  readonly lod?: LodPolicy;
}

/** Load the tiles around the match center and extract building colliders. */
export async function load3DTiles(opts: LoadTilesOptions): Promise<TilesResult> {
  const { lat, lon, apiKey, terrain } = opts;
  const root = await fetchTilesRoot(apiKey);
  // datum altitude puts the tile ground at world y≈0 alongside the terrain mesh
  const ecef0 = latLonToEcef(lat, lon, terrain.datumAltM);
  const tiles = await collectTiles(root.root ?? root, ecef0, LOAD_RADIUS_M, apiKey, opts.lod);
  const placement = glbPlacement({ lat, lon }, ecef0, terrain.reliefBoost);
  const tilesGroup = new Group();
  let next = 0;
  let loaded = 0;
  async function worker(): Promise<void> {
    while (next < tiles.length) {
      const tile = tiles[next++]!;
      try {
        const g = await loadTileGlb(tile, placement, apiKey);
        if (g) tilesGroup.add(g);
      } catch (e) {
        console.warn('tile parse failed', e);
      }
      opts.onProgress?.(++loaded, tiles.length);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const colliders = buildingCollidersFrom(tilesGroup, terrain.heightfield);
  return { tileCount: tilesGroup.children.length, buildingCount: colliders.length, tilesGroup, colliders };
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
