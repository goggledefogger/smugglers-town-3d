/**
 * OpenStreetMap road centrelines: semantic ground truth for where streets are.
 *
 * The photogrammetry classifier re-derives street-vs-building from the surface
 * model alone, and its ground estimate is wrong by up to ~17 m at hill crests
 * (morphological opening error scales with curvature). No threshold or mask
 * change fixes that — the brief measured every variant trading connectivity
 * against real buildings roughly one for one. A road polyline is not derived
 * from the tiles at all, so it is the one input that can reconnect corridors
 * without paying for them with deleted buildings.
 *
 * Overpass is queried for every `highway=*` way around the match centre and
 * rasterized into the same 10 m grid the classifier runs on: each way stamps
 * its width in metres from the highway tag. The mask is best-effort like the
 * tiles themselves — a failed fetch means no mask and the pipeline behaves
 * exactly as before.
 */
import { logger } from '../../app/log.ts';

const log = logger('osm-roads');

/**
 * Way width in metres per highway class. The tag is OSM's own semantic; the
 * numbers are roadbed widths (kerb to kerb), not lane widths, so a street
 * between buildings stays clear with margin on both sides of the centreline.
 * `width=`/`lanes=` tags override these when present on a way.
 */
const HIGHWAY_WIDTH_M: Record<string, number> = {
  motorway: 26,
  trunk: 22,
  primary: 18,
  secondary: 16,
  tertiary: 14,
  residential: 12,
  unclassified: 12,
  living_street: 10,
  service: 8,
  pedestrian: 8,
  track: 5,
  footway: 3,
  path: 3,
  cycleway: 3,
  steps: 3
};

/** Fallback for tagged-but-unknown classes (motorway_link, road, busway...). */
const DEFAULT_WIDTH_M = 10;

interface OsmWay {
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  nodes?: number[];
}

interface OverpassResponse {
  elements?: (OsmWay & { type: string })[];
}

export interface RoadMaskInput {
  readonly lat: number;
  readonly lon: number;
  /** Half-extent of the square to cover, in real metres. */
  readonly halfM: number;
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
] as const;
// Kumi rate-limits requests without one (429); a meaningful UA is standard
// practice for OSM API consumers anyway
const USER_AGENT = 'smugglers-town-3d/0.1 (game map pipeline; github.com/goggledefogger)';

/**
 * Fetch driveable road geometry as dense polylines in local metres east/north
 * of (lat, lon). Returns null on any failure (network, rate limit, empty) —
 * callers treat that as "no mask". Success is cached for the session so
 * rematches at the same spot don't re-hit Overpass.
 */
export async function fetchRoadPolylines(
  input: RoadMaskInput,
  timeoutMs = 12000
): Promise<{ east: number; north: number; widthM: number }[][] | null> {
  const { lat, lon, halfM } = input;
  const cacheKey = `${lat.toFixed(5)},${lon.toFixed(5)},${Math.round(halfM)}`;
  if (cacheKey === roadCache.key) return roadCache.polys;
  const dLat = (halfM / 111_320) * 1.05;
  const cosLat = Math.max(0.0001, Math.cos((lat * Math.PI) / 180));
  const dLon = (halfM / (111_320 * cosLat)) * 1.05;
  const bbox = `${(lat - dLat).toFixed(6)},${(lon - dLon).toFixed(6)},${(lat + dLat).toFixed(6)},${(lon + dLon).toFixed(6)}`;
  // driveable + walkable streets alike: on Russian Hill even steps and
  // pedestrian ways sit between buildings, and a corridor is a corridor
  const query = `[out:json][timeout:25];way["highway"](${bbox});out geom tags;`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let data: OverpassResponse | null = null;
  try {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      let res: Response;
      try {
        res = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
        });
      } catch {
        continue;
      }
      if (!res.ok) {
        log.warn('overpass http ' + res.status, { endpoint });
        continue;
      }
      try {
        data = await res.json() as OverpassResponse;
        break;
      } catch (e) {
        log.warn('overpass json failed', { error: String(e).slice(0, 120) });
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!data) return null;
  const ways = (data.elements ?? []).filter(el => el.type === 'way' && el.geometry && el.geometry.length >= 2);
  if (ways.length === 0) {
    log.warn('overpass returned no highway ways', { bbox });
    return null;
  }

  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * cosLat;
  const out: { east: number; north: number; widthM: number }[][] = [];
  for (const w of ways) {
    const widthM = wayWidthM(w.tags);
    const pts: { east: number; north: number; widthM: number }[] = [];
    for (const g of w.geometry!) {
      pts.push({
        east: (g.lon - lon) * mPerDegLon,
        north: (g.lat - lat) * mPerDegLat,
        widthM
      });
    }
    out.push(pts);
  }
  log.info('osm roads fetched', { ways: out.length, bbox });
  roadCache.key = cacheKey;
  roadCache.polys = out;
  return out;
}

