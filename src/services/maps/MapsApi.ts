/**
 * Google Maps JS API access, lazily loaded on first use.
 *
 * The JS API (not raw REST) is used because it handles its own cross-origin
 * auth — raw REST fetches lack CORS headers (Elevation REST sends none), so
 * the browser blocks them with a generic "Failed to fetch".
 */
import type { ElevationGrid } from '../../core/terrain/RealTerrain.ts';
import { EARTH_RADIUS_M } from '../../core/geo/ecef.ts';

declare global {
  interface Window {
    google?: typeof google;
    __gmapsCb?: () => void;
    gm_authFailure?: () => void;
  }
}

let mapsApiPromise: Promise<void> | null = null;

/**
 * The key binds at script load and the API cannot be reloaded with a different
 * one, so the first successful load wins for the life of the page. A *failed*
 * load must not stick, though: the usual cause is a bad key, and the whole
 * point of the lobby's CHECK button is pasting a better one and trying again.
 */
export function loadMapsApi(apiKey: string): Promise<void> {
  if (window.google?.maps) return Promise.resolve();
  if (mapsApiPromise) return mapsApiPromise;
  const load = new Promise<void>((resolve, reject) => {
    const cb = '__gmapsCb';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Google Maps JS API load timed out. Check your network or API key.'));
    }, 10000);

    window[cb] = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    window.gm_authFailure = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(
        'Google Maps authentication failed (InvalidKeyMapError). Check that your API key is valid (starts with AIzaSy) and Maps JavaScript API is enabled.'
      ));
    };

    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&callback=${cb}`;
    s.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(
        'Could not load Google Maps JS API — check that Maps JavaScript API is enabled for your key.'
      ));
    };
    document.head.appendChild(s);
  });
  mapsApiPromise = load.catch((err: unknown) => {
    mapsApiPromise = null;
    throw err;
  });
  return mapsApiPromise;
}

export async function geocode(query: string): Promise<google.maps.GeocoderResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Geocoding timed out. Check that your Google Maps API key is valid and Geocoding API is enabled.'));
    }, 8000);
    try {
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ address: query }, (results, status) => {
        clearTimeout(timer);
        if (status === 'OK' && results && results.length > 0) resolve(results[0]!);
        else reject(new Error('Geocode failed: ' + status));
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

export async function fetchElevationGrid(lat: number, lon: number): Promise<ElevationGrid> {
  // 64x64 = 4096 samples in batches that respect the ElevationService
  // 512-locations-per-call limit. Lat/lon map to world units with a true
  // equirectangular projection.
  const N = 64;
  const spanDeg = 0.05;
  const dlat = spanDeg / 2;
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const dlon = spanDeg / 2 / cosLat;
  const all: google.maps.LatLng[] = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const la = lat + dlat - (j / (N - 1)) * spanDeg;
      const lo = lon - dlon + (i / (N - 1)) * (dlon * 2);
      all.push(new google.maps.LatLng(la, lo));
    }
  }
  const elevator = new google.maps.ElevationService();
  const samples: number[] = new Array(all.length).fill(0);
  const CHUNK = 500;
  for (let s = 0; s < all.length; s += CHUNK) {
    const chunk = all.slice(s, s + CHUNK);
    const part = await new Promise<google.maps.ElevationResult[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Elevation request timed out (chunk ${s / CHUNK}). Check Elevation API is enabled.`));
      }, 8000);
      try {
        elevator.getElevationForLocations({ locations: chunk }, (res, status) => {
          clearTimeout(timer);
          if (status === 'OK' && res) resolve(res);
          else reject(new Error(`Elevation failed: ${status} (chunk ${s / CHUNK})`));
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
    for (let k = 0; k < part.length; k++) samples[s + k] = part[k]!.elevation;
  }
  return { samples, gridN: N };
}

/** A Static Maps satellite image URL. The one place that spells this endpoint. */
export function satelliteUrl(
  lat: number, lon: number, apiKey: string, zoom: number, width: number, height: number, scale = 2
): string {
  return 'https://maps.googleapis.com/maps/api/staticmap'
    + `?center=${lat},${lon}&zoom=${zoom}&size=${width}x${height}&scale=${scale}`
    + `&maptype=satellite&key=${encodeURIComponent(apiKey)}`;
}

/** Converts (lat, lon) in degrees to Web Mercator world pixel coordinate at zoom Z. */
export function latLonToWorldPixel(latDeg: number, lonDeg: number, zoom: number): { x: number; y: number } {
  const mapSize = 256 * Math.pow(2, zoom);
  const x = ((lonDeg + 180) / 360) * mapSize;
  const sinLat = Math.sin((latDeg * Math.PI) / 180);
  const clampedSin = Math.max(-0.9999, Math.min(0.9999, sinLat));
  const y = (0.5 - Math.log((1 + clampedSin) / (1 - clampedSin)) / (4 * Math.PI)) * mapSize;
  return { x, y };
}

/** Converts Web Mercator world pixel coordinate at zoom Z back to (lat, lon) in degrees. */
export function worldPixelToLatLon(x: number, y: number, zoom: number): { lat: number; lon: number } {
  const mapSize = 256 * Math.pow(2, zoom);
  const lon = (x / mapSize) * 360 - 180;
  const yFrac = 0.5 - y / mapSize;
  const latRad = 2 * Math.atan(Math.exp(yFrac * 2 * Math.PI)) - Math.PI / 2;
  const lat = (latRad * 180) / Math.PI;
  return { lat, lon };
}

/**
 * A Static Maps roadmap styled down to the road network alone: white road
 * fills on black, everything else (labels, water, parks, transit, borders)
 * hidden. Thresholded, that image is a road mask; see docs/ROAD-MASK.md for
 * why this replaced Overpass. Weights are stroke widths in map pixels at
 * scale 1 (zoom 15 downtown is about 3.8 m per pixel), so a highway is drawn
 * about 23 m wide, an arterial 15 m, a local street 11 m.
 */
export function roadsUrl(
  lat: number, lon: number, apiKey: string, zoom: number, width: number, height: number, scale = 1
): string {
  const styles = [
    'feature:all|element:labels|visibility:off',
    'feature:all|element:geometry|color:0x000000',
    'feature:administrative|visibility:off',
    'feature:poi|visibility:off',
    'feature:transit|visibility:off',
    'feature:landscape|element:geometry|color:0x000000',
    'feature:water|element:geometry|color:0x000000',
    'feature:road|element:geometry.stroke|visibility:off',
    'feature:road|element:geometry.fill|visibility:on|color:0xffffff|weight:3',
    'feature:road.arterial|element:geometry.fill|weight:4',
    'feature:road.highway|element:geometry.fill|weight:6'
  ];
  return 'https://maps.googleapis.com/maps/api/staticmap'
    + `?center=${lat},${lon}&zoom=${zoom}&size=${width}x${height}&scale=${scale}&maptype=roadmap`
    + styles.map(s => '&style=' + encodeURIComponent(s)).join('')
    + `&key=${encodeURIComponent(apiKey)}`;
}

/** A stitched 3x3 grid of Static Maps tiles; `left`/`top` are the canvas origin in Web Mercator world pixels at `zoom`. */
export interface StaticGrid {
  readonly canvas: HTMLCanvasElement;
  readonly zoom: number;
  readonly scale: number;
  readonly left: number;
  readonly top: number;
}

/**
 * Stitch a 3x3 grid of 640 px Static Maps tiles at zoom 15 into one canvas
 * using exact Web Mercator pixel alignment: neighbouring tile centres are
 * exactly 640 world pixels apart, so there is no gap and no overlap. About
 * 7 km across downtown, covering the 5.6 km field.
 */
export async function fetchStaticGrid(
  lat: number,
  lon: number,
  scale: number,
  urlFor: (tileLat: number, tileLon: number) => string,
  what = 'Static Maps',
  zoom = 15
): Promise<StaticGrid> {
  const TILE = 640, GRID = 3;
  const tilePx = TILE * scale;
  const centerPix = latLonToWorldPixel(lat, lon, zoom);

  const canvas = document.createElement('canvas');
  canvas.width = tilePx * GRID;
  canvas.height = tilePx * GRID;
  const ctx = canvas.getContext('2d')!;

  const loadImg = (url: string): Promise<HTMLImageElement> => new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => {
      img.src = '';
      rej(new Error(`${what} image request timed out (check Static Maps API enabled)`));
    }, 10000);
    img.onload = () => {
      clearTimeout(timer);
      res(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      rej(new Error(`${what} tile load failed (check Static Maps API enabled)`));
    };
    img.src = url;
  });

  // fetch tiles row by row using exact Web Mercator tile centers
  for (let r = 0; r < GRID; r++) {
    const rowPromises: Promise<HTMLImageElement>[] = [];
    for (let c = 0; c < GRID; c++) {
      const tilePixX = centerPix.x + (c - 1) * TILE;
      const tilePixY = centerPix.y + (r - 1) * TILE;
      const { lat: tileLat, lon: tileLon } = worldPixelToLatLon(tilePixX, tilePixY, zoom);
      rowPromises.push(loadImg(urlFor(tileLat, tileLon)));
    }
    const imgs = await Promise.all(rowPromises);
    for (let c = 0; c < GRID; c++) ctx.drawImage(imgs[c]!, c * tilePx, r * tilePx, tilePx, tilePx);
  }
  return { canvas, zoom, scale, left: centerPix.x - 1.5 * TILE, top: centerPix.y - 1.5 * TILE };
}

