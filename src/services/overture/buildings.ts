/**
 * Building footprints with heights from Overture Maps, read straight from
 * the hosted PMTiles archive: a few zoom-14 vector tiles (about 1 MB each
 * downtown) cover the field, no key, no server of ours, CORS open. Polygons
 * are metre-exact (OpenStreetMap first, Microsoft and Google Open Buildings
 * roofprints where OSM has nothing) and most carry a height, so a building
 * can be drawn as the prism it is instead of a stack of 10 m cells.
 */
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { llToWorld, worldToLl } from '../../core/geo/projection.ts';
import { EARTH_RADIUS_M, type GeoOrigin } from '../../core/geo/ecef.ts';
import { latLonToWorldPixel, type RoadRaster } from '../maps/MapsApi.ts';

const OVERTURE_BUILDINGS_URL =
  'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-08-19.0/buildings.pmtiles';
const ZOOM = 14;
/** Storeys to metres when Overture has floors but no height. */
const FLOOR_M = 3.2;

export interface Footprint {
  readonly id: string;
  /** outer ring, world x,z pairs, closed (last == first) */
  readonly ring: number[];
  readonly holes: number[][];
  /** metres above the ground the roof sits, when Overture knows it */
  readonly height: number | null;
  /** metres above the ground the walls start (a tower part on a podium) */
  readonly minHeight: number;
  /** a building_part: drawn on top of its building */
  readonly part: boolean;
}

interface Origin { readonly lat: number; readonly lon: number }

let archive: PMTiles | null = null;

function tileRange(origin: Origin, halfM: number): { x0: number; x1: number; y0: number; y1: number } {
  const dLat = (halfM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.2, Math.cos((origin.lat * Math.PI) / 180));
  const n = 2 ** ZOOM;
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  return { x0: tx(origin.lon - dLon), x1: tx(origin.lon + dLon), y0: ty(origin.lat + dLat), y1: ty(origin.lat - dLat) };
}

function ringArea(r: number[]): number {
  let a = 0;
  for (let i = 0; i + 3 < r.length; i += 2) a += r[i]! * r[i + 3]! - r[i + 2]! * r[i + 1]!;
  return a / 2;
}

/** Point-in-polygon on a closed world x,z ring (even-odd). */
export function pointInRing(ring: number[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i]!, zi = ring[i + 1]!, xj = ring[j]!, zj = ring[j + 1]!;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Every building and building part within `halfM` of the origin, in world
 * metres. A polygon on a tile seam comes back clipped in both tiles; the
 * larger piece wins (a rare cut wall on the seam beats a doubled building).
 */
export async function fetchFootprints(origin: Origin, halfM: number): Promise<Footprint[]> {
  archive ??= new PMTiles(OVERTURE_BUILDINGS_URL);
  const { x0, x1, y0, y1 } = tileRange(origin, halfM);
  const jobs: Promise<{ x: number; y: number; data: ArrayBuffer } | null>[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      jobs.push(archive.getZxy(ZOOM, x, y).then(t => (t ? { x, y, data: t.data } : null)));
    }
  }
  const geo = origin as GeoOrigin;
  const best = new Map<string, { area: number; fp: Footprint }>();
  for (const t of await Promise.all(jobs)) {
    if (!t) continue;
    const vt = new VectorTile(new PbfReader(new Uint8Array(t.data)));
    for (const layerName of ['building', 'building_part']) {
      const layer = vt.layers[layerName];
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const p = f.properties;
        if (p.is_underground === true) continue;
        const g = f.toGeoJSON(t.x, t.y, ZOOM).geometry;
        const polys: number[][][][] = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        const height = typeof p.height === 'number' ? p.height
          : typeof p.num_floors === 'number' ? p.num_floors * FLOOR_M : null;
        const minHeight = typeof p.min_height === 'number' ? p.min_height
          : typeof p.min_floor === 'number' ? p.min_floor * FLOOR_M : 0;
        polys.forEach((poly, k) => {
          const rings = poly.map(r => {
            const out: number[] = [];
            for (const [lon, lat] of r as [number, number][]) {
              const w = llToWorld(lat, lon, 0, geo);
              out.push(w.x, w.z);
            }
            return out;
          });
          const ring = rings[0];
          if (!ring || ring.length < 8) return;
          let inField = false;
          for (let j = 0; j < ring.length && !inField; j += 2) {
            inField = Math.abs(ring[j]!) <= halfM && Math.abs(ring[j + 1]!) <= halfM;
          }
          if (!inField) return;
          const id = `${String(p.id ?? f.id ?? `${t.x}/${t.y}/${i}`)}#${k}`;
          const area = Math.abs(ringArea(ring));
          const prev = best.get(id);
          if (prev && prev.area >= area) return;
          best.set(id, { area, fp: { id, ring, holes: rings.slice(1), height, minHeight, part: layerName === 'building_part' } });
        });
      }
    }
  }
  return [...best.values()].map(v => v.fp);
}

/**
 * The same 1-bit footprint raster the Google outline fetch produces
 * (`MapsApi.fetchBuildingRaster`: zoom 17, a 6x6 grid of 640 px tiles centred
 * on the origin), drawn from the polygons instead, so the collider pass
 * needs no Static Maps request at all when Overture answers.
 */
export function footprintRasterFromPolygons(polys: readonly Footprint[], origin: Origin): RoadRaster {
  const zoom = 17, size = 6 * 640;
  const c = latLonToWorldPixel(origin.lat, origin.lon, zoom);
  const left = c.x - size / 2, top = c.y - size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#fff';
  const geo = origin as GeoOrigin;
  const trace = (ring: number[]): void => {
    for (let i = 0; i < ring.length; i += 2) {
      const { lat, lon } = worldToLl(ring[i]!, ring[i + 1]!, geo);
      const wp = latLonToWorldPixel(lat, lon, zoom);
      if (i === 0) ctx.moveTo(wp.x - left, wp.y - top);
      else ctx.lineTo(wp.x - left, wp.y - top);
    }
    ctx.closePath();
  };
  for (const p of polys) {
    if (p.part) continue;
    ctx.beginPath();
    trace(p.ring);
    for (const h of p.holes) trace(h);
    ctx.fill('evenodd');
  }
  const data = ctx.getImageData(0, 0, size, size).data;
  const pixels = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) pixels[i] = data[i * 4]! > 128 ? 1 : 0;
  return { pixels, w: size, h: size, zoom, scale: 1, left, top };
}
