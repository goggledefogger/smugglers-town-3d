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

export function loadMapsApi(apiKey: string): Promise<void> {
  if (window.google?.maps) return Promise.resolve();
  if (mapsApiPromise) return mapsApiPromise;
  mapsApiPromise = new Promise((resolve, reject) => {
    const cb = '__gmapsCb';
    window[cb] = () => resolve();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&callback=${cb}`;
    s.onerror = () => reject(new Error(
      'Could not load Google Maps JS API — check that Maps JavaScript API is enabled for your key.'
    ));
    document.head.appendChild(s);
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

export async function fetchSatellite(lat: number, lon: number, apiKey: string): Promise<HTMLCanvasElement> {
  // Stitch a grid of Static Maps satellite tiles into one high-res canvas.
  // A single 640px image over ~5.5km is hopelessly blurry; a 3x3 grid at
  // zoom 15 keeps sharp detail. Static Maps returns
  // access-control-allow-origin: *, so an <img> with crossOrigin='anonymous'
  // stays untainted and uploads cleanly as a GL texture.
  const TILE = 640, GRID = 3, zoom = 15;
  const spanDeg = 0.05;
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const dlat = spanDeg / 2;
  const dlon = spanDeg / 2 / cosLat;
  const canvas = document.createElement('canvas');
  canvas.width = TILE * GRID;
  canvas.height = TILE * GRID;
  const ctx = canvas.getContext('2d')!;
  const loadImg = (url: string) => new Promise<HTMLImageElement>((res, rej) => {
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
      const url = `https://maps.googleapis.com/maps/api/staticmap?center=${la},${lo}&zoom=${zoom}&size=${TILE}x${TILE}&maptype=satellite&key=${encodeURIComponent(apiKey)}`;
      rowPromises.push(loadImg(url));
    }
    const imgs = await Promise.all(rowPromises);
    for (let c = 0; c < GRID; c++) ctx.drawImage(imgs[c]!, c * TILE, r * TILE, TILE, TILE);
  }
  return canvas;
}
