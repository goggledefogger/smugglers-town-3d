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

export async function fetchSatellite(
  lat: number,
  lon: number,
  apiKey: string,
  scale = 2
): Promise<HTMLCanvasElement> {
  // Stitch a 3x3 grid of Static Maps satellite tiles into one contiguous canvas using
  // exact Web Mercator pixel alignment.
  // Each tile is 640x640 at zoom 15. In Web Mercator pixel space, neighboring tiles
  // are separated by EXACTLY 640 pixels, guaranteeing 0-pixel gap and 0-pixel overlap.
  const TILE = 640, GRID = 3, zoom = 15;
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
      rej(new Error('Satellite image request timed out (check Static Maps API enabled)'));
    }, 10000);
    img.onload = () => {
      clearTimeout(timer);
      res(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      rej(new Error('satellite tile load failed (check Static Maps API enabled)'));
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
      rowPromises.push(loadImg(satelliteUrl(tileLat, tileLon, apiKey, zoom, TILE, TILE, scale)));
    }
    const imgs = await Promise.all(rowPromises);
    for (let c = 0; c < GRID; c++) ctx.drawImage(imgs[c]!, c * tilePx, r * tilePx, tilePx, tilePx);
  }

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

