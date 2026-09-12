import { describe, it, expect } from 'vitest';
import {
  thresholdsForMode, collidersFromRasters, type TileRaster, type Grid
} from '../src/services/tiles/tileColliders.ts';
import { rasterizeRoads } from '../src/services/osm/roads.ts';

describe('Driving Experiment Modes (Road Clearance & Building Collider Fidelity)', () => {
  describe('thresholdsForMode', () => {
    it('returns baseline thresholds with standard 10m cell and 1.0m inset', () => {
      const th = thresholdsForMode('baseline');
      expect(th.experimentMode).toBe('baseline');
      expect(th.cell).toBe(10);
      expect(th.insetExteriorStreetM).toBe(1.0);
      expect(th.roadReachSlackMultiplier).toBe(0.5);
    });

    it('returns road_carve thresholds with expanded 0.85 road corridor reach', () => {
      const th = thresholdsForMode('road_carve');
      expect(th.experimentMode).toBe('road_carve');
      expect(th.roadReachSlackMultiplier).toBe(0.85);
      expect(th.cell).toBe(10);
    });

    it('returns curbside_inset thresholds with 2.4m exterior street face retraction', () => {
      const th = thresholdsForMode('curbside_inset');
      expect(th.experimentMode).toBe('curbside_inset');
      expect(th.insetExteriorStreetM).toBe(2.4);
      expect(th.cell).toBe(10);
    });

    it('returns high_res thresholds with 5m sub-lane grid and adapted opening K', () => {
      const th = thresholdsForMode('high_res');
      expect(th.experimentMode).toBe('high_res');
      expect(th.cell).toBe(5);
      expect(th.groundOpeningK).toBe(12); // 12 * 5m = 60m radius
      expect(th.insetExteriorStreetM).toBe(0.8);
    });
  });

  describe('Curbside Inset Experiment (2.4m face retraction)', () => {
    it('retracts building box face bordering a street by 2.4m vs 1.0m in baseline', () => {
      // 60x60 grid with 10m cells (interior starts after GROUND_K = 6 cells)
      const n = 60;
      const cell = 10;
      const half = (n * cell) / 2;
      const grid: Grid = { cell, half, n };

      // Flat ground at Y = 0
      const top = new Float32Array(n * n).fill(0);
      const low = new Float32Array(n * n).fill(0);

      // Place a 3-cell building well inside the map (row 30, columns 30..32, height 12m)
      for (let i = 30; i <= 32; i++) {
        const c = 30 * n + i;
        top[c] = 12;
        low[c] = 0;
      }

      const rasters: (TileRaster | null)[] = [{ i0: 0, j0: 0, w: n, h: n, top, low }];
      const terrainTop = new Float32Array(n * n).fill(0);

      // Baseline pass (insetExteriorStreetM = 1.0)
      const baselineBoxes = collidersFromRasters(
        rasters, grid, terrainTop, 1, undefined, thresholdsForMode('baseline')
      );
      expect(baselineBoxes.length).toBeGreaterThan(0);
      const bBaseline = baselineBoxes[0]!;

      // Curbside inset pass (insetExteriorStreetM = 2.4)
      const curbsideBoxes = collidersFromRasters(
        rasters, grid, terrainTop, 1, undefined, thresholdsForMode('curbside_inset')
      );
      expect(curbsideBoxes.length).toBeGreaterThan(0);
      const bCurbside = curbsideBoxes[0]!;

      // West face (min.x) touches the open street at col 29.
      // Under curbside inset, min.x should be shifted east by 2.4m (vs 1.0m in baseline),
      // opening up an extra 1.4m of drivable lane!
      expect(bCurbside.min.x - bBaseline.min.x).toBeCloseTo(1.4, 1);
    });
  });

  describe('Road Carve Experiment (Expanded reach multiplier)', () => {
    it('covers borderline roadside cells with 0.85 reach that 0.5 reach misses', () => {
      const n = 20;
      const cell = 10;
      const half = (n * cell) / 2;
      const grid = { cell, half, n };

      // A 12m wide residential street running north-south with a 3m offset from grid center (east = 3)
      // Cell center at x = 15 is 12m from east = 3.
      // 0.5 reach: 6 + 5 = 11m (< 12m, missed!)
      // 0.85 reach: 6 + 8.5 = 14.5m (>= 12m, covered!)
      const polyline = [[{ east: 3, north: -100, widthM: 12 }, { east: 3, north: 100, widthM: 12 }]];

      const standardRoads = rasterizeRoads(polyline, grid, 0.5);
      const expandedRoads = rasterizeRoads(polyline, grid, 0.85);

      let standardCount = 0;
      let expandedCount = 0;
      for (let i = 0; i < n * n; i++) {
        if (standardRoads.mask[i]) standardCount++;
        if (expandedRoads.mask[i]) expandedCount++;
      }

      expect(expandedCount).toBeGreaterThan(standardCount);
    });
  });

  describe('Floating Overhead Colliders', () => {
    it('elevates box min.y when ground clearance is confirmed, opening headroom for vehicles', () => {
      const n = 20;
      const cell = 10;
      const half = (n * cell) / 2;
      const grid = { cell, half, n };

      const top = new Float32Array(n * n).fill(0);
      const low = new Float32Array(n * n).fill(0);
      // Overhead canopy / thick structure (3x3 cells: widthX=3, widthZ=3 > narrowSpan 2)
      for (let j = 9; j <= 11; j++) {
        for (let i = 9; i <= 11; i++) {
          const c = j * n + i;
          top[c] = 18;
          low[c] = 8;
        }
      }

      // Geometry mask only active at bits corresponding to 7.5m - 18.0m (clear from 0 to 7.5m)
      const mask = new Uint32Array(n * n);
      for (let j = 9; j <= 11; j++) {
        for (let i = 9; i <= 11; i++) {
          mask[j * n + i] = (1 << 6) | (1 << 7) | (1 << 8); // geometry at 9.0m - 13.5m
        }
      }

      const rasters: (TileRaster | null)[] = [{ i0: 0, j0: 0, w: n, h: n, top, low, mask, y0: 0 }];
      const terrainTop = new Float32Array(n * n).fill(0);

      const boxes = collidersFromRasters(rasters, grid, terrainTop, 1);
      expect(boxes.length).toBeGreaterThan(0);
      const b = boxes[0]!;
      // Box floor should be elevated with min.y >= 4.0m above ground level (ground = 0)
      expect(b.min.y).toBeGreaterThanOrEqual(4.0);
    });
  });
});
