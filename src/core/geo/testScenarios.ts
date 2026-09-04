/**
 * Curated GPS benchmark test scenarios representing diverse terrain, 3D tiles,
 * bridges, steep slopes, and open ground environments.
 */

export type ScenarioCategory =
  | 'bridge_water'
  | 'dense_city'
  | 'open_ground'
  | 'steep_slope'
  | 'coast_interface';

export interface TestScenario {
  readonly id: string;
  readonly name: string;
  readonly category: ScenarioCategory;
  readonly categoryLabel: string;
  readonly lat: number;
  readonly lon: number;
  readonly label: string;
  readonly description: string;
  readonly testFocus: string;
  readonly recommendedVehicleType?: number; // 0=buggy, 1=muscle, 2=pickup, 3=semi, 4=coupe, 5=monster
}

export const TEST_SCENARIOS: readonly TestScenario[] = [
  // ---- 1. Bridges, Water & Multi-Deck Driving ----
  {
    id: 'brooklyn_bridge',
    name: 'Brooklyn Bridge, NY',
    category: 'bridge_water',
    categoryLabel: '🌉 Bridges & Water',
    lat: 40.7061,
    lon: -73.9969,
    label: 'Brooklyn Bridge, New York, NY',
    description: 'Suspension bridge spanning the East River between Manhattan and Brooklyn.',
    testFocus: 'Multi-deck bridge roadway driving; zero false water-to-deck building blocks; suspension cable towers.',
    recommendedVehicleType: 1 // muscle
  },
  {
    id: 'golden_gate_bridge',
    name: 'Golden Gate Bridge, SF',
    category: 'bridge_water',
    categoryLabel: '🌉 Bridges & Water',
    lat: 37.8199,
    lon: -122.4783,
    label: 'Golden Gate Bridge, San Francisco, CA',
    description: 'High-altitude suspension span ~67m above Pacific ocean water.',
    testFocus: 'Extreme elevation above water; long roadway span; bridge deck raycasting without falling to ocean.',
    recommendedVehicleType: 2 // pickup
  },
  {
    id: 'hawthorne_bridge',
    name: 'Hawthorne Bridge, Portland',
    category: 'bridge_water',
    categoryLabel: '🌉 Bridges & Water',
    lat: 45.5132,
    lon: -122.6708,
    label: 'Hawthorne Bridge, Portland, OR',
    description: 'Truss lift bridge across the Willamette River connecting downtown Portland.',
    testFocus: 'Truss bridge roadway driving; low-clearance piers; connection to city street grid.',
    recommendedVehicleType: 0 // buggy
  },

  // ---- 2. Dense 3D Photogrammetry Cities ----
  {
    id: 'midtown_manhattan',
    name: 'Empire State / 5th Ave, NY',
    category: 'dense_city',
    categoryLabel: '🏙️ Dense 3D Cities',
    lat: 40.7484,
    lon: -73.9857,
    label: 'Empire State Building, 5th Ave, New York, NY',
    description: 'Dense skyscraper canyon with high-density building facades and avenues.',
    testFocus: 'Skyscraper colliders; 10m grid stair-step clearance; zero invisible wall collisions in driving lanes.',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'broadway_financial',
    name: 'Broadway & Wall St, NY',
    category: 'dense_city',
    categoryLabel: '🏙️ Dense 3D Cities',
    lat: 40.7075,
    lon: -74.0113,
    label: 'Broadway & Wall St, New York, NY',
    description: 'Historical financial district with narrow diagonal streets and high-rise facades.',
    testFocus: 'Diagonal street orientation cutting across 10m grid; narrow lane navigation without corner snags.',
    recommendedVehicleType: 0 // buggy
  },
  {
    id: 'french_quarter_nola',
    name: 'French Quarter, New Orleans',
    category: 'dense_city',
    categoryLabel: '🏙️ Dense 3D Cities',
    lat: 29.9584,
    lon: -90.0644,
    label: 'Bourbon St & Royal St, French Quarter, New Orleans, LA',
    description: 'Low-rise historical architecture with overhanging balconies and dense street grid.',
    testFocus: 'Overhanging 2nd-floor balcony clearance; sea-level flat elevation grid; tight intersection turns.',
    recommendedVehicleType: 1 // muscle
  },
  {
    id: 'pioneer_square_portland',
    name: 'Pioneer Square, Portland',
    category: 'dense_city',
    categoryLabel: '🏙️ Dense 3D Cities',
    lat: 45.5189,
    lon: -122.6793,
    label: 'Pioneer Courthouse Square, Portland, OR',
    description: 'Compact 60m (200ft) block downtown grid with light rail tracks and street trees.',
    testFocus: 'Sidewalk tree canopy exclusion; curb contact; short-block turning maneuverability.',
    recommendedVehicleType: 0 // buggy
  },

  // ---- 3. Open Ground & Rural Plains (Pure 2D Satellite) ----
  {
    id: 'salt_flats',
    name: 'Bonneville Salt Flats, UT',
    category: 'open_ground',
    categoryLabel: '🏜️ Open Ground Textures',
    lat: 40.7624,
    lon: -113.8963,
    label: 'Bonneville Salt Flats, Tooele County, UT',
    description: 'Vast, perfectly flat expanse of open salt crust with zero 3D photogrammetry tiles.',
    testFocus: 'Pure 2D satellite texture streaming (Zoom 18 patches); high-speed top-velocity driving; zero tiles.',
    recommendedVehicleType: 1 // muscle
  },
  {
    id: 'monument_valley',
    name: 'Monument Valley, AZ/UT',
    category: 'open_ground',
    categoryLabel: '🏜️ Open Ground Textures',
    lat: 36.9980,
    lon: -110.0985,
    label: 'Monument Valley Navajo Tribal Park, AZ/UT',
    description: 'Prominent sandstone buttes rising from broad desert plateau.',
    testFocus: 'Smooth elevation grid interpolation on steep natural buttes; natural desert satellite palette.',
    recommendedVehicleType: 5 // monster truck
  },
  {
    id: 'kansas_farmland',
    name: 'Kansas Farmland, KS',
    category: 'open_ground',
    categoryLabel: '🏜️ Open Ground Textures',
    lat: 39.1834,
    lon: -99.3001,
    label: 'Rooks County Agricultural Plains, KS',
    description: 'Endless rolling agricultural grid patchwork.',
    testFocus: 'Continuous 5.6km Web Mercator tile stitching across large distances; zero texture distortion.',
    recommendedVehicleType: 3 // semi
  },

  // ---- 4. Steep Slopes & Mountain Terrain ----
  {
    id: 'twin_peaks_sf',
    name: 'Twin Peaks, San Francisco',
    category: 'steep_slope',
    categoryLabel: '⛰️ Steep Slopes & Hills',
    lat: 37.7544,
    lon: -122.4477,
    label: 'Twin Peaks Summit, San Francisco, CA',
    description: 'Severe 280m urban summit with steep grades and switchback roads overlooking the bay.',
    testFocus: 'Steep hill-climbing physics; crest launching; morphological opening preserving natural hill slope.',
    recommendedVehicleType: 2 // pickup
  },
  {
    id: 'lombard_street_sf',
    name: 'Lombard Street, SF',
    category: 'steep_slope',
    categoryLabel: '⛰️ Steep Slopes & Hills',
    lat: 37.8021,
    lon: -122.4187,
    label: 'Lombard St Crooked Block, San Francisco, CA',
    description: 'Famous 27% grade crooked street with tight 8 hairpin switchbacks.',
    testFocus: 'Extreme grade suspension snapping; tight hairpin steering on slopes; building facade step down slope.',
    recommendedVehicleType: 0 // buggy
  },
  {
    id: 'pikes_peak',
    name: 'Pikes Peak Highway, CO',
    category: 'steep_slope',
    categoryLabel: '⛰️ Steep Slopes & Hills',
    lat: 38.8405,
    lon: -105.0442,
    label: 'Pikes Peak Highway, Cascade, CO',
    description: 'Alpine highway climbing from 2,300m to 4,300m elevation.',
    testFocus: 'Extreme elevation range (relief boost calculation); mountain switchback roads.',
    recommendedVehicleType: 5 // monster truck
  },

  // ---- 5. Urban-to-Nature & Coastline Interfaces ----
  {
    id: 'battery_park_seawall',
    name: 'Battery Park Seawall, NY',
    category: 'coast_interface',
    categoryLabel: '🌊 Shoreline & Interfaces',
    lat: 40.7033,
    lon: -74.0170,
    label: 'Battery Park & Harbor Seawall, New York, NY',
    description: 'Southern tip of Manhattan where dense urban park and promenade meet NY Harbor.',
    testFocus: '3D photogrammetry seawall meeting water; zero floating drape sheets over harbor water.',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'central_park_north',
    name: 'Central Park Interface, NY',
    category: 'coast_interface',
    categoryLabel: '🌊 Shoreline & Interfaces',
    lat: 40.7967,
    lon: -73.9554,
    label: 'Central Park North & Harlem Meer, New York, NY',
    description: 'Immediate transition from 100m+ dense residential high-rises to open parkland and water.',
    testFocus: 'Sharp interface between 3D photogrammetry city blocks and open park terrain; perimeter alignment.',
    recommendedVehicleType: 2 // pickup
  }
];

/** Parse a raw query string to check if it contains GPS coordinates like "40.7061, -73.9969". */
export function parseGpsString(query: string): { lat: number; lon: number } | null {
  const match = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const lat = parseFloat(match[1]!);
  const lon = parseFloat(match[2]!);
  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/** Lookup a scenario by unique ID. */
export function getScenario(id: string): TestScenario | undefined {
  return TEST_SCENARIOS.find(s => s.id.toLowerCase() === id.toLowerCase());
}

/** Find if coordinates match a known test scenario within ~500m tolerance. */
export function findScenarioByCoords(lat: number, lon: number, toleranceDeg = 0.005): TestScenario | undefined {
  return TEST_SCENARIOS.find(s => Math.hypot(s.lat - lat, s.lon - lon) <= toleranceDeg);
}
