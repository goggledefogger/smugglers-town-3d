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
import { tileCache } from '../tiles/TileCache.ts';
import { latLonToWorldPixel, type RoadRaster } from '../maps/MapsApi.ts';
import { worldToLl } from '../../core/geo/projection.ts';
import { EARTH_RADIUS_M, type GeoOrigin } from '../../core/geo/ecef.ts';

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
  cycleway: 5,
  pedestrian: 6,
  path: 5,
  track: 5
};

const NON_DRIVABLE_HIGHWAYS = new Set([
  'footway', 'steps', 'bridleway', 'corridor', 'platform'
]);

export function isDrivableWay(tags?: Record<string, string>): boolean {
  if (!tags) return false;
  const h = tags['highway'];
  if (!h) return false;
  if (tags['indoor'] === 'yes' || tags['tunnel'] === 'building_passage') return false;
  if (h === 'cycleway') return true;
  if (h === 'pedestrian') return tags['area'] !== 'yes';
  if (h === 'path' || h === 'track') {
    // Only paved multi-use or designated bicycle paths (e.g. river greenways, park loops)
    const bike = tags['bicycle'];
    const motor = tags['motor_vehicle'] ?? tags['vehicle'];
    const surface = tags['surface'] ?? '';
    const isPaved = /^(asphalt|paved|concrete|sett|cobblestone)/.test(surface);
    return bike === 'designated' || bike === 'yes' || motor === 'yes' || isPaved;
  }
  if (NON_DRIVABLE_HIGHWAYS.has(h)) return false;
  return true;
}

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

// Overpass is the fallback behind the Google road raster (docs/ROAD-MASK.md); public
// mirrors go down for hours at a time, so ask several run by different operators
// (overpass.osm.ch is Switzerland only: it answers any bbox with zero ways, which ended
// the search early, so it is not listed)
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
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
  timeoutMs = 60000
): Promise<{ east: number; north: number; widthM: number }[][] | null> {
  const { lat, lon, halfM } = input;
  const cacheKey = `${lat.toFixed(5)},${lon.toFixed(5)},${Math.round(halfM)}`;
  if (cacheKey === roadCache.key) return roadCache.polys;
  // Overpass is down for hours at a time: a place fetched once lives in the tile cache
  const stored = await readStoredRoads(cacheKey);
  if (stored) {
    roadCache.key = cacheKey;
    roadCache.polys = stored;
    return stored;
  }
  const dLat = (halfM / 111_320) * 1.05;
  const cosLat = Math.max(0.0001, Math.cos((lat * Math.PI) / 180));
  const dLon = (halfM / (111_320 * cosLat)) * 1.05;
  const bbox = `${(lat - dLat).toFixed(6)},${(lon - dLon).toFixed(6)},${(lat + dLat).toFixed(6)},${(lon + dLon).toFixed(6)}`;
  // Query drivable roadway and designated multi-use path classes; pure footways, stairs,
  // and indoor passages are filtered out by isDrivableWay so they do not punch holes through building atriums
  const query = `[out:json][timeout:25];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service|cycleway|pedestrian|path|track)"](${bbox});out geom tags;`;

  let data: OverpassResponse | null = null;
  // a downtown bbox takes a mirror 10-20 s on a good day
  const endpointTimeoutMs = Math.min(Math.floor(timeoutMs / OVERPASS_ENDPOINTS.length), 20000);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (typeof navigator === 'undefined') {
    headers['User-Agent'] = USER_AGENT;
  }
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), endpointTimeoutMs);
    try {
      const res = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
        signal: controller.signal,
        headers
      });
      if (!res.ok) {
        log.warn('overpass http ' + res.status, { endpoint });
        continue;
      }
      data = (await res.json()) as OverpassResponse;
      if (data) break;
    } catch (e) {
      log.warn('overpass fetch failed', { endpoint, error: String(e).slice(0, 120) });
    } finally {
      clearTimeout(timer);
    }
  }
  if (!data) return null;
  const ways = (data.elements ?? []).filter(el => el.type === 'way' && el.geometry && el.geometry.length >= 2 && isDrivableWay(el.tags));
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
  void tileCache.putJson(ROAD_CACHE_URL + cacheKey, out).catch(() => {});
  return out;
}

const roadCache: { key: string; polys: { east: number; north: number; widthM: number }[][] | null } = {
  key: '',
  polys: null
};

/** Synthetic URL the road polylines are filed under in the tile cache (CacheStorage keys are URLs). */
const ROAD_CACHE_URL = 'https://osm.local/roads/';

