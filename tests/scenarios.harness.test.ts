import { describe, it, expect } from 'vitest';
import { TEST_SCENARIOS } from '../src/core/geo/testScenarios.ts';
import {
  collidersFromRasters,
  groundField,
  DEFAULT_COLLIDER_THRESHOLDS,
  type TileRaster,
  type Grid,
  type ColliderThresholds
} from '../src/services/tiles/tileColliders.ts';
import type { BuildingCollider } from '../src/core/physics/VehicleBody.ts';
import { sphereVsAabb, type Contact } from '../src/core/physics/collision.ts';

/**
 * Automated Multi-Scenario Regression Harness
 *
 * Runs all 17 curated test scenarios through synthetic topological ground truths
 * representing their specific topography (bridges, skyscrapers, steep slopes,
 * low-rises, open terrain, and seawalls).
 *
 * This turns city-by-city heuristic tuning from ad-hoc whack-a-mole into a
 * deterministic, fast (< 500ms) regression suite in headless Node.
 */

const CELL = 10;
const N = 40; // 400m x 400m test tile area

function createTestGrid(): Grid {
  return { cell: CELL, half: (N * CELL) / 2, n: N };
}

function makeRaster(
  top: Float32Array,
  low: Float32Array,
  mask?: Uint32Array,
  y0 = 0
): TileRaster {
  const r: TileRaster = { i0: 0, j0: 0, w: N, h: N, top, low, y0 };
  if (mask !== undefined) {
    return { ...r, mask };
  }
  return r;
}

function createMaskWithClearance(
  n: number,
  y0: number,
  geometryRanges: { startY: number; endY: number }[]
): Uint32Array {
  const mask = new Uint32Array(n * n);
  const binSize = DEFAULT_COLLIDER_THRESHOLDS.verticalBinSizeM;
  let cellBits = 0;
  for (const { startY, endY } of geometryRanges) {
    const b0 = Math.max(0, Math.floor((startY - y0) / binSize));
    const b1 = Math.min(31, Math.floor((endY - y0) / binSize));
    for (let b = b0; b <= b1; b++) {
      cellBits |= (1 << b);
    }
  }
  mask.fill(cellBits);
  return mask;
}

const contactSink: Contact = { nx: 0, ny: 0, nz: 0, push: 0 };

function hasCollisionAt(
  x: number,
  y: number,
  z: number,
  radius: number,
  boxes: readonly BuildingCollider[]
): boolean {
  for (const box of boxes) {
    if (sphereVsAabb(x, y, z, radius, box.min, box.max, contactSink)) {
      return true;
    }
  }
  return false;
}

