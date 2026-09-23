import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchElevationGrid } from '../src/services/maps/MapsApi.ts';
import { llToWorld } from '../src/core/geo/projection.ts';

describe('fetchElevationGrid geodesy and orientation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('samples grid with j=0 at North and j=N-1 at South, symmetric in longitude', async () => {
    const portland = { lat: 45.5152, lon: -122.6784 };
    const capturedLocations: google.maps.LatLng[] = [];

    // Mock Google Maps Elevation API
    const mockElevator = {
      getElevationForLocations: vi.fn(({ locations }) => {
        capturedLocations.push(...locations);
        const results = locations.map((loc: any) => ({
          elevation: 10,
          location: loc,
          resolution: 1
        }));
        return Promise.resolve({ results });
      })
    };

    vi.stubGlobal('google', {
      maps: {
        LatLng: class {
          constructor(public _lat: number, public _lng: number) {}
          lat() { return this._lat; }
          lng() { return this._lng; }
        },
        ElevationService: vi.fn(() => mockElevator)
      }
    });

    const grid = await fetchElevationGrid(portland.lat, portland.lon);
    expect(grid.gridN).toBe(64);
    expect(grid.samples.length).toBe(64 * 64);
    expect(capturedLocations.length).toBe(64 * 64);

    const N = 64;
    // Row 0 (j = 0) must be North (lat > center.lat)
    const nw = capturedLocations[0]!;
    const ne = capturedLocations[N - 1]!;
    expect(nw.lat()).toBeGreaterThan(portland.lat);
    expect(ne.lat()).toBeGreaterThan(portland.lat);
    expect(nw.lat()).toBeCloseTo(portland.lat + 0.025, 4);

    // Row N - 1 (j = N - 1) must be South (lat < center.lat)
    const sw = capturedLocations[(N - 1) * N]!;
    const se = capturedLocations[N * N - 1]!;
    expect(sw.lat()).toBeLessThan(portland.lat);
    expect(se.lat()).toBeLessThan(portland.lat);
    expect(sw.lat()).toBeCloseTo(portland.lat - 0.025, 4);

    // West column (i = 0) must be West of center (lon < center.lon)
    expect(nw.lng()).toBeLessThan(portland.lon);
    expect(sw.lng()).toBeLessThan(portland.lon);

    // East column (i = N - 1) must be East of center (lon > center.lon)
    expect(ne.lng()).toBeGreaterThan(portland.lon);
    expect(se.lng()).toBeGreaterThan(portland.lon);

    // Verify exact East-West symmetry around center.lon
    const westOffset = portland.lon - nw.lng();
    const eastOffset = ne.lng() - portland.lon;
    expect(westOffset).toBeCloseTo(eastOffset, 6);

    // Verify alignment with llToWorld:
    // A point at the Northern boundary (nw.lat(), center.lon) maps to negative Z (world North)
    const northPos = llToWorld(nw.lat(), portland.lon, 0, portland);
    expect(northPos.z).toBeLessThan(0);
    expect(northPos.x).toBeCloseTo(0, 3);

    // A point at the Southern boundary maps to positive Z (world South)
    const southPos = llToWorld(sw.lat(), portland.lon, 0, portland);
    expect(southPos.z).toBeGreaterThan(0);
    expect(southPos.x).toBeCloseTo(0, 3);
  });
});
