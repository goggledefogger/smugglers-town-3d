/**
 * LocationRelocator: end-to-end relocation to a real place. Geocodes the
 * query, fetches elevation + satellite imagery, streams 3D building tiles,
 * and returns the new TerrainProvider.
 */
import { buildRealTerrain, type ElevationGrid } from '../core/terrain/RealTerrain.ts';
import { loadMapsApi, geocode, fetchElevationGrid, fetchSatellite, satelliteUrl } from './maps/MapsApi.ts';
import type { MatchMap } from '../net/protocol.ts';
import { load3DTiles, type TileStreamer } from './tiles/Tileset.ts';
import type { TerrainProvider } from '../core/terrain/TerrainProvider.ts';
import { logger } from '../app/log.ts';

const log = logger('relocate');

import { GroundStreamer } from './maps/GroundStreamer.ts';
import { config } from '../app/config.ts';

export interface RelocateOptions {
  readonly query: string;
  readonly apiKey: string;
  /** Renderer max anisotropy for tile textures. */
  readonly anisotropy?: number;
  /** Skip the geocode: a lobby already resolved this place for every player. */
  readonly at?: { readonly lat: number; readonly lon: number; readonly label: string };
  readonly onProgress: (message: string) => void;
}

export interface RelocateResult {
  readonly terrain: TerrainProvider;
  /** Null when 3D tiles failed; the terrain still loaded. */
  readonly tiles: TileStreamer | null;
  /** Progressive ground detail streamer for high-res satellite map textures. */
  readonly groundStreamer?: GroundStreamer | null;
}

/**
 * Resolve a place and prove the key works, without loading the world.
 *
 * Deliberately stops at one geocode plus one thumbnail image: picking a
 * location in a lobby is browsing, and the elevation grid, the 9-image
 * satellite stitch and ~85 building tiles behind relocate() are far too
 * expensive to spend on a place someone is only considering. The match start
 * pays that, once, for the place they settled on.
 */
export async function previewPlace(query: string, apiKey: string): Promise<{
  map: Extract<MatchMap, { kind: 'city' }>;
  thumbnailUrl: string;
}> {
  await loadMapsApi(apiKey);
  const r0 = await geocode(query);
  const lat = r0.geometry.location.lat();
  const lon = r0.geometry.location.lng();
  return {
    map: { kind: 'city', query, label: r0.formatted_address.slice(0, 80), lat, lon },
    thumbnailUrl: satelliteUrl(lat, lon, apiKey, 13, 320, 128)
  };
}

/** Everything previewPlace skipped: elevation, imagery and the building tiles. */
export async function relocateTo(
  place: Extract<MatchMap, { kind: 'city' }>,
  apiKey: string,
  onProgress: (message: string) => void,
  anisotropy?: number
): Promise<RelocateResult> {
  return relocate({
    query: place.query, apiKey, onProgress,
    ...(anisotropy !== undefined ? { anisotropy } : {}),
    at: { lat: place.lat, lon: place.lon, label: place.label }
  });
}

export async function relocate(opts: RelocateOptions): Promise<RelocateResult> {
  const { query, apiKey, onProgress } = opts;
  const startedAt = Date.now();
  onProgress('Loading Google Maps API');
  await loadMapsApi(apiKey);
  let lat: number, lon: number, label: string;
  if (opts.at) {
    // already resolved by the lobby: skip the geocode so every player in a room
    // builds from the identical centre, whatever their own geocoder would say
    ({ lat, lon, label } = opts.at);
  } else {
    onProgress(`Geocoding "${query}"`);
    const r0 = await geocode(query);
    lat = r0.geometry.location.lat();
    lon = r0.geometry.location.lng();
    label = r0.formatted_address;
  }
  onProgress(`Fetching elevation grid for ${label}`);
  const grid: ElevationGrid = await fetchElevationGrid(lat, lon);
  onProgress('Fetching satellite imagery');
  const sat = await fetchSatellite(lat, lon, apiKey);
  const terrain = buildRealTerrain(label, grid, config.world.mapHalf, sat, { lat, lon });
  // 3D tiles are best-effort: terrain still loads if they fail
  let tiles: TileStreamer | null = null;
  try {
    onProgress('Streaming 3D building tiles');
    tiles = await load3DTiles({
      lat, lon, apiKey, terrain,
      ...(opts.anisotropy !== undefined ? { anisotropy: opts.anisotropy } : {}),
      onProgress: (n, total) => onProgress(`Streaming 3D building tiles ${n}/${total}`)
    });
  } catch (e) {
    // the terrain still loads; the city just has no buildings to crash into
    log.warn('3D tiles failed, terrain only', e);
  }
  // Google 3D Tiles already provides high-resolution photogrammetry on streets, bridges,
  // and shorelines. Only stream secondary 2D satellite patches if 3D tiles are unavailable,
  // avoiding double-bridge artifacts (2D road on water) and shoreline seams.
  const groundStreamer = (sat && !tiles) ? new GroundStreamer({
    apiKey,
    center: { lat, lon },
    heightfield: terrain.heightfield,
    anisotropy: opts.anisotropy,
    zoom: 18
  }) : null;
  log.info('relocated', {
    label, lat, lon, tiles: tiles?.tileCount ?? 0, ms: Date.now() - startedAt
  });
  return { terrain, tiles, groundStreamer };
}
