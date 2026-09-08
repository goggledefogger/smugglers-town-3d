import { describe, it, expect } from 'vitest';
import {
  TEST_SCENARIOS,
  getScenario,
  parseGpsString,
  findScenarioByCoords,
  type ScenarioCategory
} from '../src/core/geo/testScenarios.ts';

describe('TEST_SCENARIOS catalog', () => {
  it('contains at least 50 diverse global scenarios', () => {
    expect(TEST_SCENARIOS.length).toBeGreaterThanOrEqual(50);
  });

  it('has unique IDs for every scenario', () => {
    const ids = TEST_SCENARIOS.map(s => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('has valid WGS84 coordinates for every scenario', () => {
    for (const s of TEST_SCENARIOS) {
      expect(s.lat).toBeGreaterThanOrEqual(-90);
      expect(s.lat).toBeLessThanOrEqual(90);
      expect(s.lon).toBeGreaterThanOrEqual(-180);
      expect(s.lon).toBeLessThanOrEqual(180);
    }
  });

  it('has non-empty names, descriptions, labels, and test foci', () => {
    for (const s of TEST_SCENARIOS) {
      expect(s.name.trim().length).toBeGreaterThan(0);
      expect(s.description.trim().length).toBeGreaterThan(0);
      expect(s.label.trim().length).toBeGreaterThan(0);
      expect(s.testFocus.trim().length).toBeGreaterThan(0);
      expect(s.categoryLabel.trim().length).toBeGreaterThan(0);
      if (s.recommendedVehicleType !== undefined) {
        expect(s.recommendedVehicleType).toBeGreaterThanOrEqual(0);
        expect(s.recommendedVehicleType).toBeLessThanOrEqual(5);
      }
    }
  });

  it('covers all nine required testing scenario categories with multiple locations each', () => {
    const requiredCategories: ScenarioCategory[] = [
      'bridge_water',
      'dense_city',
      'open_ground',
      'steep_slope',
      'coast_interface',
      'racing_circuits',
      'historic_landmarks',
      'mountain_passes',
      'islands_waterways'
    ];
    for (const cat of requiredCategories) {
      const matches = TEST_SCENARIOS.filter(s => s.category === cat);
      expect(matches.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('getScenario', () => {
  it('retrieves scenario by exact ID', () => {
    const s = getScenario('brooklyn_bridge');
    expect(s).toBeDefined();
    expect(s?.name).toContain('Brooklyn Bridge');
    expect(s?.lat).toBeCloseTo(40.7061, 3);
  });

  it('retrieves scenario case-insensitively', () => {
    const s = getScenario('GOLDEN_GATE_BRIDGE');
    expect(s).toBeDefined();
    expect(s?.id).toBe('golden_gate_bridge');
  });

  it('returns undefined for nonexistent scenario', () => {
    expect(getScenario('nonexistent_place_xyz')).toBeUndefined();
  });
});

describe('parseGpsString', () => {
  it('parses standard float lat, lon', () => {
    const res = parseGpsString('40.7061, -73.9969');
    expect(res).not.toBeNull();
    expect(res?.lat).toBeCloseTo(40.7061, 4);
    expect(res?.lon).toBeCloseTo(-73.9969, 4);
  });

  it('parses coordinates with irregular whitespace', () => {
    const res = parseGpsString('   37.8199   ,    -122.4783   ');
    expect(res).not.toBeNull();
    expect(res?.lat).toBeCloseTo(37.8199, 4);
    expect(res?.lon).toBeCloseTo(-122.4783, 4);
  });

  it('parses integer coordinates', () => {
    const res = parseGpsString('40, -74');
    expect(res).not.toBeNull();
    expect(res?.lat).toBe(40);
    expect(res?.lon).toBe(-74);
  });

  it('rejects regular text queries without coordinates', () => {
    expect(parseGpsString('New York City')).toBeNull();
    expect(parseGpsString('Paris, France')).toBeNull();
    expect(parseGpsString('Empire State Building')).toBeNull();
  });

  it('rejects out-of-range coordinates', () => {
    expect(parseGpsString('95.0, 10.0')).toBeNull(); // lat > 90
    expect(parseGpsString('-95.0, 10.0')).toBeNull(); // lat < -90
    expect(parseGpsString('40.0, 190.0')).toBeNull(); // lon > 180
    expect(parseGpsString('40.0, -190.0')).toBeNull(); // lon < -180
  });

  it('rejects malformed coordinate strings', () => {
    expect(parseGpsString('40.0,')).toBeNull();
    expect(parseGpsString(',-73.0')).toBeNull();
    expect(parseGpsString('abc, def')).toBeNull();
  });
});

describe('findScenarioByCoords', () => {
  it('identifies scenario within default tolerance (~500m)', () => {
    // Brooklyn bridge is at 40.7061, -73.9969
    const s = findScenarioByCoords(40.7062, -73.9968);
    expect(s).toBeDefined();
    expect(s?.id).toBe('brooklyn_bridge');
  });

  it('returns undefined if coordinates are far away from all benchmark scenarios', () => {
    const s = findScenarioByCoords(0, 0);
    expect(s).toBeUndefined();
  });
});
