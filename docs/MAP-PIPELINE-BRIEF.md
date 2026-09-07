# Map pipeline: how it works, what's broken, what we've ruled out

A self-contained brief. It assumes no knowledge of this repo. Written so it can be
handed to another engineer or AI to attack independently.

## 1. The game

A browser arcade driving game (TypeScript + three.js, no engine). You pick a real
place on Earth, and the game builds a drivable 5.6 km² map of it. Cars have simple
sphere-based physics, drive on a heightfield, and collide with buildings.

## 2. Where the map comes from

**Google Photorealistic 3D Tiles.** Streamed GLB meshes covering most of the world.
The critical property: **a tile is one merged photogrammetry mesh with no semantics.**
Ground, buildings, trees, parked cars, bridges and street furniture are all baked
into a single triangle soup. Nothing is tagged. There is no "building" object to ask
about. Everything downstream is an attempt to recover meaning from raw geometry.

Photogrammetry is also noisy: parked cars appear as melted lumps fused to the road,
kerbs are jagged, thin structures are non-manifold.

Relevant files:
- `src/services/tiles/Tileset.ts` — tree traversal, LOD, streaming (~730 lines)
- `src/services/tiles/tileColliders.ts` — all the classification (~1200 lines)
- `src/core/heightfield.ts` — the surface cars drive on
- `src/core/world/NavGrid.ts` — bot pathfinding grid
- `src/render/TileClutterFilter.ts` — visual-only clutter filtering

## 3. How physics is currently extracted

1. **Rasterize.** Every tile mesh is stamped into a **10 m cell grid**. Per cell:
   `top` (highest surface), `low` (lowest), and a 32-bit vertical occupancy `mask`.
   This is a DSM (surface model, includes buildings).

2. **Estimate ground.** A DTM is derived from the DSM alone by **morphological
   opening**: a min filter followed by a max filter, radius 6 cells (a 120 m window).
   The rationale is that opening is mathematically exact on a constant slope, so
   hills survive while anything narrower than the window is erased.

3. **Classify.** A cell is a building when the surface stands `buildingRiseM` = **3.5 m**
   above that estimate, and also 3.5 m above an independent coarse elevation model
   (Google Elevation API, 87 m samples, bicubic smoothed). Cells that look like
   bridge decks, ramps, or gradual drivable terrain are exempted.

4. **Merge.** Building cells merge into axis-aligned boxes: runs along X, then
   identical runs stacked across rows. These boxes are the physics colliders.

5. **Ground surface.** A separate pass produces the heightfield cars drive on.

Roughly **30 hand-tuned constants** live in `DEFAULT_COLLIDER_THRESHOLDS`.

There is also a **2.5D `deckGrid`** that separately detects bridge decks, overpasses
and ramps so cars can drive over and under them, using the vertical occupancy mask
for clearance. This exists because the representation is 2.5D and cannot natively
express two drivable surfaces stacked vertically.

## 4. The symptom

In hilly cities the player hits invisible walls and cannot drive anywhere. Reported
at San Francisco Russian Hill (37.79344, -122.42127). The game has a "Game 3D" view
mode that renders the actual collider boxes; there the street ahead is a solid mass.

## 5. What we measured

Real tile rasters were captured from two live sessions and analysed offline against
the real pipeline code. **Reachability, not wall count, is the metric that matters**:
the open cells form a graph, and what the player experiences is whether that graph is
connected.

| | San Francisco (hilly) | New Orleans (flat) |
|---|---|---|
| tile-covered 10 m cells | 44,790 | 77,390 |
| classified building | 73.0% | 46.2% |
| open (drivable) | 27.0% | 53.8% |
| **disconnected open regions** | **1,003** | 1,272 |
| **largest region, % of covered** | **5.9%** | 38.0% |
| corridor width, 10th pct | 10 m (one cell) | 20 m |

San Francisco's open space is roughly the true street fraction of a dense city. The
open area is not missing. **It is shattered into a thousand pockets.**

