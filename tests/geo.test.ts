import { describe, it, expect } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { llToWorld, worldToLl, ecefToWorldMatrix, tileTransformChain } from '../src/core/geo/projection.ts';
import { latLonToEcef, WORLD_M_PER_M } from '../src/core/geo/ecef.ts';

const ORIGIN = { lat: 37.7749, lon: -122.4194 }; // San Francisco
const R = 6_378_137;
const E2 = 0.00669437999014; // WGS84 first eccentricity squared

describe('latLonToEcef', () => {
  it('is on the WGS84 ellipsoid, not a sphere', () => {
    const p = latLonToEcef(45, 0, 0);
    // geocentric radius at 45° geodetic latitude: 6367.49 km, ~10.6 km under
    // the equatorial radius a sphere would give
    expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(6_367_490, -2);
    expect(p.y).toBeCloseTo(0, 6);
  });

  it('adds height along the geodetic normal', () => {
    const a = latLonToEcef(45, 10, 0);
    const b = latLonToEcef(45, 10, 100);
    expect(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)).toBeCloseTo(100, 6);
  });
});

describe('llToWorld', () => {
  it('maps the origin to the world origin', () => {
    const w = llToWorld(ORIGIN.lat, ORIGIN.lon, 0, ORIGIN);
    expect(w.x).toBeCloseTo(0, 6);
    expect(w.y).toBeCloseTo(0, 6);
    expect(w.z).toBeCloseTo(0, 6);
  });

  it('places 100m east at x = 100 * WORLD_M_PER_M', () => {
    // 100m east in radians of longitude at this latitude
    const dLon = (100 / R / Math.cos((ORIGIN.lat * Math.PI) / 180)) * (180 / Math.PI);
    const w = llToWorld(ORIGIN.lat, ORIGIN.lon + dLon, 0, ORIGIN);
    expect(w.x).toBeCloseTo(100 * WORLD_M_PER_M, 4);
    expect(w.z).toBeCloseTo(0, 4);
  });

  it('maps 1km north to z = -1000 * WORLD_M_PER_M', () => {
    const dLat = (1000 / R) * (180 / Math.PI);
    const w = llToWorld(ORIGIN.lat + dLat, ORIGIN.lon, 0, ORIGIN);
    expect(w.z).toBeCloseTo(-1000 * WORLD_M_PER_M, 2);
    expect(w.x).toBeCloseTo(0, 4);
  });

  it('maps altitude to Y scaled by WORLD_M_PER_M and relief boost', () => {
    expect(llToWorld(ORIGIN.lat, ORIGIN.lon, 50, ORIGIN, 1).y).toBeCloseTo(50 * WORLD_M_PER_M, 6);
    expect(llToWorld(ORIGIN.lat, ORIGIN.lon, 50, ORIGIN, 2).y).toBeCloseTo(50 * WORLD_M_PER_M * 2, 6);
  });
});

describe('worldToLl', () => {
  it('maps the world origin back to the origin lat/lon', () => {
    const ll = worldToLl(0, 0, ORIGIN);
    expect(ll.lat).toBeCloseTo(ORIGIN.lat, 6);
    expect(ll.lon).toBeCloseTo(ORIGIN.lon, 6);
  });

  it('inverts llToWorld precisely for arbitrary offsets across locations', () => {
    const testCases = [
      { lat: 40.7061, lon: -73.9969 }, // Brooklyn Bridge
      { lat: 37.8199, lon: -122.4783 }, // Golden Gate Bridge
      { lat: 45.5189, lon: -122.6793 }, // Portland
      { lat: 29.9584, lon: -90.0644 },  // New Orleans
      { lat: 0, lon: 0 },              // Equator
    ];
    for (const tc of testCases) {
      const origin = { lat: tc.lat, lon: tc.lon };
      // Test 500m east, 800m north
      const w = llToWorld(tc.lat + 0.007, tc.lon + 0.006, 0, origin);
      const inv = worldToLl(w.x, w.z, origin);
      expect(inv.lat).toBeCloseTo(tc.lat + 0.007, 7);
      expect(inv.lon).toBeCloseTo(tc.lon + 0.006, 7);
    }
  });
});

describe('ecefToWorldMatrix', () => {
  it('is orthonormal', () => {
    const m = ecefToWorldMatrix(ORIGIN);
    const row0 = new Vector3(m.elements[0], m.elements[1], m.elements[2]);
    const row1 = new Vector3(m.elements[4], m.elements[5], m.elements[6]);
    const row2 = new Vector3(m.elements[8], m.elements[9], m.elements[10]);
    expect(row0.length()).toBeCloseTo(1, 9);
    (['01', '02', '12'] as const).forEach(pair => {
      const a = pair === '01' ? row0.dot(row1) : pair === '02' ? row0.dot(row2) : row1.dot(row2);
      expect(a).toBeCloseTo(0, 9);
    });
  });

  it('takes ECEF up at the origin to world +Y', () => {
    const m = ecefToWorldMatrix(ORIGIN);
    // geodetic up (the ellipsoid normal, not the geocentric direction)
    const lat = (ORIGIN.lat * Math.PI) / 180;
    const lon = (ORIGIN.lon * Math.PI) / 180;
    const up = new Vector3(
      Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)
    ).multiplyScalar(50);
    const p = up.applyMatrix4(new Matrix4().copy(m));
    expect(p.x).toBeCloseTo(0, 3);
    expect(p.y).toBeCloseTo(50, 3);
    expect(p.z).toBeCloseTo(0, 3);
  });
});

describe('tileTransformChain', () => {
  it('lands a vertex 100m E + 50m U + 1km N of the match center at true scale', () => {
    const origin = { lat: 0, lon: 0 };
    const ecef0 = latLonToEcef(0, 0, 0);
    // 1 km along the meridian: its radius of curvature at the equator is a(1-e²)
    const latN = (1000 / (R * (1 - E2))) * (180 / Math.PI);
    const lonE = (100 / R) * (180 / Math.PI);
    const vEcef = latLonToEcef(latN, lonE, 50);
    const m = tileTransformChain(new Matrix4(), origin, ecef0, 1);
    const world = new Vector3(vEcef.x, vEcef.y, vEcef.z).applyMatrix4(m);
    // east 100m -> x=100, up 50m -> y=50, north 1km -> z=-1000 (scaled 1.0)
    expect(world.x).toBeCloseTo(100, 0);
    expect(world.y).toBeCloseTo(50, 0);
    expect(world.z).toBeCloseTo(-1000, 0);
  });
});