/** The road network around (lat, lon) as a 1-bit raster: 1 = road, from the styled roadmap. */
export interface RoadRaster {
  readonly pixels: Uint8Array;
  readonly w: number;
  readonly h: number;
  readonly zoom: number;
  readonly scale: number;
  /** canvas origin in Web Mercator world pixels at `zoom` */
  readonly left: number;
  readonly top: number;
}

async function fetchRoadRaster(lat: number, lon: number, apiKey: string, zoom: number): Promise<RoadRaster> {
  const g = await fetchStaticGrid(lat, lon, 1, (la, lo) => roadsUrl(la, lo, apiKey, zoom, 640, 640, 1), 'Roads', zoom);
  const { width: w, height: h } = g.canvas;
  const data = g.canvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const pixels = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) pixels[i] = data[i * 4]! > 128 ? 1 : 0;
  // every tile carries the Google logo bottom-left and the attribution text bottom-right,
  // white on our black style, which would threshold into a few false road cells
  const TILE = 640;
  for (let ty = TILE - 1; ty < h; ty += TILE) {
    for (let y = ty - 30; y <= ty; y++) {
      for (let tx = 0; tx < w; tx += TILE) {
        pixels.fill(0, y * w + tx, y * w + tx + 90);
        pixels.fill(0, y * w + tx + TILE - 170, y * w + tx + TILE);
      }
    }
  }
  return { pixels, w, h, zoom: g.zoom, scale: g.scale, left: g.left, top: g.top };
}