### Proven sub-mechanism: opening error scales with curvature, not slope

The same morphological opening was run on the **bare-earth elevation model alone**,
which contains no buildings by construction. On **5.3% of SF cells the terrain by
itself produces a residual at or above the 3.5 m building threshold**, peaking at
17.5 m. Bare hillside is classified as a building.

Which variable predicts that residual matters, because the project roadmap plans a
"slope-adaptive" fix:

| mean residual | across slope 0 → 50% | across curvature bins |
|---|---|---|
| | 0.32 m → 1.67 m | 0.17 m → 4.87 m |

Slope barely moves it and never reaches the threshold. **Curvature drives it.**
Opening is exact on a constant grade, so a uniformly steep street has near-zero
error; the error appears at crests and grade changes. Measured residual is about
0.35 × the geometric sagitta over the structuring element.

Note: `slopeAdaptiveRiseCoeff: 12.0` is declared in the thresholds and **never read
anywhere in the codebase**. The planned fix was never implemented, and as specified
it keys on the wrong variable.

## 6. What we tried, and the results

All measured offline against both cities. The column that matters is the largest
connected region as a percentage of covered area; the baseline is 5.9% for SF.

| variant | SF largest region | missed real buildings |
|---|---|---|
| baseline | 5.9% | 8.9% |
| relax drivable flood-fill caps (grade 28% → 40%) | 5.9% | 8.9% |
| curvature-corrected ground estimate | 6.0% | 10.3% |
| both, plus height-banded box merging | 6.0% | 10.3% |
| raise building threshold 3.5 m → 6.0 m | 9.8% | 17.6% |
| despeckle the building mask | 6.5% | 10.4% |
| morphological opening of the building mask | 9.5% | 15.6% |
| mask opening + curvature correction | 9.9% | 17.5% |

**Conclusion: no threshold or mask change fixes this.** Everything that improves
connectivity pays for it by deleting real buildings at roughly a one-to-one rate.
The classifier is not the lever.

The working theory for why: at 10 m resolution, a street between buildings on a grade
is one or two cells wide. Any single occupied cell severs it. The corridors were
never represented robustly enough for a classifier to recover.

## 7. What is being tried now

**Recast Navigation** (`recast-navigation-js`, MIT, WASM, ~331 KB wasm + 546 KB JS
loader). It voxelizes arbitrary triangle soup and extracts traversable surface, and
its documentation explicitly claims robustness to "overlapping geometry, small
triangles, and imperfect geometry" — a description of photogrammetry.

The appeal is that it is *smaller*, not just better. Its handful of physically
meaningful parameters replace clusters of our constants:

| Recast parameter | replaces |
|---|---|
| walkable slope angle | the 28% grade cap that fails in SF |
| step height | kerb handling |
| agent height clearance | the entire underpass occupancy-mask subsystem |
| agent radius | two separate inset constants |
| cell size | the 10 m quantisation, which is the suspected root cause |

It is also natively multi-level, so the whole `deckGrid` bridge apparatus becomes
unnecessary. Detour (same library) could replace `NavGrid` for bot routing.

### Spike status: inconclusive so far

Runs on live streamed tiles in-browser. For an 800 m box around the player in SF
(184 meshes, 132k triangles):

| cell size | navmesh build time |
|---|---|
| 1.0 m | 867 ms |
| 2.0 m | 426 ms |

Build performance looks acceptable, especially since it can run in a Web Worker (the
project already runs collider rebuilds in one).

**The measurement is not yet trustworthy and the result should not be believed yet.**
Two known problems:
1. With a wide vertical search, sample points snap onto **rooftops**, which Recast
   correctly considers flat and walkable but which no car can reach. This deflates
   reachability.
2. After anchoring sampling to ground level with a 4 m vertical window, the spawn
   point itself no longer finds navmesh within that window, so the run aborts. Either
   the navmesh genuinely has no street-level surface at the spawn, or the sampling
   window is wrong. Unresolved.

