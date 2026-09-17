import { describe, it, expect } from 'vitest';
import { BufferAttribute } from 'three';
import { RoadRibbonView, resamplePolyline } from '../src/render/RoadRibbonView.ts';
import { PrismMeshView } from '../src/render/PrismMeshView.ts';
import { BuildingMeshView } from '../src/render/BuildingMeshView.ts';

describe('RoadRibbonView', () => {
  it('resamples a way into steps no longer than 6 m with running arc length', () => {
    const pts = resamplePolyline([{ east: 0, north: 0, widthM: 12 }, { east: 30, north: 0, widthM: 12 }]);
    expect(pts.length).toBe(6);
    expect(pts[5]).toMatchObject({ x: 30, s: 30, w: 12 });
    expect(Math.abs(pts[5]!.z)).toBe(0);
    for (let k = 1; k < pts.length; k++) expect(pts[k]!.s - pts[k - 1]!.s).toBeLessThanOrEqual(6);
  });

  it('drapes a ribbon of the tagged width a lift above the ground and re-drapes on refresh', () => {
    const view = new RoadRibbonView();
    view.build([[{ east: 0, north: 0, widthM: 10 }, { east: 0, north: 12, widthM: 10 }]], () => 5);
    expect(view.vertexCount).toBe(6);
    const geo = (view as any).mesh.geometry;
    const pos = geo.getAttribute('position') as BufferAttribute;
    // north is -z; the first point's two verts straddle x = 0 by half the width
    expect(Math.abs(pos.getX(0) - pos.getX(1))).toBeCloseTo(10);
    expect(pos.getY(0)).toBeCloseTo(5 + 0.12 + 10 * 0.004);
    expect(pos.getZ(4)).toBeCloseTo(-12);
    view.refreshHeights(() => 9);
    expect(pos.getY(0)).toBeCloseTo(9 + 0.12 + 10 * 0.004);
    view.build([[{ east: 0, north: 0, widthM: 10 }]], () => 0);
    expect(view.vertexCount).toBe(0);
    view.dispose();
  });
});

describe('procedural facades', () => {
  it('toggle on the boxes and the prisms, and every prism wall carries its width, height and seed', () => {
    const boxes = new BuildingMeshView();
    expect(boxes.facade).toBe(false);
    boxes.setFacade(true);
    expect(boxes.facade).toBe(true);

    const prisms = new PrismMeshView();
    prisms.setFacade(true);
    expect(prisms.facade).toBe(true);
    prisms.build([{ ring: [0, 0, 20, 0, 20, 10, 0, 10, 0, 0], holes: [], y0: 0, y1: 30 }]);
    expect(prisms.count).toBe(4);
    const dims = (prisms as any).mesh.geometry.getAttribute('aWallDims') as BufferAttribute;
    expect(dims.getX(0)).toBe(20); // first wall runs the 20 m edge
    expect(dims.getY(0)).toBe(30);
    expect(dims.getX(4)).toBe(10);
    // all four walls share the building's seed cell (centroid 10,5 over 8 m cells)
    for (let w = 0; w < 4; w++) {
      expect(dims.getZ(w * 4)).toBe(1);
      expect(dims.getW(w * 4)).toBe(0);
    }
    prisms.dispose();
  });
});