const roadCache: { key: string; polys: { east: number; north: number; widthM: number }[][] | null } = {
  key: '',
  polys: null
};

function wayWidthM(tags: Record<string, string> | undefined): number {
  if (!tags) return DEFAULT_WIDTH_M;
  const w = tags['width'];
  if (w) {
    const v = parseFloat(w);
    if (v > 0 && v < 60) return Math.max(v, 3);
  }
  const lanes = tags['lanes'];
  if (lanes) {
    const v = parseInt(lanes, 10);
    if (v > 0 && v < 12) return Math.max(v * 3.2 + 1, 3);
  }
  return HIGHWAY_WIDTH_M[tags['highway'] ?? ''] ?? DEFAULT_WIDTH_M;
}

export interface RoadGrid {
  readonly cell: number;
  readonly half: number;
  readonly n: number;
  /** n*n, 1 where a road corridor covers the cell centre. */
  readonly mask: Uint8Array;
}

/**
 * Stamp the polylines into the same grid the classifier runs on (cell centres
 * at -half + (i+0.5)*cell, matching TileRaster indexing). A segment covers a
 * cell when the distance from the cell centre to the segment is within the
 * way's half-width; a wide way whose centre misses a corner cell still covers
 * it through the neighbouring segment, so no per-cell gaps at corners.
 */
export function rasterizeRoads(
  polylines: readonly { east: number; north: number; widthM: number }[][],
  grid: { cell: number; half: number; n: number }
): RoadGrid {
  const { cell, half, n } = grid;
  const mask = new Uint8Array(n * n);
  // per-segment bounding box in cells, padded by the segment's half-width
  for (const pts of polylines) {
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k]!, b = pts[k + 1]!;
      const halfWidth = Math.max(a.widthM, b.widthM) / 2;
      // world Z = -north; stamp in grid space directly to skip the flip
      const ax = a.east, az = -a.north, bx = b.east, bz = -b.north;
      const minX = Math.min(ax, bx) - halfWidth, maxX = Math.max(ax, bx) + halfWidth;
      const minZ = Math.min(az, bz) - halfWidth, maxZ = Math.max(az, bz) + halfWidth;
      const i0 = Math.max(0, Math.floor((minX + half) / cell));
      const i1 = Math.min(n - 1, Math.floor((maxX + half) / cell));
      const j0 = Math.max(0, Math.floor((minZ + half) / cell));
      const j1 = Math.min(n - 1, Math.floor((maxZ + half) / cell));
      if (i1 < 0 || j1 < 0 || i0 > n - 1 || j0 > n - 1) continue;
      const dx = bx - ax, dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      for (let j = j0; j <= j1; j++) {
        const cz = -half + (j + 0.5) * cell;
        for (let i = i0; i <= i1; i++) {
          const cx = -half + (i + 0.5) * cell;
          let distSq: number;
          if (lenSq < 1e-9) {
            distSq = (cx - ax) * (cx - ax) + (cz - az) * (cz - az);
          } else {
            let t = ((cx - ax) * dx + (cz - az) * dz) / lenSq;
            t = Math.max(0, Math.min(1, t));
            const px = ax + t * dx, pz = az + t * dz;
            distSq = (cx - px) * (cx - px) + (cz - pz) * (cz - pz);
          }
          // +1 cell slack: a 10 m quantised classifier cell straddles the
          // roadbed edge; better to exempt one extra borderline cell than
          // sever a corridor at its kerb
          const reach = halfWidth + cell * 0.5;
          if (distSq <= reach * reach) mask[j * n + i] = 1;
        }
      }
    }
  }
  return { cell, half, n, mask };
}
