import { describe, it, expect } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { llToWorld, ecefToWorldMatrix, tileTransformChain } from '../src/core/geo/projection.ts';
import { latLonToEcef, WORLD_M_PER_M } from '../src/core/geo/ecef.ts';

const ORIGIN = { lat: 37.7749, lon: -122.4194 }; // San Francisco
const R = 6_378_137;

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
    const ecef0 = latLonToEcef(ORIGIN.lat, ORIGIN.lon, 0);
    // unit ECEF-up at the origin: the normalized position vector itself
    const up = new Vector3(ecef0.x, ecef0.y, ecef0.z).normalize().multiplyScalar(50);
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
    const latN = (1000 / R) * (180 / Math.PI);
    const lonE = (100 / R) * (180 / Math.PI);
    const vEcef = latLonToEcef(latN, lonE, 50);
    const m = tileTransformChain(new Matrix4(), origin, ecef0, 1);
    const world = new Vector3(vEcef.x, vEcef.y, vEcef.z).applyMatrix4(m);
    // east 100m -> x=15, up 50m -> y=7.5, north 1km -> z=-150 (scaled 0.15)
    expect(world.x).toBeCloseTo(15, 1);
    expect(world.y).toBeCloseTo(7.5, 1);
    expect(world.z).toBeCloseTo(-150, 1);
  });
});