/**
 * Two layers: zoom 15 covers the whole 5.6 km field with the streets Google
 * draws at that scale; zoom 16 covers the inner 3.6 km and adds the alleys and
 * service roads it only draws closer in. A cell is road if either says so.
 */
export async function fetchRoadRasters(lat: number, lon: number, apiKey: string): Promise<RoadRaster[]> {
  if (typeof document === 'undefined') throw new Error('road raster needs a browser canvas');
  return Promise.all([fetchRoadRaster(lat, lon, apiKey, 15), fetchRoadRaster(lat, lon, apiKey, 16)]);
}

export async function fetchSatellite(
  lat: number,
  lon: number,
  apiKey: string,
  scale = 2
): Promise<HTMLCanvasElement> {
  const zoom = 15;
  const { canvas } = await fetchStaticGrid(lat, lon, scale, (la, lo) => satelliteUrl(la, lo, apiKey, zoom, 640, 640, scale), 'Satellite');
  const tilePx = 640 * scale, GRID = 3;

  // Crop the stitched canvas to match the exact 5600m x 5600m world bounds centered at (lat, lon)
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const mercatorMetersPerPx = (2 * Math.PI * EARTH_RADIUS_M * cosLat) / (256 * Math.pow(2, zoom));
  const canvasPixelsPerMeter = scale / mercatorMetersPerPx;
  const fieldSpanCanvasPx = 5600 * canvasPixelsPerMeter;

  const totalPx = tilePx * GRID;
  const canvasCenterX = totalPx / 2;
  const canvasCenterY = totalPx / 2;
  const cropSize = Math.min(totalPx, fieldSpanCanvasPx);
  const cropX = Math.max(0, canvasCenterX - cropSize / 2);
  const cropY = Math.max(0, canvasCenterY - cropSize / 2);
  const cropW = Math.min(totalPx - cropX, cropSize);
  const cropH = Math.min(totalPx - cropY, cropSize);

  const outSize = Math.min(2560, Math.round(cropSize));
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outSize;
  outCanvas.height = outSize;
  const outCtx = outCanvas.getContext('2d')!;
  outCtx.drawImage(
    canvas,
    cropX, cropY, cropW, cropH,
    0, 0, outSize, outSize
  );

  return outCanvas;
}

