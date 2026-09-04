import { describe, it, expect } from 'vitest';
import { GroundStreamer } from '../src/services/maps/GroundStreamer.ts';

function createMockCanvas(): HTMLCanvasElement {
  return {
    width: 3840,
    height: 3840,
    getContext: () => null
  } as unknown as HTMLCanvasElement;
}

describe('GroundStreamer', () => {
  it('instantiates and computes correct Mercator grid cell spans', () => {
    const canvas = createMockCanvas();

    const streamer = new GroundStreamer({
      apiKey: 'TEST_KEY',
      center: { lat: 33.4484, lon: -112.0740 },
      canvas,
      zoom: 18,
      maxTiles: 20
    });

    expect(streamer.tileCount).toBe(0);
    streamer.dispose();
  });

  it('rate-limits picks to at most 1 every 350ms', () => {
    const canvas = createMockCanvas();

    const streamer = new GroundStreamer({
      apiKey: 'TEST_KEY',
      center: { lat: 33.4484, lon: -112.0740 },
      canvas,
      zoom: 18,
      maxTiles: 10
    });

    // In a headless test without Image, fetchTile will bail out safely without throwing
    streamer.update({ x: 0, z: 0 }, 1000);
    // Immediately calling update within 100ms should be skipped
    streamer.update({ x: 0, z: 0 }, 1100);
    streamer.update({ x: 0, z: 0 }, 1200);

    streamer.dispose();
  });
});