async function readStoredRoads(cacheKey: string): Promise<{ east: number; north: number; widthM: number }[][] | null> {
  try {
    const buf = await tileCache.getBuffer(ROAD_CACHE_URL + cacheKey);
    if (!buf) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(buf));
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

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
 * The same grid from the Google road raster (the primary source, see
 * docs/ROAD-MASK.md): a cell is road when any road pixel lies within
 * `reachSlackMultiplier` cells of its centre. Road widths come from the map
 * style's stroke weights, so the slack is the only knob left; the Overpass
 * path adds it to each way's tagged half-width the same way.
 */
export function rasterizeRoadRaster(
  rasters: RoadRaster | readonly RoadRaster[],
  grid: { cell: number; half: number; n: number },
  origin: { lat: number; lon: number },
  reachSlackMultiplier = 0.5
): RoadGrid {
  const { cell, half, n } = grid;
  const mask = new Uint8Array(n * n);
  const cosLat = Math.max(0.2, Math.cos((origin.lat * Math.PI) / 180));
  const layers = Array.isArray(rasters) ? rasters as readonly RoadRaster[] : [rasters as RoadRaster];
  for (const raster of layers) {
    const metersPerPx = (2 * Math.PI * EARTH_RADIUS_M * cosLat) / (256 * Math.pow(2, raster.zoom)) / raster.scale;
    const r = Math.max(1, Math.ceil((reachSlackMultiplier * cell) / metersPerPx));
    for (let j = 0; j < n; j++) {
      const cz = -half + (j + 0.5) * cell;
      for (let i = 0; i < n; i++) {
        if (mask[j * n + i]) continue;
        const cx = -half + (i + 0.5) * cell;
        const { lat, lon } = worldToLl(cx, cz, origin as GeoOrigin);
        const wp = latLonToWorldPixel(lat, lon, raster.zoom);
        const px = Math.round((wp.x - raster.left) * raster.scale);
        const py = Math.round((wp.y - raster.top) * raster.scale);
        if (px < -r || px >= raster.w + r || py < -r || py >= raster.h + r) continue;
        let hit = 0;
        for (let dy = -r; dy <= r && !hit; dy++) {
          const y = py + dy;
          if (y < 0 || y >= raster.h) continue;
          for (let dx = -r; dx <= r; dx++) {
            const x = px + dx;
            if (x < 0 || x >= raster.w) continue;
            if (raster.pixels[y * raster.w + x]) { hit = 1; break; }
          }
        }
        mask[j * n + i] = hit;
      }
    }
  }
  return { cell, half, n, mask };
}

/**
 * A cell is set when at least `minFraction` of its area lands on set raster
 * pixels (a `samples` x `samples` point grid per cell; Mercator is linear at
 * cell scale, so the samples are metre offsets from the projected centre).
 * The building footprint uses this: a block-edge cell whose centre is a metre
 * inside the building line but whose area is mostly street stays street, so
 * a 10 m grid cannot wall off a 12 m street between two exact outlines.
 */
export function rasterizeCoverage(
  raster: RoadRaster,
  grid: { cell: number; half: number; n: number },
  origin: { lat: number; lon: number },
  minFraction: number,
  samples = 4
): RoadGrid {
  const { cell, half, n } = grid;
  const mask = new Uint8Array(n * n);
  const cosLat = Math.max(0.2, Math.cos((origin.lat * Math.PI) / 180));
  const pxPerM = raster.scale / ((2 * Math.PI * EARTH_RADIUS_M * cosLat) / (256 * Math.pow(2, raster.zoom)));
  const need = Math.ceil(minFraction * samples * samples);
  for (let j = 0; j < n; j++) {
    const cz = -half + (j + 0.5) * cell;
    for (let i = 0; i < n; i++) {
      const cx = -half + (i + 0.5) * cell;
      const { lat, lon } = worldToLl(cx, cz, origin as GeoOrigin);
      const wp = latLonToWorldPixel(lat, lon, raster.zoom);
      const px = (wp.x - raster.left) * raster.scale;
      const py = (wp.y - raster.top) * raster.scale;
      if (px < -cell * pxPerM || px >= raster.w + cell * pxPerM || py < -cell * pxPerM || py >= raster.h + cell * pxPerM) continue;
      let hit = 0;
      for (let sy = 0; sy < samples; sy++) {
        const y = Math.round(py + ((sy + 0.5) / samples - 0.5) * cell * pxPerM);
        if (y < 0 || y >= raster.h) continue;
        for (let sx = 0; sx < samples; sx++) {
          const x = Math.round(px + ((sx + 0.5) / samples - 0.5) * cell * pxPerM);
          if (x < 0 || x >= raster.w) continue;
          if (raster.pixels[y * raster.w + x]) hit++;
        }
      }
      if (hit >= need) mask[j * n + i] = 1;
    }
  }
  return { cell, half, n, mask };
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
  grid: { cell: number; half: number; n: number },
  reachSlackMultiplier = 0.5
): RoadGrid {
  const { cell, half, n } = grid;
  const mask = new Uint8Array(n * n);
  // per-segment bounding box in cells, padded by the segment's half-width
  for (const pts of polylines) {
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k]!, b = pts[k + 1]!;
      const halfWidth = Math.max(a.widthM, b.widthM) / 2;
      const reach = halfWidth + cell * reachSlackMultiplier;
      // world Z = -north; stamp in grid space directly to skip the flip
      const ax = a.east, az = -a.north, bx = b.east, bz = -b.north;
      const minX = Math.min(ax, bx) - reach, maxX = Math.max(ax, bx) + reach;
      const minZ = Math.min(az, bz) - reach, maxZ = Math.max(az, bz) + reach;
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
          // slack: a quantised classifier cell straddles the
          // roadbed edge; better to exempt one extra borderline cell than
          // sever a corridor at its kerb
          if (distSq <= reach * reach) mask[j * n + i] = 1;
        }
      }
    }
  }
  return { cell, half, n, mask };
}
