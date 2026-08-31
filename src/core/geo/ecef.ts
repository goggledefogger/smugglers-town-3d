/**
 * Geodesy for placing Google 3D Tiles and real elevation data in the game world.
 *
 * The game world is a local tangent plane at the match center:
 *   X = east, Y = up, Z = south (matches the engine's -Z forward convention).
 * 1 real meter = `WORLD_M_PER_M` world units, so terrain and streamed building
 * geometry share one true-to-scale mapping.
 */
export const WORLD_M_PER_M = 0.15;

/** WGS84 equatorial earth radius in meters (matches Google's 3D Tiles frame) */
export const EARTH_RADIUS_M = 6_378_137;

/** Local tangent-plane origin for a match location. */
export interface GeoOrigin {
  readonly lat: number;
  readonly lon: number;
}

/**
 * ECEF (earth-centered earth-fixed) coordinates, in meters.
 * Used as the intermediate frame when converting Google tile geometry.
 */
export interface Ecef {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** lat/lon (degrees) -> ECEF (meters) on a spherical earth. */
export function latLonToEcef(latDeg: number, lonDeg: number, altM = 0): Ecef {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const r = EARTH_RADIUS_M + altM;
  return {
    x: r * Math.cos(lat) * Math.cos(lon),
    y: r * Math.cos(lat) * Math.sin(lon),
    z: r * Math.sin(lat)
  };
}

/** ECEF -> local east/north/up at an origin, in meters. */
export function ecefToEnu(p: Ecef, origin: Ecef, lat0Deg: number, lon0Deg: number): {
  east: number; north: number; up: number;
} {
  const lat0 = (lat0Deg * Math.PI) / 180;
  const lon0 = (lon0Deg * Math.PI) / 180;
  const dx = p.x - origin.x, dy = p.y - origin.y, dz = p.z - origin.z;
  const sinLat = Math.sin(lat0), cosLat = Math.cos(lat0);
  const sinLon = Math.sin(lon0), cosLon = Math.cos(lon0);
  // east = (-sin lon, cos lon, 0) · d
  const east = -sinLon * dx + cosLon * dy;
  // up = (cos lat cos lon, cos lat sin lon, sin lat) · d
  const up = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;
  // north = (-sin lat cos lon, -sin lat sin lon, cos lat) · d
  const north = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
  return { east, north, up };
}
