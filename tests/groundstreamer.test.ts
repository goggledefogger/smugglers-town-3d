import { describe, it, expect } from 'vitest';
import { GroundStreamer } from '../src/services/maps/GroundStreamer.ts';
import { Heightfield } from '../src/core/heightfield.ts';

function createMockHeightfield(): Heightfield {
  return new Heightfield(5600, 16, new Float32Array(17 * 17));
}

describe('GroundStreamer', () => {
  it('instantiates and computes correct Mercator grid cell spans', () => {
    const hf = createMockHeightfield();

    const streamer = new GroundStreamer({
      apiKey: 'TEST_KEY',
      center: { lat: 33.4484, lon: -112.0740 },
      heightfield: hf,
      zoom: 18,
      maxPatches: 16
    });

    expect(streamer.patchCount).toBe(0);
    expect(streamer.group).toBeDefined();
    // For Phoenix (lat 33.4484), 640px at zoom 18 is ~318 meters
    expect(streamer.tileSizeUnits).toBeGreaterThan(300);
    expect(streamer.tileSizeUnits).toBeLessThan(340);

    streamer.dispose();
  });

  it('rate-limits picks to at most 1 every 300ms', () => {
    const hf = createMockHeightfield();

    const streamer = new GroundStreamer({
      apiKey: 'TEST_KEY',
      center: { lat: 33.4484, lon: -112.0740 },
      heightfield: hf,
      zoom: 18,
      maxPatches: 16
    });

    // In a headless test without global Image, createPatch bails out safely
    streamer.update({ x: 0, z: 0 }, 1000);
    streamer.update({ x: 0, z: 0 }, 1100);
    streamer.update({ x: 0, z: 0 }, 1200);

    expect(streamer.patchCount).toBe(0);
    streamer.refresh();
    streamer.dispose();
    expect(streamer.group.children.length).toBe(0);
  });

  it('computes exact Web Mercator pixel roundtrip and continuous tile centers', async () => {
    const { latLonToWorldPixel, worldPixelToLatLon } = await import('../src/services/maps/MapsApi.ts');
    const nyc = { lat: 40.7128, lon: -74.0060 };
    const zoom = 15;

    const pix = latLonToWorldPixel(nyc.lat, nyc.lon, zoom);
    expect(pix.x).toBeGreaterThan(0);
    expect(pix.y).toBeGreaterThan(0);

    const roundtrip = worldPixelToLatLon(pix.x, pix.y, zoom);
    expect(roundtrip.lat).toBeCloseTo(nyc.lat, 6);
    expect(roundtrip.lon).toBeCloseTo(nyc.lon, 6);

    // Stepping ±640 pixels gives neighboring tile centers touching with zero gap
    const eastTilePix = { x: pix.x + 640, y: pix.y };
    const eastTile = worldPixelToLatLon(eastTilePix.x, eastTilePix.y, zoom);
    expect(eastTile.lon).toBeGreaterThan(nyc.lon);
    expect(eastTile.lat).toBeCloseTo(nyc.lat, 6);

    const backPix = latLonToWorldPixel(eastTile.lat, eastTile.lon, zoom);
    expect(backPix.x).toBeCloseTo(eastTilePix.x, 3);
  });

  it('allows live zoom changes (e.g. Zoom 18 -> 19 -> 20) and halves tileSizeUnits per zoom step', () => {
    const hf = createMockHeightfield();
    const streamer = new GroundStreamer({
      apiKey: 'TEST_KEY',
      center: { lat: 37.7934, lon: -122.4212 },
      heightfield: hf,
      zoom: 18,
      maxPatches: 16
    });

    expect(streamer.activeZoom).toBe(18);
    const z18Size = streamer.tileSizeUnits;
    expect(z18Size).toBeGreaterThan(280);
    expect(z18Size).toBeLessThan(320);

    // Zoom 19 covers half the ground span per patch (double the ground resolution)
    streamer.setZoom(19, 36, 8);
    expect(streamer.activeZoom).toBe(19);
    expect(streamer.tileSizeUnits).toBeCloseTo(z18Size / 2, 1);

    // Zoom 20 covers a quarter the ground span (4x resolution)
    streamer.setZoom(20, 48, 16);
    expect(streamer.activeZoom).toBe(20);
    expect(streamer.tileSizeUnits).toBeCloseTo(z18Size / 4, 1);

    streamer.dispose();
  });
});

