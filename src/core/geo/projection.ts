/**
 * Projection between real-world geodetic coordinates and the game world.
 *
 * The heightfield maps lat/lon to the square play field with an equirectangular
 * projection; the tile chain below must use the same convention or streamed
 * buildings will not sit on the terrain.
 */
import { Matrix4, Vector3 } from 'three';
import { WORLD_M_PER_M, EARTH_RADIUS_M, type GeoOrigin, type Ecef } from './ecef.ts';

/**
 * lat/lon/alt (degrees/meters) -> world position centered on the origin.
 * X = east, Z = south (engine forward is -Z), Y = up.
 */
export function llToWorld(
  lat: number,
  lon: number,
  altM: number,
  origin: GeoOrigin,
  reliefBoost = 1
): Vector3 {
  const dLat = ((lat - origin.lat) * Math.PI) / 180;
  const dLon = ((lon - origin.lon) * Math.PI) / 180;
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const east = EARTH_RADIUS_M * dLon * cosLat;
  const north = EARTH_RADIUS_M * dLat;
  return new Vector3(
    east * WORLD_M_PER_M,
    altM * WORLD_M_PER_M * reliefBoost,
    -north * WORLD_M_PER_M
  );
}

/**
 * Rotation taking ECEF vectors into the local world frame at the origin.
 * Rows are world axes (X = east, Y = up, Z = south) expressed in ECEF, so
 * vWorld = M * vECEF. Equivalent to ecefToEnu with the ENU->world axis swap
 * (north is -Z here) baked in as a single matrix.
 */
export function ecefToWorldMatrix(origin: GeoOrigin): Matrix4 {
  const lat = (origin.lat * Math.PI) / 180;
  const lon = (origin.lon * Math.PI) / 180;
  // east unit vector in ECEF
  const ex = -Math.sin(lon), ey = Math.cos(lon);
  // north unit vector in ECEF
  const nx = -Math.sin(lat) * Math.cos(lon), ny = -Math.sin(lat) * Math.sin(lon), nz = Math.cos(lat);
  // up unit vector in ECEF
  const ux = Math.cos(lat) * Math.cos(lon), uy = Math.cos(lat) * Math.sin(lon), uz = Math.sin(lat);
  const m = new Matrix4();
  // row 0: world X = east
  m.set(
    ex, ey, 0, 0,
    ux, uy, uz, 0,      // row 1: world Y = up
    -nx, -ny, -nz, 0,  // row 2: world Z = south = -north
    0, 0, 0, 1
  );
  return m;
}

/**
 * Full tile-local -> world matrix for a Google photorealistic tile.
 *
 *   world = Scale(s, s*boost, s) · R(ecefToWorld) · Translate(-ecef0) · tileTransform · p
 *
 * The Translate(-ecef0) is the load-bearing step: the tile `transform` encodes
 * the tile's absolute ECEF position (~6.3M m). Without subtracting the
 * match-center ECEF first, the rotation projects the entire earth radius onto
 * the up axis and the tile renders at Y ~956720 while the terrain sits at
 * Y ~0. A vertex 1km N + 100E + 50U from the match center must land at
 * (15, 7.5, -150.3) with default scale.
 */
export function tileTransformChain(
  tileTf: Matrix4,
  origin: GeoOrigin,
  ecef0: Ecef,
  reliefBoost = 1
): Matrix4 {
  const s = WORLD_M_PER_M;
  const m = new Matrix4();
  m.makeScale(s, s * reliefBoost, s);
  m.multiply(ecefToWorldMatrix(origin));
  m.multiply(new Matrix4().makeTranslation(-ecef0.x, -ecef0.y, -ecef0.z));
  m.multiply(tileTf);
  return m;
}
