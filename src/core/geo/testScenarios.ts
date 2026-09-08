/**
 * Curated GPS benchmark test scenarios representing diverse terrain, 3D tiles,
 * bridges, steep slopes, and open ground environments.
 */

export type ScenarioCategory =
  | 'bridge_water'
  | 'dense_city'
  | 'open_ground'
  | 'steep_slope'
  | 'coast_interface'
  | 'racing_circuits'
  | 'historic_landmarks'
  | 'mountain_passes'
  | 'islands_waterways';

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
  {
    id: 'st_johns_bridge',
    name: 'St. Johns Bridge, Portland',
    category: 'bridge_water',
    categoryLabel: '🌉 Bridges & Water',
    lat: 45.5898,
    lon: -122.7661,
    label: 'St. Johns Bridge & Cathedral Park, Portland, OR',
    description: 'Gothic suspension bridge with soaring 120m steel towers and Cathedral Park underpass.',
    testFocus: 'Cathedral Park underpass drivability; tower pier box colliders; elevated deck above river.',
    recommendedVehicleType: 1 // muscle
  },
  {
    id: 'tower_bridge_london',
    name: 'Tower Bridge, London, UK',
    category: 'bridge_water',
    categoryLabel: '🌉 Bridges & Water',
    lat: 51.5055,
    lon: -0.0754,
    label: 'Tower Bridge & River Thames, London, United Kingdom',
    description: 'Iconic Victorian Gothic bascule and suspension bridge crossing the River Thames.',
    testFocus: 'Twin stone tower colliders; elevated bascule deck driving; Thames river boundary clipping.',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'sydney_harbour_bridge',
    name: 'Sydney Harbour Bridge, Australia',
    category: 'bridge_water',
    categoryLabel: '🌉 Bridges & Water',
    lat: -33.8523,
    lon: 151.2108,
    label: 'Sydney Harbour Bridge, Sydney, NSW, Australia',
    description: 'Massive steel through arch bridge carrying Bradfield Highway 52m above Sydney Harbour.',
    testFocus: 'High-span multi-lane road deck above deep water; massive stone pylon base colliders; arch superstructure.',
    recommendedVehicleType: 3 // semi
  },
  {
    id: 'pont_du_gard',
    name: 'Pont du Gard, France',
    category: 'bridge_water',
    categoryLabel: '🌉 Bridges & Water',
    lat: 43.9476,
    lon: 4.5350,
    label: 'Pont du Gard Roman Aqueduct, Vers-Pont-du-Gard, France',
    description: 'Ancient three-tier Roman aqueduct bridge built of limestone blocks across the Gardon river valley.',
    testFocus: 'Triple-tier open arch clearance; valley floor road approaches; riverbed terrain transition.',
    recommendedVehicleType: 0 // buggy
  },
  {
    id: 'bosphorus_bridge',
    name: 'Bosphorus Bridge, Istanbul, Turkey',
    category: 'bridge_water',
    categoryLabel: '🌉 Bridges & Water',
    lat: 41.0453,
    lon: 29.0344,
    label: '15 July Martyrs Bridge (Bosphorus), Istanbul, Turkey',
    description: 'Intercontinental suspension bridge connecting Europe (Ortaköy) and Asia (Beylerbeyi) across the Bosphorus strait.',
    testFocus: 'Continental landmass connection across deep marine strait; high suspension roadway grade.',
    recommendedVehicleType: 1 // muscle
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
    id: 'pudong_lujiazui_shanghai',
    name: 'Pudong & Shanghai Tower, China',
    category: 'dense_city',
    categoryLabel: '🏙️ Dense 3D Cities',
    lat: 31.2397,
    lon: 121.5000,
    label: 'Century Avenue & Lujiazui Ring, Pudong, Shanghai, China',
    description: 'Futuristic financial district featuring the 632m Shanghai Tower, Jin Mao Tower, and circular pedestrian skybridge.',
    testFocus: 'Super-tall skyscraper colliders; multi-lane roundabout rings; circular elevated pedestrian skyway.',
    recommendedVehicleType: 4 // coupe
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
  {
    id: 'market_street_sf',
    name: 'Market & Montgomery, SF',
    category: 'dense_city',
    categoryLabel: '🏙️ Dense 3D Cities',
    lat: 37.7897,
    lon: -122.4014,
    label: 'Market St & Montgomery St, Financial District, San Francisco, CA',
    description: 'Diagonal grand boulevard cutting across orthogonal street grid flanked by skyscrapers.',
    testFocus: 'Diagonal street canyon; building corner insets; transition towards steep Nob Hill grade.',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'shinjuku_shibuya_tokyo',
    name: 'Shinjuku & Shibuya, Tokyo, Japan',
    category: 'dense_city',
    categoryLabel: '🏙️ Dense 3D Cities',
    lat: 35.6595,
    lon: 139.7005,
    label: 'Shibuya Scramble Crossing & Dogenzaka, Tokyo, Japan',
    description: 'Ultra-dense neon canyons, multi-level pedestrian scramble, and train viaducts.',
    testFocus: 'Complex elevated railway overpasses; tight Japanese urban alleyways; high polygon density photogrammetry.',
    recommendedVehicleType: 0 // buggy
  },
  {
    id: 'city_of_london',
    name: 'The City & Gherkin, London, UK',
    category: 'dense_city',
    categoryLabel: '🏙️ Dense 3D Cities',
    lat: 51.5145,
    lon: -0.0803,
    label: 'St Mary Axe & Leadenhall, City of London, United Kingdom',
    description: 'Historic Roman-medieval winding street pattern juxtaposed against glass super-tall towers.',
    testFocus: 'Curved medieval street lanes; unconventional curved building footprints (The Gherkin, Walkie-Talkie).',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'downtown_dubai',
    name: 'Downtown & Burj Khalifa, Dubai',
    category: 'dense_city',
    categoryLabel: '🏙️ Dense 3D Cities',
    lat: 25.1972,
    lon: 55.2744,
    label: 'Sheikh Mohammed bin Rashid Blvd & Burj Khalifa, Dubai, UAE',
    description: 'Vast boulevard looping around the world\'s tallest structure, artificial lakes, and futuristic towers.',
    testFocus: 'Kilometer-scale building altitude colliders; wide multi-lane boulevards; ground reflection contrast.',
    recommendedVehicleType: 1 // muscle
  },
  {
    id: 'marina_bay_singapore',
    name: 'Marina Bay, Singapore',
    category: 'dense_city',
    categoryLabel: '🏙️ Dense 3D Cities',
    lat: 1.2838,
    lon: 103.8591,
    label: 'Marina Boulevard & Bayfront, Singapore',
    description: 'Futuristic waterfront skyline with integrated Formula 1 Marina Bay street circuit roads.',
    testFocus: 'F1 street curbs and barriers; tropical park interface with dense financial skyscrapers; bridge ramps.',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'avenida_9_de_julio',
    name: 'Avenida 9 de Julio, Buenos Aires',
    category: 'dense_city',
    categoryLabel: '🏙️ Dense 3D Cities',
    lat: -34.6037,
    lon: -58.3816,
    label: 'Avenida 9 de Julio & Obelisco, Buenos Aires, Argentina',
    description: 'One of the widest avenues on Earth spanning 140m across 16 lanes with central bus corridors and monuments.',
    testFocus: 'Ultra-wide roadway lane recognition; center-median monument colliders; expansive urban street surface.',
    recommendedVehicleType: 3 // semi
  },

  // ---- 3. Grand Prix & Race Tracks ----
  {
    id: 'circuit_monaco',
    name: 'Circuit de Monaco (Hairpin), Monaco',
    category: 'racing_circuits',
    categoryLabel: '🏎️ Grand Prix & Race Tracks',
    lat: 43.7402,
    lon: 7.4297,
    label: 'Fairmont Hairpin & Port Hercules, Circuit de Monaco, Monte Carlo',
    description: 'The world\'s most famous street circuit, featuring the legendary slowest hairpin and sea-facing descent.',
    testFocus: 'Extreme camber and downhill slope hairpin turns; tunnel entrance lighting; yacht harbor seawall.',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'nurburgring_nordschleife',
    name: 'Nürburgring Nordschleife, Germany',
    category: 'racing_circuits',
    categoryLabel: '🏎️ Grand Prix & Race Tracks',
    lat: 50.3356,
    lon: 6.9692,
    label: 'Caracciola Karussell, Nürburgring Nordschleife, Nürburg, Germany',
    description: 'The legendary 20.8km "Green Hell" through the Eifel forest with blind crests and banked concrete turns.',
    testFocus: 'Banked concrete Karussell surface; undulating roller-coaster elevation; forest clearing canopy.',
    recommendedVehicleType: 1 // muscle
  },
  {
    id: 'spa_francorchamps',
    name: 'Spa-Francorchamps (Eau Rouge), Belgium',
    category: 'racing_circuits',
    categoryLabel: '🏎️ Grand Prix & Race Tracks',
    lat: 50.4372,
    lon: 5.9714,
    label: 'Eau Rouge & Raidillon, Circuit de Spa-Francorchamps, Stavelot, Belgium',
    description: 'Iconic uphill sweeping corner compressing into a blind downhill crest in the Ardennes.',
    testFocus: 'Extreme vertical g-force compression dip into steep uphill hillclimb; high speed asphalt tracking.',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'suzuka_circuit',
    name: 'Suzuka Circuit (S-Curves), Japan',
    category: 'racing_circuits',
    categoryLabel: '🏎️ Grand Prix & Race Tracks',
    lat: 34.8431,
    lon: 136.5410,
    label: 'Esses & Crossover Bridge, Suzuka International Circuit, Mie, Japan',
    description: 'Figure-eight racing track featuring rhythmic technical rhythm turns and a highway crossover bridge.',
    testFocus: 'Overpass roadway crossing over lower track section; rhythmic cambered S-curve transitions.',
    recommendedVehicleType: 0 // buggy
  },
  {
    id: 'mount_panorama_bathurst',
    name: 'Mount Panorama (Bathurst), Australia',
    category: 'racing_circuits',
    categoryLabel: '🏎️ Grand Prix & Race Tracks',
    lat: -33.4475,
    lon: 149.5583,
    label: 'The Cutting & Skyline, Mount Panorama Circuit, Bathurst, NSW, Australia',
    description: 'Public mountain road circuit featuring a punishing 174m vertical climb and blind cliff drops.',
    testFocus: 'Severe 1:6 gradient mountain straight; high-speed descent along concrete barriers; off-camber crests.',
    recommendedVehicleType: 1 // muscle
  },
  {
    id: 'silverstone_copse',
    name: 'Silverstone Circuit (Copse), UK',
    category: 'racing_circuits',
    categoryLabel: '🏎️ Grand Prix & Race Tracks',
    lat: 52.0786,
    lon: -1.0169,
    label: 'Copse Corner & Hamilton Straight, Silverstone Circuit, Northamptonshire, UK',
    description: 'Historic British Grand Prix venue on former RAF airfield, famous for ultra-high-speed sweeping turns.',
    testFocus: 'Flat airfield top-speed aerodynamic stability; wide run-off areas; wide tarmac kerb recognition.',
    recommendedVehicleType: 4 // coupe
  },

  // ---- 4. Alpine Passes & Switchbacks ----
  {
    id: 'stelvio_pass',
    name: 'Stelvio Pass, Italian Alps',
    category: 'mountain_passes',
    categoryLabel: '🏔️ Alpine Passes & Switchbacks',
    lat: 46.5293,
    lon: 10.4530,
    label: 'Stelvio Pass 48 Hairpins, Ortler Alps, Italy',
    description: 'Legendary mountain pass at 2,757m featuring 48 stacked stone-walled switchback hairpin turns.',
    testFocus: 'Repeated stacked 180° hairpin switchbacks on steep alpine cliff face; retaining wall colliders.',
    recommendedVehicleType: 0 // buggy
  },
  {
    id: 'trollstigen_norway',
    name: 'Trollstigen ("Troll Path"), Norway',
    category: 'mountain_passes',
    categoryLabel: '🏔️ Alpine Passes & Switchbacks',
    lat: 62.4565,
    lon: 7.6698,
    label: 'Trollstigen Serpentine & Stigfossen Waterfall, Møre og Romsdal, Norway',
    description: 'Narrow serpentine mountain pass with a 1:11 incline winding past roaring glacial waterfalls.',
    testFocus: 'Steep fjord valley topography; stone arch bridge over waterfall rapids; sheer cliff proximity.',
    recommendedVehicleType: 2 // pickup
  },
  {
    id: 'transfagarasan_romania',
    name: 'Transfăgărășan Pass, Romania',
    category: 'mountain_passes',
    categoryLabel: '🏔️ Alpine Passes & Switchbacks',
    lat: 45.5978,
    lon: 24.6174,
    label: 'Transfăgărășan Alpine Highway, Făgăraș Mountains, Romania',
    description: 'High alpine pass crossing the Southern Carpathians, celebrated for sweeps, hairpins, and tunnels.',
    testFocus: 'Alpine switchback geometry across glacial cirques; mountain ridge elevation relief.',
    recommendedVehicleType: 1 // muscle
  },
  {
    id: 'mount_haruna_touge',
    name: 'Mount Haruna (Akina Touge), Japan',
    category: 'mountain_passes',
    categoryLabel: '🏔️ Alpine Passes & Switchbacks',
    lat: 36.4746,
    lon: 138.8778,
    label: 'Mount Haruna Consecutive Hairpins (Akina), Gunma, Japan',
    description: 'The world\'s most famous touge drift route, featuring tight downhill hairpins with drainage gutters.',
    testFocus: 'Narrow asphalt touge width; downhill drift cornering; roadside gutter and guardrail colliders.',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'guoliang_tunnel',
    name: 'Guoliang Cliff Road, China',
    category: 'mountain_passes',
    categoryLabel: '🏔️ Alpine Passes & Switchbacks',
    lat: 35.7265,
    lon: 113.6067,
    label: 'Guoliang Hanging Tunnel Road, Taihang Mountains, Henan, China',
    description: 'Hand-chiseled roadway carved directly into the sheer vertical cliff of the Taihang Mountains.',
    testFocus: 'Sheer vertical canyon cliff face; cliffside roadway overhang clearance; rock window drops.',
    recommendedVehicleType: 5 // monster truck
  },

  // ---- 5. Ancient & Historic Landmarks ----
  {
    id: 'colosseum_rome',
    name: 'Colosseum & Forum, Rome, Italy',
    category: 'historic_landmarks',
    categoryLabel: '🏛️ Ancient & Historic Landmarks',
    lat: 41.8902,
    lon: 12.4922,
    label: 'Colosseum & Via dei Fori Imperiali, Rome, Italy',
    description: 'Massive ancient Roman amphitheatre surrounded by cobbled boulevards and the Roman Forum ruins.',
    testFocus: 'Curved stone amphitheatre facade colliders; cobblestone street navigation; ancient ruin terrain.',
    recommendedVehicleType: 1 // muscle
  },
  {
    id: 'eiffel_tower_paris',
    name: 'Eiffel Tower & Champ de Mars, Paris',
    category: 'historic_landmarks',
    categoryLabel: '🏛️ Ancient & Historic Landmarks',
    lat: 48.8584,
    lon: 2.2945,
    label: 'Eiffel Tower, Pont d\'Iéna & Champ de Mars, Paris, France',
    description: 'Soaring 330m iron lattice landmark along the River Seine and expansive open park lawns.',
    testFocus: 'Four open-arch iron leg base colliders with drive-through open plaza underneath; Seine quayside roads.',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'acropolis_athens',
    name: 'Acropolis & Parthenon, Athens, Greece',
    category: 'historic_landmarks',
    categoryLabel: '🏛️ Ancient & Historic Landmarks',
    lat: 37.9715,
    lon: 23.7257,
    label: 'Acropolis & Dionysiou Areopagitou, Athens, Greece',
    description: 'Ancient citadel perched atop a sheer limestone outcrop overlooking Athens.',
    testFocus: 'Rocky natural citadel plateau rising 70m above city streets; perimeter promenade driving.',
    recommendedVehicleType: 0 // buggy
  },
  {
    id: 'giza_pyramids_egypt',
    name: 'Pyramids of Giza & Sphinx, Egypt',
    category: 'historic_landmarks',
    categoryLabel: '🏛️ Ancient & Historic Landmarks',
    lat: 29.9792,
    lon: 31.1342,
    label: 'Great Pyramid of Khufu & Giza Plateau, Cairo, Egypt',
    description: 'Monumental 4,500-year-old stone pyramids standing on desert plateau where Cairo meets the Sahara.',
    testFocus: 'Massive stepped pyramid colliders (140m height); desert sand to paved roadway boundary.',
    recommendedVehicleType: 5 // monster truck
  },
  {
    id: 'taj_mahal_agra',
    name: 'Taj Mahal & Yamuna River, India',
    category: 'historic_landmarks',
    categoryLabel: '🏛️ Ancient & Historic Landmarks',
    lat: 27.1751,
    lon: 78.0421,
    label: 'Taj Mahal Complex & Yamuna Riverfront, Agra, India',
    description: 'Ivory-white marble mausoleum on the south bank of the sacred Yamuna river.',
    testFocus: 'Symmetric marble plinth elevation; formal garden pathways; sandy seasonal riverbed interface.',
    recommendedVehicleType: 0 // buggy
  },
  {
    id: 'brandenburg_gate_berlin',
    name: 'Brandenburg Gate, Berlin, Germany',
    category: 'historic_landmarks',
    categoryLabel: '🏛️ Ancient & Historic Landmarks',
    lat: 52.5163,
    lon: 13.3777,
    label: 'Brandenburg Gate & Straße des 17. Juni, Berlin, Germany',
    description: '18th-century neoclassical monument linking Pariser Platz to the grand Tiergarten boulevard.',
    testFocus: 'Multi-column gate portal clearance; transition from pedestrian plaza to wide high-speed avenue.',
    recommendedVehicleType: 1 // muscle
  },

  // ---- 6. Islands & Canal Towns ----
  {
    id: 'venice_grand_canal',
    name: 'Grand Canal & Rialto, Venice, Italy',
    category: 'islands_waterways',
    categoryLabel: '🏝️ Islands & Canal Towns',
    lat: 45.4380,
    lon: 12.3359,
    label: 'Rialto Bridge & Grand Canal, Venice, Italy',
    description: 'Historic floating archipelago city built across 118 islands separated by canals and arched bridges.',
    testFocus: 'Dense canal water bounding narrow flagstone quays; arched stone footbridge incline bumps.',
    recommendedVehicleType: 0 // buggy
  },
  {
    id: 'santorini_oia',
    name: 'Santorini Caldera (Oia), Greece',
    category: 'islands_waterways',
    categoryLabel: '🏝️ Islands & Canal Towns',
    lat: 36.4618,
    lon: 25.3753,
    label: 'Oia Village & Volcanic Caldera Edge, Santorini, Greece',
    description: 'Whitewashed cliffside village perched 150m above a deep blue submerged volcanic caldera.',
    testFocus: 'Extreme vertical cliff face dropping straight to sea level; stepped whitewashed roof terraces.',
    recommendedVehicleType: 0 // buggy
  },
  {
    id: 'mont_saint_michel',
    name: 'Mont Saint-Michel, Normandy, France',
    category: 'islands_waterways',
    categoryLabel: '🏝️ Islands & Canal Towns',
    lat: 48.6360,
    lon: -1.5115,
    label: 'Mont Saint-Michel Abbey & Tidal Causeway, Normandy, France',
    description: 'Medieval abbey fortress island rising dramatically 80m from immense tidal sand and mudflats.',
    testFocus: 'Isolated island fortress connected by narrow elevated causeway bridge across vast tidal flats.',
    recommendedVehicleType: 2 // pickup
  },
  {
    id: 'palm_jumeirah_dubai',
    name: 'Palm Jumeirah Crescent, Dubai, UAE',
    category: 'islands_waterways',
    categoryLabel: '🏝️ Islands & Canal Towns',
    lat: 25.1308,
    lon: 55.1172,
    label: 'The Crescent & Fronds, Palm Jumeirah, Dubai, UAE',
    description: 'World-famous palm-tree-shaped artificial archipelago protected by an 11km crescent breakwater.',
    testFocus: 'Curved breakwater ring road between open Arabian Gulf waves and lagoon fronds; tunnel approaches.',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'amsterdam_canals',
    name: 'Amsterdam Canals (Prinsengracht), NL',
    category: 'islands_waterways',
    categoryLabel: '🏝️ Islands & Canal Towns',
    lat: 52.3667,
    lon: 4.8833,
    label: 'Prinsengracht & Keizersgracht Canal Ring, Amsterdam, Netherlands',
    description: '17th-century concentric canal rings lined with narrow gabled merchant houses and tree-lined quays.',
    testFocus: 'Narrow quayside streets with zero curbs dropping into canals; stone bridge crest humps.',
    recommendedVehicleType: 0 // buggy
  },

  // ---- 7. Steep Slopes & Mountain Terrain ----
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
  {
    id: 'santa_marta_favela_rio',
    name: 'Favela Santa Marta, Rio de Janeiro',
    category: 'steep_slope',
    categoryLabel: '⛰️ Steep Slopes & Hills',
    lat: -22.9667,
    lon: -43.1950,
    label: 'Morro Dona Marta & Botafogo, Rio de Janeiro, Brazil',
    description: 'Extreme vertical hillside community built into sheer granite peaks above Rio.',
    testFocus: 'Stacked multi-story informal concrete structures clinging to 45° mountain slopes; stairs and ramps.',
    recommendedVehicleType: 0 // buggy
  },
  {
    id: 'montmartre_paris',
    name: 'Montmartre Butte, Paris, France',
    category: 'steep_slope',
    categoryLabel: '⛰️ Steep Slopes & Hills',
    lat: 48.8867,
    lon: 2.3431,
    label: 'Montmartre Butte & Sacré-Cœur, Paris, France',
    description: 'Prominent 130m hill rising over Paris with steep cobblestone alleys, funicular tracks, and terrace steps.',
    testFocus: 'Urban hill gradient with dense 6-story Haussmann buildings stepping up the incline.',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'valparaiso_hills_chile',
    name: 'Valparaíso Hills, Chile',
    category: 'steep_slope',
    categoryLabel: '⛰️ Steep Slopes & Hills',
    lat: -33.0458,
    lon: -71.6296,
    label: 'Cerro Alegre & Cerro Concepción, Valparaíso, Chile',
    description: 'Dramatic coastal amphitheatre of steep hills with colorful cliffside houses and zigzag ramps.',
    testFocus: 'Cliffs plunging to seaport level; sharp elevation changes on tight urban switchback corners.',
    recommendedVehicleType: 2 // pickup
  },

  // ---- 8. Shoreline & Waterfront Interfaces ----
  {
    id: 'sydney_opera_house',
    name: 'Sydney Opera House, Australia',
    category: 'coast_interface',
    categoryLabel: '🌊 Shoreline & Interfaces',
    lat: -33.8568,
    lon: 151.2153,
    label: 'Bennelong Point & Circular Quay, Sydney, Australia',
    description: 'Famous multi-venue performing arts centre with iconic sail roofs protruding into Sydney Harbour.',
    testFocus: 'Curved shell geometric colliders; harbor apron promenade meeting deep water; passenger ferry wharves.',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'the_bund_shanghai',
    name: 'The Bund & Huangpu River, China',
    category: 'coast_interface',
    categoryLabel: '🌊 Shoreline & Interfaces',
    lat: 31.2400,
    lon: 121.4900,
    label: 'Zhongshan East 1st Rd & The Bund Promenade, Shanghai, China',
    description: 'Historic waterfront boulevard with 1920s European colonial architecture facing the modern Pudong skyline across the river.',
    testFocus: 'Seawall embankment promenade driving; wide multi-lane boulevard running parallel to riverfront.',
    recommendedVehicleType: 1 // muscle
  },
  {
    id: 'copacabana_beach_rio',
    name: 'Copacabana Beach, Rio de Janeiro',
    category: 'coast_interface',
    categoryLabel: '🌊 Shoreline & Interfaces',
    lat: -22.9711,
    lon: -43.1822,
    label: 'Avenida Atlântica & Copacabana Crescent, Rio de Janeiro, Brazil',
    description: 'Famous 4km curved beach boulevard with iconic wave mosaics bordered by Atlantic surf and mountain monoliths.',
    testFocus: 'Wide coastal boulevard meeting ocean sand; sudden contrast from beachfront to sheer granite peaks.',
    recommendedVehicleType: 1 // muscle
  },
  {
    id: 'victoria_harbour_hong_kong',
    name: 'Victoria Harbour, Hong Kong',
    category: 'coast_interface',
    categoryLabel: '🌊 Shoreline & Interfaces',
    lat: 22.2936,
    lon: 114.1722,
    label: 'Tsim Sha Tsui Promenade & Victoria Harbour, Hong Kong',
    description: 'Bustling deep-water maritime harbour facing Hong Kong Island\'s dense skyline wall.',
    testFocus: 'Seawall promenade edge; water reflection rendering; dense skyscraper backdrop across the bay.',
    recommendedVehicleType: 4 // coupe
  },
  {
    id: 'alexandria_corniche',
    name: 'The Corniche, Alexandria, Egypt',
    category: 'coast_interface',
    categoryLabel: '🌊 Shoreline & Interfaces',
    lat: 31.2156,
    lon: 29.8856,
    label: 'The Corniche & Eastern Harbour, Alexandria, Egypt',
    description: 'Expansive 15km Mediterranean coastal waterfront highway curving past historic forts and harbors.',
    testFocus: 'High-speed seaside curve driving; waves crashing against stone seawall riprap.',
    recommendedVehicleType: 1 // muscle
  },
  {
    id: 'promenade_des_anglais_nice',
    name: 'Promenade des Anglais, Nice, France',
    category: 'coast_interface',
    categoryLabel: '🌊 Shoreline & Interfaces',
    lat: 43.6947,
    lon: 7.2625,
    label: 'Promenade des Anglais & Baie des Anges, Nice, France',
    description: 'Grand palm-lined French Riviera boulevard curving along the turquoise Bay of Angels.',
    testFocus: 'Curved coastal highway flanked by iconic Belle Époque hotels on one side and sea on the other.',
    recommendedVehicleType: 4 // coupe
  },

  // ---- 9. Open Ground & Rural Plains (Pure 2D Satellite) ----
  {
    id: 'salt_flats',
    name: 'Bonneville Salt Flats, UT',
    category: 'open_ground',
    categoryLabel: '🏜️ Open Ground Textures',
    lat: 40.7624,
    lon: -113.8963,
    label: 'Bonneville Salt Flats, Tooele County, UT',
    description: 'Vast, perfectly flat expanse of open salt crust with zero 3D photogrammetry tiles.',
    testFocus: 'Pure 2D satellite texture streaming (Zoom 18-20 patches); high-speed top-velocity driving; zero tiles.',
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
  {
    id: 'sahara_erg_chebbi',
    name: 'Sahara Erg Chebbi Dunes, Morocco',
    category: 'open_ground',
    categoryLabel: '🏜️ Open Ground Textures',
    lat: 31.1442,
    lon: -3.9726,
    label: 'Erg Chebbi Sand Dunes, Merzouga, Sahara, Morocco',
    description: 'Spectacular 150m high orange erg sand sea stretching into the Sahara horizon.',
    testFocus: 'High-relief smooth dune sand wave geometry; pure satellite color fidelity; off-road sand physics.',
    recommendedVehicleType: 5 // monster truck
  },
  {
    id: 'salar_de_uyuni_bolivia',
    name: 'Salar de Uyuni, Bolivia',
    category: 'open_ground',
    categoryLabel: '🏜️ Open Ground Textures',
    lat: -20.1338,
    lon: -67.4891,
    label: 'Salar de Uyuni Salt Flat, Potosí, Bolivia',
    description: 'The world\'s largest salt flat at 3,656m elevation, forming a giant natural mirror expanse.',
    testFocus: 'Ultra-flat high altitude plateau; boundless horizons; white reflective ground terrain.',
    recommendedVehicleType: 1 // muscle
  },
  {
    id: 'australian_outback_uluru',
    name: 'Uluru & Red Desert, Australia',
    category: 'open_ground',
    categoryLabel: '🏜️ Open Ground Textures',
    lat: -25.3444,
    lon: 131.0369,
    label: 'Uluru-Kata Tjuta National Park, Red Centre, Australia',
    description: 'Ancient red desert sand plains surrounding the sacred sandstone monolith of Uluru.',
    testFocus: 'Deep red ochre satellite terrain textures; isolated inselberg rock elevation interpolation.',
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
