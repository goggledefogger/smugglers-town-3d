/**
 * Google Photorealistic 3D Tiles: root tileset traversal, GLB loading, and
 * world-space building collider extraction.
 *
 * Endpoint: https://tile.googleapis.com/v1/3dtiles/root
 * Auth: X-Goog-Api-Key header (CORS-confirmed). Session tokens are NOT used
 * for 3D tiles. Response is a 3D Tiles 1.0 tileset.json; child tiles are GLB
 * meshes referenced by root.content.uri (relative, on tile.googleapis.com).
 */
import { Matrix4, Box3, Group, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { tileTransformChain } from '../../core/geo/projection.ts';
import { latLonToEcef, type GeoOrigin } from '../../core/geo/ecef.ts';
import type { BuildingCollider } from '../../core/physics/VehicleBody.ts';

interface TileNode {
  boundingVolume?: {
    region?: [number, number, number, number, number, number];
    box?: number[];
  };
  transform?: number[];
  content?: { uri?: string };
  children?: TileNode[];
}

export interface TilesResult {
  readonly tileCount: number;
  readonly buildingCount: number;
  readonly tilesGroup: Group;
  readonly colliders: BuildingCollider[];
}

interface LatLonBox {
  w: number; e: number; s: number; n: number;
}

/**
 * Recursively walk the tile tree, collecting nodes whose region overlaps the
 * target lat/lon box and whose content.uri is a GLB.
 *
 * The 3D Tiles spec says region lat/lon are in RADIANS, but Google's
 * photorealistic tiles use DEGREES — detect by magnitude and normalize.
 */
export function collectTiles(node: TileNode | undefined, box: LatLonBox, out: TileNode[]): void {
  if (!node) return;
  const bv = node.boundingVolume;
  let inside = false;
  if (bv?.region) {
    let [w, s, e, n] = bv.region;
    // values > Pi indicate degrees (a radian longitude can't exceed ~3.14)
    if (Math.abs(w) <= Math.PI) {
      w *= 180 / Math.PI; s *= 180 / Math.PI; e *= 180 / Math.PI; n *= 180 / Math.PI;
    }
    if (e >= box.w && w <= box.e && n >= box.s && s <= box.n) inside = true;
  } else if (bv?.box) {
    inside = true; // aabb fallback — accept, later filtering handles it
  }
  if (!inside) return;
  if (node.content?.uri && /\.glb$/i.test(node.content.uri)) {
    out.push(node);
  }
  if (node.children) for (const c of node.children) collectTiles(c, box, out);
}

const gltfLoader = new GLTFLoader();
const TILE_BASE = 'https://tile.googleapis.com';

interface TilesetRoot extends TileNode {
  root?: TileNode;
}

export async function fetchTilesRoot(apiKey: string): Promise<TilesetRoot> {
  const res = await fetch('https://tile.googleapis.com/v1/3dtiles/root', {
    headers: { 'X-Goog-Api-Key': apiKey }
  });
  if (!res.ok) throw new Error('3D tiles root HTTP ' + res.status);
  return res.json();
}

export async function loadTileGlb(
  tile: TileNode,
  origin: GeoOrigin,
  reliefBoost: number,
  apiKey: string
): Promise<Group | null> {
  const uri = tile.content?.uri;
  if (!uri) return null;
  const url = uri.startsWith('http') ? uri : TILE_BASE + (uri.startsWith('/') ? '' : '/') + uri;
  // GLB fetch needs the API key header; GLTFLoader uses fetch under the
  // hood, so fetch the arraybuffer ourselves to set the header
  let buf: ArrayBuffer;
  try {
    const res = await fetch(url, { headers: { 'X-Goog-Api-Key': apiKey } });
    if (!res.ok) {
      console.warn('tile fetch HTTP ' + res.status + ' for', url);
      return null;
    }
    buf = await res.arrayBuffer();
  } catch (e) {
    console.warn('tile fetch threw for', url, e);
    return null;
  }
  const gltf = await gltfLoader.parseAsync(buf, '');
  const root = gltf.scene;
  const bv = tile.boundingVolume;
  const tileTf = new Matrix4();
  if (tile.transform && tile.transform.length === 16) {
    tileTf.fromArray(tile.transform);
  }
  if (bv?.region) {
    // Match center is world origin (0,0,0). The full chain:
    //   world = Scale(s, s*boost, s) * R(ecefToWorld) * Translate(-ecef0) * tileTf * p
    // — see tileTransformChain for why Translate(-ecef0) is load-bearing.
    const ecef0 = latLonToEcef(origin.lat, origin.lon, 0);
    root.matrixAutoUpdate = false;
    root.matrix.copy(tileTransformChain(tileTf, origin, ecef0, reliefBoost));
    root.matrixWorldNeedsUpdate = true;
  } else {
    root.matrixAutoUpdate = false;
    root.matrix.copy(tileTf);
  }
  return root;
}

/** Extract world-space AABBs from a tile's meshes — building detection. */
export function mineBuildingColliders(
  root: Object3D,
  existing: BuildingCollider[]
): number {
  root.updateMatrixWorld(true);
  const tmpBox = new Box3();
  let added = 0;
  root.traverse(obj => {
    const mesh = obj as { isMesh?: boolean; geometry?: { boundingBox: Box3 | null; computeBoundingBox(): void } };
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    tmpBox.copy(mesh.geometry.boundingBox!);
    tmpBox.applyMatrix4(obj.matrixWorld);
    const sy = tmpBox.max.y - tmpBox.min.y;
    // >= 2 world units tall counts as a building, not a road/ground plane
    if (sy >= 2) {
      existing.push({ min: tmpBox.min.clone(), max: tmpBox.max.clone() });
      added++;
    }
  });
  return added;
}

/** Load all tiles overlapping the box, with a small concurrency cap. */
export async function load3DTiles(
  lat: number,
  lon: number,
  reliefBoost: number,
  apiKey: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<TilesResult> {
  const tilesGroup = new Group();
  const colliders: BuildingCollider[] = [];
  const root = await fetchTilesRoot(apiKey);
  const span = 0.05;
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const box: LatLonBox = {
    w: lon - span * cosLat, e: lon + span * cosLat,
    s: lat - span / 2, n: lat + span / 2
  };
  const nodes: TileNode[] = [];
  const rootNode: TileNode = root.root ?? root;
  collectTiles(rootNode, box, nodes);
  const CONC = 6;
  let idx = 0;
  let loaded = 0;
  async function worker(): Promise<void> {
    while (idx < nodes.length) {
      const i = idx++;
      if (i >= nodes.length) break;
      const node = nodes[i]!;
      try {
        const g = await loadTileGlb(node, { lat, lon }, reliefBoost, apiKey);
        if (g) {
          tilesGroup.add(g);
          mineBuildingColliders(g, colliders);
        }
      } catch (e) {
        console.warn('tile load failed:', node.content?.uri, e);
      }
      loaded++;
      onProgress?.(loaded, nodes.length);
    }
  }
  const workers: Promise<void>[] = [];
  for (let k = 0; k < CONC; k++) workers.push(worker());
  await Promise.all(workers);
  return { tileCount: tilesGroup.children.length, buildingCount: colliders.length, tilesGroup, colliders };
}
