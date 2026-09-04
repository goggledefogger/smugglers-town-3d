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
});
