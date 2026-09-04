/**
 * Google Maps JS API access, lazily loaded on first use.
 *
 * The JS API (not raw REST) is used because it handles its own cross-origin
 * auth — raw REST fetches lack CORS headers (Elevation REST sends none), so
 * the browser blocks them with a generic "Failed to fetch".
 */
import type { ElevationGrid } from '../../core/terrain/RealTerrain.ts';

declare global {
  interface Window {
    google?: typeof google;
    __gmapsCb?: () => void;
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
    window[cb] = () => resolve();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&callback=${cb}`;
    s.onerror = () => reject(new Error(
      'Could not load Google Maps JS API — check that Maps JavaScript API is enabled for your key.'
    ));
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
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address: query }, (results, status) => {
      if (status === 'OK' && results && results.length > 0) resolve(results[0]!);
      else reject(new Error('Geocode failed: ' + status));
    });
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
      const la = lat - dlat + (j / (N - 1)) * spanDeg;
      const lo = lon - dlon + (i / (N - 1)) * spanDeg * 2 * cosLat;
      all.push(new google.maps.LatLng(la, lo));
    }
  }
  const elevator = new google.maps.ElevationService();
  const samples: number[] = new Array(all.length).fill(0);
  const CHUNK = 500;
  for (let s = 0; s < all.length; s += CHUNK) {
    const chunk = all.slice(s, s + CHUNK);
    const part = await new Promise<google.maps.ElevationResult[]>((resolve, reject) => {
      elevator.getElevationForLocations({ locations: chunk }, (res, status) => {
        if (status === 'OK' && res) resolve(res);
        else reject(new Error(`Elevation failed: ${status} (chunk ${s / CHUNK})`));
      });
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

export async function fetchSatellite(
  lat: number,
  lon: number,
  apiKey: string,
  scale = 2
): Promise<HTMLCanvasElement> {
  // Stitch a grid of Static Maps satellite tiles into one high-res canvas.
  // With scale=2, a 3x3 grid of 640x640 requests yields 1280x1280 px per tile
  // (3840x3840 canvas total) over ~5.5km, providing ~1.46m/px sharp ground
  // detail without consuming any additional API quota.
  // Static Maps returns access-control-allow-origin: *, so an <img> with
  // crossOrigin='anonymous' stays untainted and uploads cleanly as a GL texture.
  const TILE = 640, GRID = 3, zoom = 15;
  const tilePx = TILE * scale;
  const spanDeg = 0.05;
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const dlat = spanDeg / 2;
  const dlon = spanDeg / 2 / cosLat;
  const canvas = document.createElement('canvas');
  canvas.width = tilePx * GRID;
  canvas.height = tilePx * GRID;
  const ctx = canvas.getContext('2d')!;

  const loadImg = (url: string): Promise<HTMLImageElement> => new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('satellite tile load failed (check Static Maps API enabled)'));
    img.src = url;
  });

  // fetch tiles row by row (limits concurrency)
  for (let r = 0; r < GRID; r++) {
    const rowPromises: Promise<HTMLImageElement>[] = [];
    for (let c = 0; c < GRID; c++) {
      const la = lat + dlat - (r / (GRID - 1)) * spanDeg;
      const lo = lon - dlon + (c / (GRID - 1)) * spanDeg * 2 * cosLat;
      rowPromises.push(loadImg(satelliteUrl(la, lo, apiKey, zoom, TILE, TILE, scale)));
    }
    const imgs = await Promise.all(rowPromises);
    for (let c = 0; c < GRID; c++) ctx.drawImage(imgs[c]!, c * tilePx, r * tilePx, tilePx, tilePx);
  }
  return canvas;
}

