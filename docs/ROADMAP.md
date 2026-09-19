# Roadmap

What would bring this closer to Smugglers Run, ordered by payoff against
risk. Items marked **(play-test)** change how the game feels and should be
tuned with a controller in hand, not shipped blind.

## 1. World scale 1:1 — Done

Migrated in `feat/scale-1-1`:
- Standardized world scale: 1 real meter = 1.0 world units (`WORLD_M_PER_M = 1`).
- Field half-size scaled to 2800 m (`config.world.mapHalf = 2800`), matching true 5.5 km real-world terrain grids.
- Vehicle dimensions (4m length), terminal speed (78 m/s = 280 km/h), gravity (22 m/s²), and physics stats operate in physical SI units.
- Camera frustum, fog distances, and test heightfields updated to meter scale. Downtowns now read at true life size from the driver's perspective.

## 1b. Menus

The garage (vehicle pick) exists, and the online lobby now sets the location
(desert or any place on Earth, with presets and a cheap check). A rebind
screen (`SettingsScreen`, opened from the garage's CONTROLS button) covers
keyboard and gamepad, with press-to-bind capture and reset-to-defaults. Left:
the rest of game setup (round length, team size, bot difficulty) including for
single player, a pause menu, and audio options. Mid-match `1`–`5` vehicle
switching should go once setup exists; it is a debug leftover.

## 2. Round structure — mostly done

Done: 5-minute clock, 3-2-1 countdown, final-minute warning, sudden death on
a tie. Left:

- Match summary on the end screen: deliveries and steals per driver.

## 3. Bots — pathing done

Done: BFS flow fields over a 6 m occupancy grid built from the colliders;
bots follow waypoints around buildings and props. The fields expand lazily,
only as far as the bot asking, because a full sweep of the ~870k-cell grid
measured 25-60 ms. Left:

- Roles: when an ally carries, escorts should body-block chasers rather than
  drive to the base and wait.
- Difficulty setting: reaction time (`reevaluateS`), top-speed cap, steal
  aggression.
- Field quality: a cell is blocked when its centre is within a car half-width
  of any collider. Where streets close, the cause is upstream in collider
  classification rather than in this grid — see section 10.

## 4. Graphics

- Real shadows: a directional shadow map on a ~200-unit frustum that follows
  the player; vehicles cast, terrain and tiles receive. Biggest single visual
  upgrade for grounding the cars.
- Satellite drape **(Done, better than planned)**: `GroundStreamer` streams
  zoom-18 patches (~0.25 m/px) around the player rather than a fixed grid, and
  skips ground already covered by 3D tiles. The clutter filter's hidden mode
  streams under tiles too, since it reveals the ground beneath them.
- Streaming: evict the farthest tiles when over `MAX_TILES` so long sessions
  keep refining; coarsen behind the player.
- Impact feedback: camera shake on rams and landings, sparks/smoke as
  integrity drops, skid marks.
- Time of day: the painted sky (`skyTexture.ts`) takes a sun direction, so
  a dusk/night palette and a moving sun are a repaint plus light tweaks.
- Performance headroom: collider rebuilds now run in a Web Worker, and the
  streaming hitches that made the game feel choppy are gone (a 30 s drive
  through Manhattan holds p99 10.4 ms with zero long tasks). Tile
  rasterization is still on the main thread at ~48 ms per streaming burst and
  is the next candidate. A quality preset (tile caps, streaming LOD, MSAA off)
  on top of the adaptive resolution would help very weak GPUs.
- Street clutter filter **(Done)**: `TileClutterFilter` patches every tile
  material so street-level photogrammetry noise is flattened onto the ground
  or discarded entirely, leaving buildings over streamed satellite ground.
  Swept is the default; it keeps kerbside facades (and street trees) over
  streamed satellite ground, while Hidden discards non-building geometry completely.
  Note this is **render-side only** — the colliders still contain the clutter it hides.
- Cinematic camera sweep **(Done)**: A 6-second dynamic establishing shot swoops across
  the landscape with terrain and building obstacle avoidance, staged banners (`LOCATION`,
  `GET READY`, countdown 3-2-1, `GO!`), and instant skip via `Space`, `Enter`, click, or gamepad.
- Stretched fill in Best 3D **(salvage, branch kept)**: PR #34 added a `best-3d-stretched`
  style that dilates authentic tile colours outward along 8 rays (up to ~130 px) to fill the
  transparency in irregular silhouettes. It was built as a screen-space branch inside the
  old `BuildingMeshView` projection shader, which the city-modes merge removed, so all
  seven APIs it patched (`uTilesMap`, `screenUV`, `uTextureStyle`, `uResolution`,
  `setProjecting3dTiles`, `getTilesTexture`, `setTilesTexture`) now have zero references.
  Best 3D is vertex-snapping (`clutterFilter.snap`) and has no alpha holes to fill, so the
  loop wants porting as a texture style on the snap pipeline, not rebasing. Branch
  `feat/best-3d-expand` holds it; its own test sets `visible = false` then asserts false,
  and its ray loop cannot find a pixel whose alpha sits between the 0.04 outer gate and the
  0.05 ray threshold.

## 5. Input and platforms

Done:
- Gamepad is a first-class `InputSource` (analog steer/throttle/triggers)
  alongside the keyboard, merged through one `InputManager`; both work through
  the menus and the match, and every binding is rebindable from the Controls
  screen. Defaults are mapped from the original PS2 layout onto a Stadia pad.
- Windows, cross-browser, and Bluetooth Stadia controller normalization:
  handles raw DirectInput HID drivers in Firefox where buttons and triggers
  sit on axes 4/5, D-pad on hat switches, and buttons are permuted.
- Multi-gamepad resolution: bypasses idle virtual joystick drivers (vJoy,
  Steam Input) sitting at index 0 and automatically locks onto whichever
  controller has active player input without stick-drift lockouts.
- Gamepad audio auto-unlock on first interaction, and friendly button labels
  (`A`, `B`, `LT`, `RT`, `D-Pad`, etc.) across Settings and the garage footer.
- Canvas `webglcontextlost` and `webglcontextrestored` recovery, and `touch-action: none`
  preventing touchscreen pinch-zoom.

Left:

- Touch controls. The HUD is responsive already — safe-area insets, a radar
  and corners that scale, no overflow down to 390 px — but there is no way to
  steer without a keyboard or gamepad, so a phone can watch and not play.
  The `InputSource` seam is there for a `TouchSource` to plug into.

## 6. Audio

Engine pitch from speed, ram and landing impacts, pickup/steal/deliver
stingers, a proximity cue near your base. Web Audio with procedural sounds
first, no assets needed.

## 7. Multiplayer — version 1 live

Version 1 is live: host-authoritative over WebRTC (Trystero), Firebase for
lobby, signalling and anonymous auth, bots in empty seats, and rooms that play
anywhere on Earth. Left: client prediction, host migration, quick-match, and a
decision on TURN. The remaining internal prerequisites (a `Simulation` split
out of `Game`, body snapshots) are listed in `docs/MULTIPLAYER.md` with the
phase plan. The per-driver input-source interface now exists
(`InputSource` in `src/input/types.ts`).

## 8. Tooling and code quality

- ESLint with typescript-eslint; `npm run lint`.
- CI. The checks themselves exist — `npm run typecheck`, `npm test`,
  `npm run build`, `npm run smoke` (no key needed) and `npm run e2e:online` —
  but nothing runs them on a push.
- A per-frame HUD channel like the direction arrow's for speed and integrity,
  so they don't tick at 10 Hz.

## 9. Relocation polish

- **Bridge decks and overpasses (Done v1)**: Implemented 2.5D `deckGrid` with $O(1)$
  bilinear lookup (`Tileset.surfaceElevation`) and vertical underpass clearance
  detection. Vehicle drives on bridge decks while open street underpasses remain clear.
- **Ground refresh hitching (Done v1)**: Solved via `AmortizedGroundBuilder`,
  amortizing the morphological opening filter across frames within a 1.5 ms budget.
- Bicubic sampling for the 10 m tile ground if it feels like gravel at
  speed; the four-wheel mean and suspension hide most of it.
- Remember the last place and offer a few presets (Portland, SF, Tokyo) — presets done in scenario catalog (`testScenarios.ts`).
- Progress with tile counts and byte totals; a clear message when the key is
  missing one of the four APIs.
- If a place has too little tile data near the center for the measured datum
  shift, fall back to an EGM96 geoid lookup.

## 10. 3D Tiles, Collision & Physics Architecture

Measured findings and dead ends are written up in
[`MAP-PIPELINE-BRIEF.md`](MAP-PIPELINE-BRIEF.md), which is self-contained and
can be handed to someone with no context on this repo. Summary of what changed
here: **the classifier is not the lever, and the metric we were optimising was
the wrong one.**

- **Optimise reachability, not wall count.** Counting false walls says San
  Francisco has too many. Counting connectivity says its open space is roughly
  the correct street fraction of a dense city but is shattered into 1,003
  disconnected pockets, the largest covering 5.9% of the area. Flat New Orleans
  has one network covering 38%. Any future attempt should be measured on
  whether the street graph comes out connected; wall counts move without the
  game getting better.

- **Slope-Adaptive Morphological Thresholding — disproven as specified.**
  The plan was `rise = base + s·tan(θ)`. Morphological opening is exact on a
  constant grade, so slope is the wrong corrective variable: measured on real
  bare-earth terrain, mean residual moves only 0.32 m → 1.67 m across the full
  0-50% slope range, but 0.17 m → 4.87 m across curvature. The error appears at
  crests and grade changes, and is about 0.35× the geometric sagitta over the
  structuring element. On 5.3% of SF cells, bare terrain with no buildings in
  the signal already produces a residual above the 3.5 m building threshold,
  peaking at 17.5 m. `slopeAdaptiveRiseCoeff: 12.0` is currently declared in
  the thresholds and **never read anywhere**; it should be deleted or replaced
  with a curvature term. Either way it is not worth doing on its own: a
  curvature-corrected ground estimate moved connectivity 5.9% → 6.0%.

- **Threshold and mask tuning is a dead end.** Relaxed drivable caps,
  curvature correction, height-banded box merging, mask despeckling and
  morphological mask opening were all measured against both cities. Everything
  that improves connectivity pays for it by deleting real buildings at roughly
  one-to-one. The best variant reached 9.9% while nearly doubling missed
  buildings. Do not spend more here without a new idea.

- **Navmesh extraction (Recast) — Spike Evaluated & Branch Preserved.**
  `recast-navigation-js` (MIT, WASM) voxelizes 3D tile triangle soup and extracts
  a traversable surface directly. Validated on `spike/recast-navmesh`:
  - **Transform & Snapping Fixed:** Evaluates Three.js world matrices before vertex harvesting; snaps spawn cleanly to pavement.
  - **Street Preservation vs Rooftops:** Ground-elevation filtering prunes elevated rooftops while preserving ground-level road ribbons (11k+ polygons across 1.3 km).
  - **Production Conclusion:** Raw photogrammetry triangle soup inherently contains gaps caused by tree canopies, shadows, power lines, and steep curbs, while driveways and plazas can get falsely marked drivable. The vector road corridor hybrid (OSM) on `main` remains substantially more reliable for gameplay navigation because it provides human-curated road topology. Recast work is safely preserved on `spike/recast-navmesh` for future reference.

- **Vector Road Hybrid (OSM / Overpass API) — Done & Hardened.**
  Merged on `main` in `services/osm/roads.ts`. Queries OpenStreetMap for drivable
  `highway` centrelines, rasterized onto the grid to exempt streets from false
  building classification on hill crests, with ground heightfield pinned to the
  road surface. SF Russian Hill largest connected open region jumped from 4.4% to
  45.5% (disconnected pockets reduced from 1,229 to 380). Bounded to 1.5 s startup
  with async worker rebuilds.
  - **Browser W3C Header Fix:** Removed forbidden `'User-Agent'` header that caused
    silent Overpass fetch aborts in Chrome/Brave.
  - **Bounding Box Fix:** Expanded raster cell search box from `halfWidth` to total
    `reach` (`halfWidth + cellSize * 0.85`), preventing diagonal/curved road segments
    from dropping curbside cells.
  - **Reactive Background Rebuild (`onRoadsLoaded`):** Rebuilds colliders dynamically
    as soon as Overpass returns, preventing initial match colliders from blocking
    streets during network latency.

- **Empirical Road Corridor Experiments & Sub-Lane Resolution (2026-09):**
  Investigated false building colliders ("black objects") blocking drivable streets
  in Game 3D. Diagnosed two primary root causes:
  1. *10 m Quantization Bleed*: 10 m cells are wider than residential road lanes
     (6–8 m), causing roadside facades and fences to mark the entire lane as a building.
  2. *2.5D Elevation Extrusion*: Street trees and overhanging eaves get extruded
     downward into solid black columns in the street.
  Four in-engine experiment modes were implemented and validated through live test drives:
  - **Mode 0 (Baseline 10m)**: Recreated the bug; vehicle crashes directly into the black box.
  - **Mode 1 (Road-Carve OSM)**: Completely clears the roadway corridor; best gameplay solution with semantic ground truth.
  - **Mode 2 (Curbside-Inset 2.4m)**: Insetting shrinks obstacle boxes by ~2.8m, but an isolated pillar remains standing in the street. Proves geometric insetting alone cannot distinguish an isolated tree canopy from a building corner.
  - **Mode 3 (High-Res 5m Grid)**: 5m sub-lane grid resolution prevents canopy bleed into the lane and completely opens the street 100% offline without external network queries.
  *Diagnostic Harness*: `F9` / `E` cycles experiment modes live in the HUD; `T` teleports directly to the benchmark obstacle test site (`X:290, Z:12`).

- **Automated Scenario Regression Harness — done, but synthetic.**
  `tests/scenarios.harness.test.ts` runs all 17 curated scenarios in under
  500 ms. Its fixtures are hand-built topographies, and its steep-slope cases
  are constant-grade ramps, which morphological opening handles exactly. That
  is precisely why it never caught the hill failure. It needs **real captured
  tile rasters** as fixtures to be a meaningful regression net; the capture
  path exists and two cities are already captured.

- **Workerized Collider Rebuild — Done.**
  `collidersFromRasters` runs in `services/tiles/colliderWorker.ts`; the frame
  pays a structured clone instead of the pass. The raster clearance scan was
  also indexed per cell rather than scanning every raster, taking it from
  45 ms to 1 ms. Match start still uses the synchronous path so spawns are
  clear of colliders before the first frame.

- **Game 3D Procedural Aesthetic Upgrades**:
  Enhance the stylized "Game 3D" visual mode (`BuildingMeshView.ts`) with
  architectural window textures, asphalt road ribbons, and edge bevels to serve
  as a premium arcade visual alternative with 100% collision parity. It is also
  the QA view that exposed this whole class of bug, so keeping it honest
  matters beyond aesthetics.
