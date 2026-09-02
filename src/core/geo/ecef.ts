/**
 * Geodesy for placing Google 3D Tiles and real elevation data in the game world.
 *
 * The game world is a local tangent plane at the match center:
 *   X = east, Y = up, Z = south (matches the engine's -Z forward convention).
 * 1 real meter = `WORLD_M_PER_M` world units, so terrain and streamed building
 * geometry share one true-to-scale mapping.
 */
export const WORLD_M_PER_M = 0.15;

/** WGS84 semi-major axis (equatorial radius), meters */
export const EARTH_RADIUS_M = 6_378_137;

/** WGS84 first eccentricity squared */
const WGS84_E2 = 0.00669437999014;

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

/**
 * Geodetic lat/lon (degrees) + height above the ellipsoid (m) -> WGS84 ECEF.
 *
 * Google's 3D Tiles sit on the WGS84 ellipsoid, and a spherical earth is not
 * a usable approximation here: at mid latitudes the geodetic and geocentric
 * verticals differ by ~0.19°, which puts a spherical origin ~24 km from the
 * tiles (Portland: 23,989 m) — far enough that a tile walk with a tight
 * radius never finds the city
 */
export function latLonToEcef(latDeg: number, lonDeg: number, altM = 0): Ecef {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = EARTH_RADIUS_M / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    x: (n + altM) * cosLat * Math.cos(lon),
    y: (n + altM) * cosLat * Math.sin(lon),
    z: (n * (1 - WGS84_E2) + altM) * sinLat
  };
}
