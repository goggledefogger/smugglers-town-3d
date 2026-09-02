/**
 * LocationRelocator: end-to-end relocation to a real place. Geocodes the
 * query, fetches elevation + satellite imagery, streams 3D building tiles,
 * and returns the new TerrainProvider.
 */
import { Group } from 'three';
import { buildRealTerrain, type ElevationGrid } from '../core/terrain/RealTerrain.ts';
import { loadMapsApi, geocode, fetchElevationGrid, fetchSatellite } from './maps/MapsApi.ts';
import { load3DTiles } from './tiles/Tileset.ts';
import type { BuildingCollider } from '../core/physics/VehicleBody.ts';
import type { TerrainProvider } from '../core/terrain/TerrainProvider.ts';

export interface RelocateResult {
  readonly terrain: TerrainProvider;
  readonly colliders: BuildingCollider[];
  readonly tilesGroup: Group | null;
}

export type ProgressFn = (message: string) => void;

export async function relocate(
  query: string,
  apiKey: string,
  onProgress: ProgressFn
): Promise<RelocateResult> {
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
  let colliders: BuildingCollider[] = [];
  let tilesGroup: Group | null = null;
  try {
    onProgress('Streaming 3D building tiles');
    const tiles = await load3DTiles({
      lat, lon, apiKey, terrain,
      onProgress: (n, total) => onProgress(`Streaming 3D building tiles ${n}/${total}`)
    });
    console.info(`3D tiles: ${tiles.tileCount} tiles, ${tiles.buildingCount} building colliders`);
    colliders = tiles.colliders;
    tilesGroup = tiles.tilesGroup;
  } catch (e) {
    console.warn('3D tiles failed (terrain still loaded):', e);
  }
  return { terrain, colliders, tilesGroup };
}
