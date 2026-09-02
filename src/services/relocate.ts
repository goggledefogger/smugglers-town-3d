/**
 * LocationRelocator: end-to-end relocation to a real place. Geocodes the
 * query, fetches elevation + satellite imagery, streams 3D building tiles,
 * and returns the new TerrainProvider.
 */
import { buildRealTerrain, type ElevationGrid } from '../core/terrain/RealTerrain.ts';
import { loadMapsApi, geocode, fetchElevationGrid, fetchSatellite } from './maps/MapsApi.ts';
import { load3DTiles, type TileStreamer } from './tiles/Tileset.ts';
import type { TerrainProvider } from '../core/terrain/TerrainProvider.ts';

export interface RelocateOptions {
  readonly query: string;
  readonly apiKey: string;
  /** Renderer max anisotropy for tile textures. */
  readonly anisotropy?: number;
  readonly onProgress: (message: string) => void;
}

export interface RelocateResult {
  readonly terrain: TerrainProvider;
  /** Null when 3D tiles failed; the terrain still loaded. */
  readonly tiles: TileStreamer | null;
}

export async function relocate(opts: RelocateOptions): Promise<RelocateResult> {
  const { query, apiKey, onProgress } = opts;
  onProgress('Loading Google Maps API');
  await loadMapsApi(apiKey);
  onProgress(`Geocoding "${query}"`);
  const r0 = await geocode(query);
  const lat = r0.geometry.location.lat();
  const lon = r0.geometry.location.lng();
  const label = r0.formatted_address;
  onProgress(`Fetching elevation grid for ${label}`);
  const grid: ElevationGrid = await fetchElevationGrid(lat, lon);
  onProgress('Fetching satellite imagery');
  const sat = await fetchSatellite(lat, lon, apiKey);
  const terrain = buildRealTerrain(label, grid, 420, sat);
  // 3D tiles are best-effort: terrain still loads if they fail
  let tiles: TileStreamer | null = null;
  try {
    onProgress('Streaming 3D building tiles');
    tiles = await load3DTiles({
      lat, lon, apiKey, terrain,
      ...(opts.anisotropy !== undefined ? { anisotropy: opts.anisotropy } : {}),
      onProgress: (n, total) => onProgress(`Streaming 3D building tiles ${n}/${total}`)
    });
    console.info(`3D tiles: ${tiles.tileCount} tiles loaded`);
  } catch (e) {
    console.warn('3D tiles failed (terrain still loaded):', e);
  }
  return { terrain, tiles };
}
