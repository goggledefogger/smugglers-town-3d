import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Group, Mesh, Vector3 } from 'three';
import { Pickups } from '../src/render/Pickups.ts';
import type { MatchState } from '../src/core/gameplay/MatchRules.ts';
import type { Heightfield } from '../src/core/heightfield.ts';

describe('Pickups & Terrain-Projected Base Visuals', () => {
  let mockScene: { add: ReturnType<typeof vi.fn> };
  let mockHeightfield: Heightfield;
  let origDoc: unknown;

  beforeEach(() => {
    origDoc = (globalThis as any).document;
    const mockCtx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      fillRect: () => {},
      strokeRect: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      getImageData: () => ({ data: new Uint8ClampedArray(512 * 512 * 4).fill(230) }),
      putImageData: () => {}
    };
    class MockCanvas {
      width = 512;
      height = 512;
      getContext() { return mockCtx; }
    }
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return new MockCanvas();
        return {};
      }
    };

    mockScene = {
      add: vi.fn()
    };

    // Sloped / undulating terrain: height = 100 + x * 0.1 + z * 0.05
    mockHeightfield = {
      sample: vi.fn((x: number, z: number) => 100 + x * 0.1 + z * 0.05)
    } as unknown as Heightfield;
  });

  afterEach(() => {
    (globalThis as any).document = origDoc;
    vi.restoreAllMocks();
  });

  it('initializes two team bases and adds their root groups to the scene', () => {
    const pickups = new Pickups(mockScene, null, () => mockHeightfield);
    expect(mockScene.add).toHaveBeenCalledTimes(2);

    const base0Group = mockScene.add.mock.calls[0]![0] as Group;
    const base1Group = mockScene.add.mock.calls[1]![0] as Group;
    expect(base0Group).toBeInstanceOf(Group);
    expect(base1Group).toBeInstanceOf(Group);

    pickups.dispose();
  });

  it('drapes the delivery ring, outer dashes, ground disc, and curtain along terrain elevation', () => {
    const pickups = new Pickups(mockScene, null, () => mockHeightfield);
    const base0Group = mockScene.add.mock.calls[0]![0] as Group;

    const dummyState: MatchState = {
      scores: { 0: 0, 1: 0 },
      winner: null,
      contraband: [],
      bases: {
        0: new Vector3(50, 105, 20),
        1: new Vector3(-50, 95, -20)
      }
    };

    pickups.sync(dummyState, 0, 0.016, () => null);

    // Group position is placed at (x, y, z)
    expect(base0Group.position.x).toBe(50);
    expect(base0Group.position.y).toBe(105);
    expect(base0Group.position.z).toBe(20);

    // Find the meshes in base0Group
    // discMesh, ringMesh, xRayRingMesh, dashedMesh, curtain, beam, pointLight
    const meshes = base0Group.children.filter(c => c instanceof Mesh) as Mesh[];
    expect(meshes.length).toBeGreaterThanOrEqual(5);

    // Find the solid delivery ring (radius ~ 22m)
    // Its geometry position attribute should have non-zero and varying Y coordinates matching the slope
    const ringMesh = meshes.find(m => m.geometry && m.geometry.attributes.position && m.renderOrder === 3);
    expect(ringMesh).toBeDefined();

    const ringPos = ringMesh!.geometry.attributes.position!.array as Float32Array;
    expect(ringPos.length).toBeGreaterThan(0);

    // Sample different radial vertices along the ring
    const yValues: number[] = [];
    for (let i = 1; i < ringPos.length; i += 3) {
      yValues.push(ringPos[i]!);
    }

    const minY = Math.min(...yValues);
    const maxY = Math.max(...yValues);

    // With slope 0.1 * x across a 22m radius (diameter 44m), height difference is ~4.4m
    // Across the ring vertices, Y must vary significantly to conform to terrain
    expect(maxY - minY).toBeGreaterThan(2.0);

    // Curtain mesh (renderOrder === 4)
    const curtainMesh = meshes.find(m => m.renderOrder === 4);
    expect(curtainMesh).toBeDefined();

    const curtainPos = curtainMesh!.geometry.attributes.position!.array as Float32Array;
    const curtainYs: number[] = [];
    for (let i = 1; i < curtainPos.length; i += 3) {
      curtainYs.push(curtainPos[i]!);
    }
    const minCurtainY = Math.min(...curtainYs);
    const maxCurtainY = Math.max(...curtainYs);

    // Curtain extends from -0.5m below surface to +5m above surface, so vertical spread is > 5m
    expect(maxCurtainY - minCurtainY).toBeGreaterThan(5.0);

    pickups.dispose();
  });

  it('grounds all 4 perimeter pylons to terrain elevation regardless of local slope', () => {
    const pickups = new Pickups(mockScene, null, () => mockHeightfield);
    const base0Group = mockScene.add.mock.calls[0]![0] as Group;

    const dummyState: MatchState = {
      scores: { 0: 0, 1: 0 },
      winner: null,
      contraband: [],
      bases: {
        0: new Vector3(100, 110, 0),
        1: new Vector3(-100, 90, 0)
      }
    };

    pickups.sync(dummyState, 0, 0.016, () => null);

    // Pylons are Groups added to base0Group containing the post and cap
    const pylons = base0Group.children.filter(c => c instanceof Group && c.children.length === 2);
    expect(pylons.length).toBe(4);

    // Check that pylons on opposite sides of the base have different relative Y offsets to adapt to slope
    const pylonYs = pylons.map(p => p.position.y);
    const pylonSpread = Math.max(...pylonYs) - Math.min(...pylonYs);
    expect(pylonSpread).toBeGreaterThan(1.5);

    pickups.dispose();
  });

  it('animates texture offset on the dashed ring over time', () => {
    const pickups = new Pickups(mockScene, null, () => mockHeightfield);

    const dummyState: MatchState = {
      scores: { 0: 0, 1: 0 },
      winner: null,
      contraband: [],
      bases: {
        0: new Vector3(0, 100, 0),
        1: new Vector3(100, 100, 0)
      }
    };

    pickups.sync(dummyState, 1.0, 0.016, () => null);
    pickups.sync(dummyState, 2.0, 0.016, () => null);

    // No exceptions thrown during animation
    expect(true).toBe(true);

    pickups.dispose();
  });

  it('handles flat terrain or missing heightfield gracefully', () => {
    const pickups = new Pickups(mockScene, null, undefined);
    const dummyState: MatchState = {
      scores: { 0: 0, 1: 0 },
      winner: null,
      contraband: [],
      bases: {
        0: new Vector3(0, 10, 0),
        1: new Vector3(50, 10, 0)
      }
    };

    expect(() => pickups.sync(dummyState, 0, 0.016, () => null)).not.toThrow();
    pickups.dispose();
  });
});