An honest concern not yet tested: Recast will treat melted parked cars and street
furniture as obstacles and erode the drivable corridor, exactly as the raster
pipeline did. Finer cells should help a lot, but the clutter is still in the input
geometry. It may be necessary to filter clutter out of the navmesh input.

## 8. Constraints any solution must respect

- **Performance.** Browser game targeting 60 fps on modest hardware. Frame budget is
  the hard limit; main-thread stalls are the failure mode we care about, not average
  framerate. Heavy work belongs in a Web Worker.
- **Bandwidth.** Tiles already stream hundreds of MB. Added library weight should be
  justified, and ideally loaded in a worker off the critical path.
- **Complexity.** The current 1,200-line heuristic file is itself a problem. A
  solution that adds another layer of heuristics on top is worse than the disease.
- **Generality.** Must work across many cities without per-location tuning. The
  existing approach failed precisely because it became city-by-city threshold
  guessing. Test locations should span flat grid cities, steep hills, dense
  high-rise, bridges, and open desert.

## 9. Interventions and Current State

### A. OpenStreetMap Road Centrelines (Implemented & Merged on `main`)
Implemented in `services/osm/roads.ts` and integrated with `tileColliders.ts` and `Tileset.ts`:
- **Concept:** Query Overpass for drivable `highway` ways, rasterized into a 10 m grid mask to exempt street corridors from building classification.
- **Measured Results:**
  - **SF Russian Hill:** Largest connected region jumped from **4.4% to 45.5%** of covered area; disconnected regions collapsed from 1,229 to 380.
  - **New Orleans:** Largest region increased from **39.6% to 65.1%**.
  - **Live Drive:** Continuous 3,035 m full-speed driving across Russian Hill where the baseline halted cars in under one block.
- **Critical Ground Heightfield Fix:**
  Initial implementation exempted road cells from building boxes but left `AmortizedGroundBuilder` sagging by up to 17 m at hill crests, dropping the vehicle heightfield underground. Fixed by pinning road-cell ground directly to `Math.min(top, low)`.
- **Highway Sanitization:** Non-drivable footpaths, steps, and pedestrian ways are filtered out to prevent walkways from coring out building lobbies.
- **Known Limitations:** Network latency (mitigated by a 1.5 s startup timeout with async background rebuild) and public Overpass rate-limit constraints.

### B. Recast Navigation Spike (`spike/recast-navmesh`)
- **Status:** Spike evaluated, findings documented, and branch preserved.
  - **Transform & Snapping:** World coordinate matrices refreshed before vertex extraction; spawn point reliably snapped to pavement across steep grades and datum shifts.
  - **Rooftop Pruning vs Street Preservation:** Multi-island elevation filtering prunes elevated rooftops while preserving ground-level street ribbons (11k+ polygons across 1.3 km).
  - **Verdict & Production Decision:** Raw photogrammetry triangle soup inherently contains gaps caused by tree canopies, shadows, power lines, and steep curbs, while driveways and plazas can get falsely marked drivable. The vector road corridor hybrid (OSM) on `main` remains substantially more reliable for gameplay navigation because it provides human-curated road topology. Recast work is safely preserved on `spike/recast-navmesh` for future reference (e.g. multi-deck bot pathfinding).

### C. Other Options
- **GPU rasterization of the surface model:** Rendering tiles top-down orthographic into a depth texture for 1 m surface data.
- **Cloth Simulation Filter (CSF):** Standard point-cloud ground filter, though prone to loss of ground adhesion on rising terrain.

## 10. Verification Coordinates

- **Russian Hill (SF):** `?lat=37.79344&lon=-122.42127&debug` (Press `V` for Game 3D collider view).
- **Lombard Street (SF):** `?scenario=lombard_street_sf&debug` (Steep 27% hairpin switchbacks).
- **French Quarter (NOLA):** `?scenario=french_quarter_nola&debug` (Sea-level dense low-rise grid).