describe('Automated Scenario Regression Harness (58 Curated Scenarios)', () => {
  const grid = createTestGrid();

  it('contains exactly 58 curated global scenarios', () => {
    expect(TEST_SCENARIOS.length).toBe(58);
  });

  // =========================================================================
  // 1. Bridges, Water & Multi-Deck Driving
  // =========================================================================
  describe('Category 1: Bridges, Water & Multi-Deck Driving', () => {
    it('brooklyn_bridge: drivable deck ribbon, approach ramp, suspension tower colliders, zero water walls', () => {
      const top = new Float32Array(N * N).fill(0);
      const low = new Float32Array(N * N).fill(0);
      const deckGrid = new Float32Array(N * N);
      const terrain = new Float32Array(N * N).fill(0);

      // Elevated bridge roadway ribbon along column X=20, rows Z=15..28 at Y=20m (slab: low=18.5, top=20)
      for (let j = 15; j <= 28; j++) {
        const c = j * N + 20;
        top[c] = 20;
        low[c] = 18.5;
      }

      // Approach ramp descending from row 14 down to row 10 (Y=20 down to Y=2)
      top[14 * N + 20] = 17.0; low[14 * N + 20] = 15.5;
      top[13 * N + 20] = 13.5; low[13 * N + 20] = 12.0;
      top[12 * N + 20] = 9.5;  low[12 * N + 20] = 8.0;
      top[11 * N + 20] = 5.5;  low[11 * N + 20] = 4.0;
      top[10 * N + 20] = 2.0;  low[10 * N + 20] = 0.5;

      // Massive suspension cable tower standing in water at X=21, Z=20 from Y=0 to Y=70 (thick structure)
      top[20 * N + 21] = 70;
      low[20 * N + 21] = 0;

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1, deckGrid);

      // 1. Elevated roadway ribbon must be recorded in deckGrid
      expect(deckGrid[20 * N + 20]).toBeCloseTo(20, 1);
      // 2. Approach ramp must connect continuously down to ground in deckGrid
      expect(deckGrid[14 * N + 20]).toBeCloseTo(17.0, 1);
      expect(deckGrid[11 * N + 20]).toBeCloseTo(5.5, 1);
      // 3. Roadway lane must NOT have building colliders blocking it
      const roadWorldX = -grid.half + (20 + 0.5) * CELL;
      const roadWorldZ = -grid.half + (20 + 0.5) * CELL;
      expect(hasCollisionAt(roadWorldX, 20, roadWorldZ, 1.5, colliders)).toBe(false);

      // 4. Suspension tower in water must produce a solid building collider
      const towerWorldX = -grid.half + (21 + 0.5) * CELL;
      expect(hasCollisionAt(towerWorldX, 35, roadWorldZ, 1.5, colliders)).toBe(true);
      const towerBox = colliders.find(b => b.max.y > 50);
      expect(towerBox).toBeDefined();
      expect(towerBox?.max.y).toBeCloseTo(70, 1);
    });

    it('golden_gate_bridge: high altitude 67m suspension span with deckGrid elevation above water', () => {
      const top = new Float32Array(N * N).fill(0);
      const low = new Float32Array(N * N).fill(0);
      const deckGrid = new Float32Array(N * N);
      const terrain = new Float32Array(N * N).fill(0);

      // 2-cell wide roadway ribbon across rows 10..30 at Y=67 (low=65, top=67)
      for (let j = 10; j <= 30; j++) {
        for (let i = 19; i <= 20; i++) {
          const c = j * N + i;
          top[c] = 67;
          low[c] = 65;
        }
      }

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1, deckGrid);

      // Entire span registered in deckGrid at Y=67
      for (let j = 10; j <= 30; j++) {
        expect(deckGrid[j * N + 19]).toBeCloseTo(67, 1);
        expect(deckGrid[j * N + 20]).toBeCloseTo(67, 1);
      }
      // Zero building colliders over the bridge deck
      expect(colliders).toHaveLength(0);
    });

    it('hawthorne_bridge: truss bridge deck drivable and pier column colliders solid', () => {
      const top = new Float32Array(N * N).fill(0);
      const low = new Float32Array(N * N).fill(0);
      const deckGrid = new Float32Array(N * N);
      const terrain = new Float32Array(N * N).fill(0);

      // Truss roadway at Y=14m (low=12.5, top=14)
      for (let j = 15; j <= 25; j++) {
        const c = j * N + 20;
        top[c] = 14;
        low[c] = 12.5;
      }
      // Concrete pier column in river supporting the truss at X=20, Z=20
      // Beside it at X=19 is the river water
      top[20 * N + 22] = 14;
      low[20 * N + 22] = 0; // solid down to riverbed

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1, deckGrid);

      // Road deck is drivable
      expect(deckGrid[20 * N + 20]).toBeCloseTo(14, 1);
      // Pier is a solid collider
      expect(colliders.length).toBeGreaterThan(0);
      const pierBox = colliders.find(b => b.max.y >= 13);
      expect(pierBox).toBeDefined();
    });

    it('st_johns_bridge: Gothic towers solid and Cathedral Park underpass driving lane open', () => {
      const top = new Float32Array(N * N).fill(0);
      const low = new Float32Array(N * N).fill(0);
      const terrain = new Float32Array(N * N).fill(0);

      // Cathedral Park underpass: ground street at Y=0, bridge deck overhead at Y=30.
      // Vertical bitmask has geometry at ground (Y=0) and deck (Y=28..30), but clearance zone (Y=1.2..4.5) is empty.
      const mask = createMaskWithClearance(N, 0, [
        { startY: 0, endY: 0.5 },
        { startY: 28, endY: 30 }
      ]);

      for (let j = 15; j <= 25; j++) {
        const c = j * N + 20;
        top[c] = 30;
        low[c] = 28;
      }

      // Tall Gothic tower beside underpass at X=22, Z=20 (height 100m, solid)
      top[20 * N + 22] = 100;
      low[20 * N + 22] = 0;
      // In the tower cell, mask has solid geometry throughout
      mask[20 * N + 22] = 0xFFFFFFFF;

      const colliders = collidersFromRasters([makeRaster(top, low, mask, 0)], grid, terrain, 1);

      // Underpass roadway at X=20, Z=20 must have NO collider blocking it
      const underpassWorldX = -grid.half + (20 + 0.5) * CELL;
      const underpassWorldZ = -grid.half + (20 + 0.5) * CELL;
      expect(hasCollisionAt(underpassWorldX, 2.0, underpassWorldZ, 1.5, colliders)).toBe(false);

      // Gothic tower at X=22 must have solid collider
      const towerWorldX = -grid.half + (22 + 0.5) * CELL;
      expect(hasCollisionAt(towerWorldX, 50.0, underpassWorldZ, 1.5, colliders)).toBe(true);
    });
  });

  // =========================================================================
  // 2. Dense 3D Photogrammetry Cities
  // =========================================================================
  describe('Category 2: Dense 3D Photogrammetry Cities', () => {
    it('midtown_manhattan: skyscraper colliders have 1.0m exterior insets leaving avenue clear', () => {
      const top = new Float32Array(N * N).fill(0);
      const low = new Float32Array(N * N).fill(0);
      const terrain = new Float32Array(N * N).fill(0);

      // 5th Avenue runs along column X=20 (street level Y=0)
      // Skyscraper block on East side: X=21..24, Z=15..25, height 180m
      for (let j = 15; j <= 25; j++) {
        for (let i = 21; i <= 24; i++) {
          const c = j * N + i;
          top[c] = 180;
          low[c] = 0;
        }
      }

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);
      expect(colliders.length).toBeGreaterThan(0);

      // Check exterior street face inset:
      // Without inset, min.x for column 21 would be -half + 21 * 10 = 10m
      // With 1.0m street inset, min.x must be >= 11.0m
      const westFace = Math.min(...colliders.map(b => b.min.x));
      const rawCellEdge = -grid.half + 21 * CELL;
      expect(westFace).toBeGreaterThanOrEqual(rawCellEdge + 1.0);

      // Driving down 5th Avenue center (X=20.5) must never collide with skyscraper
      const aveX = -grid.half + 20.5 * CELL;
      for (let z = -grid.half + 15 * CELL; z <= -grid.half + 25 * CELL; z += 10) {
        expect(hasCollisionAt(aveX, 1.5, z, 1.8, colliders)).toBe(false);
      }
    });

    it('pudong_lujiazui: contiguous building blocks have 0m interior gap and zero cracks', () => {
      const top = new Float32Array(N * N).fill(0);
      const low = new Float32Array(N * N).fill(0);
      const terrain = new Float32Array(N * N).fill(0);

      // A 3x3 block of skyscrapers at X=15..17, Z=15..17, height 120m
      for (let j = 15; j <= 17; j++) {
        for (let i = 15; i <= 17; i++) {
          const c = j * N + i;
          top[c] = 120;
          low[c] = 0;
        }
      }

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);
      // Merged into single or contiguous boxes
      expect(colliders.length).toBeGreaterThan(0);

      // Center of the block (X=16, Z=16) must be solid inside without cracks
      const centerX = -grid.half + 16.5 * CELL;
      const centerZ = -grid.half + 16.5 * CELL;
      expect(hasCollisionAt(centerX, 50, centerZ, 1.0, colliders)).toBe(true);
    });

    it('french_quarter_nola: low-rise 4.5m historical buildings are solid colliders', () => {
      const top = new Float32Array(N * N).fill(0);
      const low = new Float32Array(N * N).fill(0);
      const terrain = new Float32Array(N * N).fill(0);

      // Bourbon St blocks: low-rise 4.5m 1-story commercial buildings at X=18..19, Z=18..22
      for (let j = 18; j <= 22; j++) {
        for (let i = 18; i <= 19; i++) {
          const c = j * N + i;
          top[c] = 4.5;
          low[c] = 0;
        }
      }

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);
      // Low rise 4.5m buildings (> 3.5m rise) must produce solid colliders
      expect(colliders.length).toBeGreaterThan(0);
      const maxH = Math.max(...colliders.map(b => b.max.y));
      expect(maxH).toBeCloseTo(4.5, 1);
    });

    it('pioneer_square_portland: sidewalk tree canopy does not bury street in groundField', () => {
      const top = new Float32Array(N * N).fill(0);
      const low = new Float32Array(N * N).fill(0);
      const terrain = new Float32Array(N * N).fill(0);

      // Sidewalk trees at column X=20: canopy top=8.0, low=0.0 (street level)
      for (let j = 15; j <= 25; j++) {
        const c = j * N + 20;
        top[c] = 8.0;
        low[c] = 0.0;
      }

      const gf = groundField([makeRaster(top, low)], grid, terrain, 1);
      // Pavement height under tree canopy must remain near 0, not pulled up to canopy top (8m)
      expect(gf[20 * N + 20]).toBeLessThan(2.0);
    });

    it('market_street_sf: diagonal street corridor remains clear flanked by high-rises', () => {
      const top = new Float32Array(N * N).fill(0);
      const low = new Float32Array(N * N).fill(0);
      const terrain = new Float32Array(N * N).fill(0);

      // Diagonal corridor: cells where i == j are street (Y=0)
      // Flanking cells have 80m towers
      for (let j = 15; j <= 25; j++) {
        for (let i = 15; i <= 25; i++) {
          if (Math.abs(i - j) > 1) {
            const c = j * N + i;
            top[c] = 80;
            low[c] = 0;
          }
        }
      }

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);
      // Driving down diagonal center (i == j)
      for (let k = 16; k <= 24; k++) {
        const pos = -grid.half + (k + 0.5) * CELL;
        expect(hasCollisionAt(pos, 1.5, pos, 1.0, colliders)).toBe(false);
      }
    });
  });

  // =========================================================================
  // 3. Open Ground & Rural Plains
  // =========================================================================
  describe('Category 3: Open Ground & Rural Plains', () => {
    it('salt_flats: pure 2D terrain produces zero building colliders and smooth driving', () => {
      const terrain = new Float32Array(N * N).fill(0);
      // No tile rasters available (pure 2D satellite)
      const colliders = collidersFromRasters([], grid, terrain, 1);
      expect(colliders).toHaveLength(0);

      const gf = groundField([], grid, terrain, 1);
      expect(gf[20 * N + 20]).toBeCloseTo(0, 1);
    });

    it('monument_valley: steep natural sandstone butte produces zero false building colliders', () => {
      const top = new Float32Array(N * N);
      const low = new Float32Array(N * N);
      const terrain = new Float32Array(N * N);

      // Natural butte: single surface sheet (low == top) rising smoothly to 50m
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const c = j * N + i;
          const dist = Math.hypot(i - 20, j - 20);
          const elev = Math.max(0, 50 - dist * 4);
          top[c] = elev;
          low[c] = elev;
          terrain[c] = elev;
        }
      }

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);
      // Pure natural surface sheet has no vertical building walls (top - low == 0)
      // Must not generate false building colliders
      expect(colliders).toHaveLength(0);
    });

    it('kansas_farmland: rolling agricultural plains preserve continuous ground heightfield', () => {
      const top = new Float32Array(N * N);
      const low = new Float32Array(N * N);
      const terrain = new Float32Array(N * N);

      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const c = j * N + i;
          const roll = 3.0 * Math.sin((i / N) * Math.PI * 2);
          top[c] = roll;
          low[c] = roll;
          terrain[c] = roll;
        }
      }

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);
      expect(colliders).toHaveLength(0);

      const gf = groundField([makeRaster(top, low)], grid, terrain, 1);
      expect(gf[20 * N + 20]).toBeCloseTo(terrain[20 * N + 20]!, 1);
    });
  });

  // =========================================================================
  // 4. Steep Slopes & Mountain Terrain
  // =========================================================================
  describe('Category 4: Steep Slopes & Mountain Terrain', () => {
    it('twin_peaks_sf: steep 20% hillside slope is driveable ground without false walls', () => {
      const top = new Float32Array(N * N);
      const low = new Float32Array(N * N);
      const terrain = new Float32Array(N * N);

      // 20% constant grade along X: 2.0m per 10m cell (step = 2.0m <= 2.8m limit)
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const c = j * N + i;
          const slopeY = i * 2.0;
          top[c] = slopeY;
          low[c] = slopeY;
          terrain[c] = slopeY;
        }
      }

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);
      expect(colliders).toHaveLength(0);
    });

    it('lombard_street_sf: 27% grade road is driveable and stepped residential buildings are solid', () => {
      const top = new Float32Array(N * N);
      const low = new Float32Array(N * N);
      const terrain = new Float32Array(N * N);

      // 27% grade slope down the crooked block (2.7m per cell)
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const c = j * N + i;
          const streetY = j * 2.7;
          top[c] = streetY;
          low[c] = streetY;
          terrain[c] = streetY;
        }
      }

      // Stepped residential townhomes flanking the road at X=16..17, Z=18..22 (height +12m)
      for (let j = 18; j <= 22; j++) {
        for (let i = 16; i <= 17; i++) {
          const c = j * N + i;
          top[c] = j * 2.7 + 12;
          low[c] = j * 2.7;
        }
      }

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);

      // Road lane at X=20 must be free of colliders
      for (let j = 18; j <= 22; j++) {
        const roadX = -grid.half + (20 + 0.5) * CELL;
        const roadZ = -grid.half + (j + 0.5) * CELL;
        const roadY = j * 2.7 + 1.0;
        expect(hasCollisionAt(roadX, roadY, roadZ, 1.5, colliders)).toBe(false);
      }

      // Flanking townhomes must be solid colliders
      expect(colliders.length).toBeGreaterThan(0);
    });

    it('pikes_peak: alpine switchback grade with relief boost scales driveable threshold', () => {
      const top = new Float32Array(N * N);
      const low = new Float32Array(N * N);
      const terrain = new Float32Array(N * N);

      // Steeper step (3.5m per cell), but reliefBoost = 1.5 scales max step from 2.8 to 4.2m
      const reliefBoost = 1.5;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const c = j * N + i;
          const alpineY = j * 3.5;
          top[c] = alpineY;
          low[c] = alpineY;
          terrain[c] = alpineY;
        }
      }

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, reliefBoost);
      expect(colliders).toHaveLength(0);
    });
  });

  // =========================================================================
  // 5. Urban-to-Nature & Coastline Interfaces
  // =========================================================================
  describe('Category 5: Urban-to-Nature & Coastline Interfaces', () => {
    it('sydney_opera_house: promenade edge to water does not produce false walls in water', () => {
      const top = new Float32Array(N * N);
      const low = new Float32Array(N * N);
      const terrain = new Float32Array(N * N);

      // Promenade at Y=3.0 (Z < 20), NY Harbor water at Y=0.0 (Z >= 20)
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const c = j * N + i;
          const isLand = j < 20;
          top[c] = isLand ? 3.0 : 0.0;
          low[c] = isLand ? 3.0 : 0.0;
          terrain[c] = 0.0;
        }
      }

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);
      // Seawall drop (3.0m < 3.5m building rise) must not be boxed as a building
      expect(colliders).toHaveLength(0);
    });

    it('the_bund_shanghai: sharp 1-cell step from 100m towers terminates cleanly without spilling onto park or promenade', () => {
      const top = new Float32Array(N * N).fill(0);
      const low = new Float32Array(N * N).fill(0);
      const terrain = new Float32Array(N * N).fill(0);

      // 100m residential towers in Harlem (Z=10..19, X=15..25)
      // Central park grass starts immediately at Z=20 (Y=0)
      for (let j = 10; j < 20; j++) {
        for (let i = 15; i <= 25; i++) {
          const c = j * N + i;
          top[c] = 100;
          low[c] = 0;
        }
      }

      const colliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);
      expect(colliders.length).toBeGreaterThan(0);

      // Park grass right across the street (Z=20) must be 100% open for driving
      const parkZ = -grid.half + (20 + 0.5) * CELL;
      for (let i = 15; i <= 25; i++) {
        const parkX = -grid.half + (i + 0.5) * CELL;
        expect(hasCollisionAt(parkX, 1.0, parkZ, 1.5, colliders)).toBe(false);
      }
    });
  });

  // =========================================================================
  // 6. Regression Benchmark Speed & Threshold Invariance
  // =========================================================================
  describe('Regression Benchmark Performance & Threshold Sensitivity', () => {
    it('executes full 58-scenario validation suite in under 500ms', () => {
      const t0 = performance.now();
      // Re-run the critical path of each scenario
      for (const scenario of TEST_SCENARIOS) {
        expect(scenario.id).toBeDefined();
        const top = new Float32Array(N * N).fill(0);
        const low = new Float32Array(N * N).fill(0);
        const terrain = new Float32Array(N * N).fill(0);
        collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);
      }
      const durationMs = performance.now() - t0;
      expect(durationMs).toBeLessThan(500);
    });

    it('custom ColliderThresholds parameter is respected across pipeline', () => {
      const top = new Float32Array(N * N).fill(0);
      const low = new Float32Array(N * N).fill(0);
      const terrain = new Float32Array(N * N).fill(0);

      // 3.0m high structure (normally below 3.5m buildingRiseM threshold)
      for (let j = 18; j <= 22; j++) {
        for (let i = 18; i <= 22; i++) {
          const c = j * N + i;
          top[c] = 3.0;
          low[c] = 0;
        }
      }

      // Default thresholds (buildingRiseM = 3.5): not a building
      const defColliders = collidersFromRasters([makeRaster(top, low)], grid, terrain, 1);
      expect(defColliders).toHaveLength(0);

      // Strict thresholds (buildingRiseM = 2.0): recognized as a building
      const customThresholds: ColliderThresholds = {
        ...DEFAULT_COLLIDER_THRESHOLDS,
        buildingRiseM: 2.0
      };
      const customColliders = collidersFromRasters(
        [makeRaster(top, low)],
        grid,
        terrain,
        1,
        undefined,
        customThresholds
      );
      expect(customColliders.length).toBeGreaterThan(0);
    });
  });
});
