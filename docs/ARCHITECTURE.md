# Architecture

## Layers

```
┌─────────────────────────────────────────────────┐
│ ui/          Lit components for HUD and screens  │  DOM
├─────────────────────────────────────────────────┤
│ input/       keyboard + gamepad sources,         │  devices
│              rebindable bindings, InputManager   │
├─────────────────────────────────────────────────┤
│ app/         Game loop, store, events, config    │  orchestration
├──────────────────────┬──────────────────────────┤
│ core/                │ render/                   │
│ simulation           │ three.js presentation     │
│ (pure, DOM-free)     │ (reads sim state)         │
├──────────────────────┴──────────────────────────┤
│ net/         lobby, transport, host/client       │  multiplayer
├─────────────────────────────────────────────────┤
│ services/    Google Maps, 3D Tiles, Firebase     │
└─────────────────────────────────────────────────┘
```

Dependency rules (enforced by review, not tooling):

- `core/` imports nothing from `app/`, `render/`, `ui/`, or `services/`.
  Its only dependency is three's math types (`Vector3`, `Quaternion`,
  `Matrix4`). This is what makes the whole simulation testable in node.
- `render/` reads core types; never mutates simulation state. Views bind to
  bodies (`VehicleView.sync()`), not the reverse.
- `services/` talks to the network and produces `TerrainProvider`s and
  colliders; it is behind plain interfaces so the game runs without it.
- `app/` composes core + is composed by `main.ts`. `ui/` is driven by the
  store and dispatches through callbacks wired in `main.ts`.
- `net/` sits beside `app/`: it drives a `Game` on the host and presents a
  `WorldView` on a client. `core/` never learns what a peer is, and the
  whole directory loads on first use (dynamic import), so single player
  never pays for Firebase.

## Frame data flow

```
InputManager ─► Game.update(dt) ─► VehicleBody.step ×8 ─► resolveVehicleCollisions
   (poll() every frame;                 │                        │
    vehicleInput() only                  │                        ▼
    while playing)                       │                  MatchRules (pickup/steal/deliver)
                                        ▼                        │
                                  MatchEvents ──► EventBus ──► Banner / EndScreen
                                        │
                                        ▼
                       store.set(snapshot) ─► Lit HUD re-render
                                        │
VehicleView.sync() ◄────────────────────┤
Pickups.sync()     ◄────────────────────┤
CameraRig.update() ◄───────────────────┤
Minimap.draw()     ◄────────────────────┴─► GameRenderer.render()
```

The simulation steps at a fixed 60 Hz inside an accumulator
(`config.loop.step`), so physics is deterministic across refresh rates. Views
sync once per animation frame and interpolate each body between its previous
and current pose by `Game.alpha` (the fraction of a step left in the
accumulator); the camera and the carried crate follow those rendered poses.
Without that, a 120 Hz display shows the sim advancing every other frame,
which reads as the car stuttering against a smoothly gliding camera. The HUD
snapshot is pushed at 10 Hz — high-frequency values (speed) interpolate
visually, no one misses them.

## Input (`input/`)

Keyboard and gamepad are peers behind one `InputManager`, each implementing
the `InputSource` interface. A mouse or touch source can plug in later without
the sim or screens changing — they never branch on which device is active.

`InputSource` splits its output into three kinds, deliberately separated so a
menu and the sim read from different taps:

- `poll()` runs every frame, menus or gameplay. The gamepad has no keydown
  event, so its down-edges (UI nav, hotkeys) are detected here, not in
  `vehicleInput`. This is load-bearing: `main.ts` only calls `vehicleInput()`
  while a match is running, so an edge scan that lived there would never run
  while a menu is open and the gamepad would be dead in menus. The keyboard's
  `poll()` is a no-op — its edges fire from a `keydown` listener.
- `vehicleInput()` returns the continuous analog driving state (throttle,
  steer, pitch, jump), polled each frame while a match runs. Per-channel
  max-magnitude merge: whichever source is pushing a channel wins, a resting
  gamepad never steals the keyboard.
- `drainUiActions()` / `drainHotkeys()` drain the edge buffers accumulated by
  `poll()`. UI actions route to the active screen's handler; hotkeys (camera,
  reset) route to the sim.

Bindings are data, not code: a table maps a `LogicalAction` (accelerate,
uiConfirm, …) to one or more physical controls per device. Defaults are
Stadia-friendly, mapped from the original PS2 game's face-button layout onto
the same physical positions (A=accelerate, X=brake, B=reverse, Y+RT=jump,
Select=camera). The table persists to `localStorage` under `stt.bindings` with
a `SCHEMA_VERSION` stamp; a save whose version doesn't match is rejected and
defaults load, so a stale layout from an older default can't override a
correction. `InputManager.captureNext()` is the one-shot listener the rebind
screen (`ui/screens/SettingsScreen.ts`, opened from the garage's CONTROLS
button) uses to grab the next key or button a player presses.

## Core modules

### `core/heightfield.ts`
Square height grid, bilinear `sample(x, z)`. World `[-size/2, size/2]` maps to
normalized `[0, 1]` across the grid — the same mapping as `PlaneGeometry`
UVs, which is what keeps satellite imagery registered against the elevation
data.

### `core/terrain/`
`TerrainProvider` is the interface: `ProceduralTerrain` (value-noise desert,
instant) and `RealTerrain` (Google Elevation grid + satellite canvas) both
produce one. Real terrain applies an adaptive relief boost
(`reliefBoostFor`) so flat cities still get playable jumps while mountains
stay near true scale.

### `core/physics/VehicleBody.ts`
Arcade physics: floaty gravity, ground drive with lateral grip, damped air
control, auto-righting, hard-landing tumbles, world bounds, and contact with
the world's box colliders through the vehicle's own collision shape (see
`core/physics/collision.ts`). A fresh spawn has two seconds of grace in which
a landing costs no integrity and never tumbles, because cars drop in from
above. The two quaternion gotchas preserved from the prototype (each is
unit-tested):

- Auto-righting axis is `upW × worldUp` — the opposite order amplifies tilt
  toward a flip and degenerates to zero length when inverted.
- Air-control angular velocity is damped and capped (3.2 rad/s); without the
  cap, held steer mid-jump accumulates roll that nothing bleeds off.
- Air yaw has the same sign as ground steering. The ground check flickers
  over bumps at speed, so an opposite-signed air yaw read as the car jerking
  the wrong way mid-turn.

Ride height is suspension-like: the ground under the car is the mean of the
four wheel contact points, and the body eases toward it (`RIDE_RATE`) within
±`RIDE_TRAVEL`, so bumps shorter than the wheelbase and terrain-grid kinks
don't jolt it. Anything inside that band that isn't launching or falling hard
counts as grounded, which is what keeps steering alive over bumps and down
hills; ground steering also persists 0.2 s after lift-off. Real terrain is
upsampled from the 87 m elevation grid with Catmull-Rom (bicubic) rather than
bilinear interpolation, because bilinear's slope kinks at every grid edge hit
the car as a jolt several times a second at speed.

Brake past a stop becomes reverse (35 % of top speed) with the steering
flipped so the rear swings the way you steer. Every roster stat does
something: `accel` scales drive force, `maxSpeed` is the terminal velocity
(rolling drag is derived from drive force ÷ top speed, so the stat is the
real ceiling), `steer` scales turn rate, `grip` sets how much lateral
velocity survives each second (19 % at 0.7, 0.1 % at 1.0), `durability`
divides damage, and `mass` decides rams. Damage from landings, walls
and rams is divided by the vehicle's `durability`; at integrity 0 the body
stays wrecked until `Game.wreck` drops its crate and respawns it. Physics
tuning enters through `app/config.physics` (plus the field size); the
`DEFAULT_PHYSICS` in the module exists for tests.

### Getting air

A car that follows the ground has the ground's vertical speed, so the ride
height is not simply pinned: `VehicleBody` tracks the rate the terrain under it
is rising and gives the car that as its vertical velocity. Zeroing it — which
is what the code used to do — threw the climb away every frame, so cresting a
hill had nothing to launch with and the suspension spring dragged the car down
the far side.

A crest is then just the car outrunning the ground: it was climbing, the slope
levels off, and its momentum carries on upward. That launches it, keeping the
climb it had at the lip, with the suspension held off briefly so the same
crest cannot immediately re-glue it. "Falling hard" is likewise measured
against the ground's own motion — descending a slope at 20 units/s is keeping
up with a hill, not falling.

Measured on the procedural desert, the fix turned ~670 meaningless
ground/air flickers per run into ~25 real launches with several times the
height. Landing damage was rebalanced to match, since jumps that reliably wreck
you are jumps nobody takes.

### `core/physics/collision.ts`
Collision shapes, kept separate from render meshes and deliberately simple.
A vehicle's collider is a compound of spheres in body space: `sphereCollider`
for one at the origin, `capsuleCollider` for two along the length, which
gives a car a nose and a tail without oriented-box math. Each roster entry
carries its own, so a Monster Truck is physically bigger than a Buggy and
touches sooner. `sphereVsAabb` is the one primitive against world boxes (the
inside case exits by the nearest face; the deepest face drives a car
through a building), `compoundVsCompound` the one between vehicles. World
boxes carry a `kind` (`building` | `prop`) so the resolver can treat layers
differently later without touching the shapes.

### `core/spawn/SpawnPlanner.ts` and `core/world/OpenSpace.ts`
Every placement — match spawns, respawns, both bases, the contraband — goes
through one component, and it handles human and bot drivers identically.
It never places anything by probing a few candidate points: it asks an
`OpenSpace` for real clearance. `NavGrid` implements `OpenSpace` with a
multi-source BFS distance-to-wall map (`clearanceAt`, `findOpen` spirals out
to the nearest point with enough room, `mostOpen` finds the roomiest place
near an ask). The starting grid is a ring on the most open ground near the
field centre, teams on opposite arcs, every slot nudged to open ground; that
is what a downtown like San Francisco needs, where there is no clearing at
the centre and a probe-based planner fell through to a point inside a block.
Cars are released `dropHeight` above the ground. All choices come from an
injected `Rng` (`core/rng.ts`, mulberry32), so a seed reproduces a layout on
any machine — the first prerequisite in `docs/MULTIPLAYER.md`.

### `core/ai/DriverBrain.ts` and `core/world/NavGrid.ts`
Bots steer toward a waypoint supplied by a `RouteFn` when the game has one,
else straight at the target. `NavGrid` is a 20 m occupancy grid rebuilt from
the same colliders physics uses (cell centers within a car's half-width of a
collider are blocked); a `FlowField` is a BFS distance map from a target
over that grid, and the waypoint is the cell three steps down it. `Game`
caches one field per target kind — bases never move, the contraband rarely,
the carrier's refreshes when it moves more than four cells or every 0.5 s.
A stuck detector (full throttle but crawling for 0.8 s while grounded) still
triggers a 0.9 s reverse with a random steer as the fallback.

### Round structure (`app/Game.ts`)
A match runs countdown → playing → (suddenDeath) → gameover. During the
countdown cars settle but nobody drives and the banner counts 3-2-1-go. The
clock (`config.match.roundS`) only runs while playing; at zero the leader
wins, a tie goes to sudden death where the next delivery wins. Win-at-five
applies throughout. `GameDeps.round` overrides the timings for tests. Placement is the
`SpawnPlanner`'s job (above); `Game` only asks it where things go.

### `core/physics/vehicleCollisions.ts`
Pairwise contact between each vehicle's compound collider: mass-weighted
separation along the deepest contact, elastic impulse exchange, spin-out
for light vehicles hit hard by heavy ones. The
ram-to-steal rule itself lives in `MatchRules.onRam` via callback — physics
just reports contacts.

### `core/gameplay/MatchRules.ts`

Four crates are live at once and each is its own race: picked up, rammed loose
and delivered independently. A car carries one at a time, so driving over a
second while loaded leaves it — committing to one race means giving up another,
which is where the tension comes from. Ram cooldowns are per crate rather than
global, or one steal anywhere would freeze the other three. A fresh wave lands
only when every crate of the last is home, so the final one on the map is worth
fighting over.

`chooseCrate()` decides which crate a driver should be going for: nearest loose,
else nearest a rival is running off with, else nearest teammate to escort.
Nearest first within a priority, because a car holds only one crate — the useful
answer is the next thing you can reach, not the richest thing on the map. It
lives in `core/` rather than the HUD because `DriverBrain` steers by it too, and
a marker that disagreed with the bots about what was worth chasing would be
worse than no marker.
Pickup, transfer-on-ram (any contact, teammates included, 0.6 s cooldown *per
crate*), drop-on-wreck (a carrier's crate falls where they died and the car
respawns just inside its own base), delivery scoring at the carrier's own team
base (two bases, placed on opposite sides of the field once per match),
win-at-5, and the wave reset. Emits typed `MatchEvent`s drained once per step
by `Game`.

### `core/ai/DriverBrain.ts`
Per-bot state machine: `seek` (no carrier) / `chase` (enemy carries — with
velocity prediction) / `deliver` (self or ally carries). Steering is
angle-clamped with slow-down on sharp turns; occasional jumps for flavor.

### `core/geo/`
The real-world coordinate math, ported from the prototype and unit-tested
against hand-computed values:

- `llToWorld` — lat/lon/alt → world (equirectangular, X=east, Z=south,
  Y=up × `WORLD_M_PER_M`).
- `latLonToEcef` — geodetic → WGS84 ECEF. It must be the ellipsoid: a
  spherical earth puts the origin ~24 km from Google's tiles at mid
  latitudes, far enough that a tight-radius walk of the tile tree never
  reaches the city.
- `ecefToWorldMatrix` — orthonormal ECEF → world rotation.
- `tileTransformChain` — the full Google 3D Tiles transform:
  `Scale(s, s·boost, s) · R(ecefToWorld) · Translate(-ecef0) · tileTransform`.
  The `Translate(-ecef0)` is load-bearing: tile transforms encode absolute
  ECEF positions (~6.3 M m); without subtracting the match center first, the
  rotation projects the earth radius onto the up axis and geometry renders
  kilometers off the ground.

## Multiplayer (`net/`)

Host-authoritative over WebRTC, exactly as `docs/MULTIPLAYER.md` specifies.
`OnlineFlow` runs the lobby (`lobby.ts`, Realtime Database rooms with
presence via `onDisconnect`) and, on start, connects every player through
Trystero (`TrysteroTransport`, signalling through the same database) and
hands `main.ts` a `RunningMatch`. The host's `HostSession` owns a seeded
`Game` whose seats are `local`, `bot`, or a remote uid; remote inputs arrive
as the latest wins, snapshots leave at 20 Hz, gameplay events are forwarded
as they fire. A `ClientSession` runs no simulation: it mirrors the host's
bodies as puppets with the host's ids, interpolated four ticks behind the
newest snapshot, and implements `WorldView` so the renderer, HUD, camera and
minimap do not know which they are drawing. The desert, the props and the
spawn layout all derive from the match seed, so every machine builds the
same world without shipping it. `protocol.ts` is the trust boundary: every
message from a peer is validated field by field before use, and a peer only
gets a seat by presenting that seat's token — a secret the player wrote
under database rules only they and the host can read — so a transport id,
which Firebase knows nothing about, can never claim someone else's car.

A match plays on the seeded desert or on a real place. A city `MatchMap`
carries its geocoded centre, not just the search text, so nobody re-geocodes
and two players cannot land on different Portlands; `decodeMatchMap` is the one
validator for both the database record and the wire. Because each client
streams its own city, the start is a barrier: clients report a `ReadyMsg` when
their world is built and the host holds the clock until everyone has, or 20 s
passes. The hello also carries `PROTOCOL_VERSION`, because a host on a dev
server and a friend on the deployed site is the normal case — a mismatch now
refuses the match and says so instead of silently dropping one player into a
different world.

Three Firebase gotchas are recorded where they bit, worth knowing up front:
a transaction's first run sees the local cache (null for an unread room), a
pre-registered `onDisconnect` write is validated against the rules at
registration time, and Vite reloads the page the first time it optimises a
newly imported dependency, which will confuse a browser test.

## Services

### `services/maps/MapsApi.ts`
Lazy-loads the Maps JS API via JSONP on first search. The JS API (not raw
REST) because it handles its own cross-origin auth — Elevation REST sends no
CORS headers and browsers block it with an unhelpful "Failed to fetch".

Elevation grids sample 64×64 in ≤500-location chunks (service limit 512).
Satellite imagery stitches a 3×3 grid of Static Maps tiles at zoom 15 into
one canvas; `crossOrigin='anonymous'` is safe because the endpoint sends
`access-control-allow-origin: *`, keeping the canvas untainted for GL upload.

### `services/tiles/Tileset.ts`
Google's tree, as probed: WGS84 ECEF with oriented-box bounding volumes,
~22 levels deep, `REPLACE` refinement, and a GLB at *every* level whose
`geometricError` halves per level (16 km at depth 8, 32 m at depth 20).
Content URIs alternate between `.glb` and external `.json` sub-tilesets, and
every nested fetch must forward the `?session=` from the root's URIs or
Google answers 400.

`collectTiles` walks level by level (sub-tileset fetches within a level run
in parallel), keeps nodes whose box lies within the load radius of the match
center, and takes the first GLB on each path whose error satisfies the
distance-based `LodPolicy` — never its ancestors, which would render
continent-sized slabs over the field. GLBs are fetched as arraybuffers with
the `X-Goog-Api-Key` header (GLTFLoader's own fetch can't set headers). They
are glTF Y-up with the ECEF placement baked into the node matrix, so
`glbPlacement` is `tileTransformChain` × a +90° X rotation.

`TileStreamer` owns the loaded tiles. After the initial load it keeps
refining around the player: every 250 ms it picks the nearest tile that is
too coarse for its distance (`STREAM_LOD`: 8 m tiles within 360 m, 16 m to
640 m) and swaps it for its children, one swap at a time, up to a tile cap.
Every coarse tile in the field is collected up front; only the nearest
`MAX_INITIAL_TILES` load, the rest are *parked*. Each tick, parked tiles
within 70 % of the fog horizon stream in nearest first, and under budget
pressure the farthest loaded tile beyond the horizon is evicted back onto
the parked list, so the player can drive anywhere in the field and find
photogrammetry there and come back to find it again. Before that, the field
had tiles only in a blob about 800 m around the spawn (the nearest 150
coarse tiles, refined until the cap), and Footprint 3D made it obvious
because its prisms stood there unpainted. There is still no coarsening.

### `services/tiles/tileColliders.ts` — one ground & 2.5D deckGrid
A Google 3D tile is one merged photogrammetry mesh (ground + buildings + trees
+ bridges), so per-mesh bounds say nothing about what is drivable. Each tile
is rasterized once (`rasterizeTile`) into a 10 m grid with three values per cell:
the highest surface (`top`: roofs, canopy, bridge decks), the lowest surface
(`low`: the street under a tree or deck), and a 32-bit vertical occupancy mask
(`mask`: 1.5 m height bins for underpass clearance detection).

Ground level is estimated from `top` by a morphological opening (min filter then
max filter at a 60 m radius, wider than a block) implemented row-by-row in
`AmortizedGroundBuilder` with a 1.5 ms per-frame budget to avoid streaming frame
freezes.

From this raster, two physical surfaces are extracted:
1. **The Shared Ground** (`groundField`): The tile street surface where tiles
   exist, the opened base under buildings, and the elevation-grid terrain where
   tiles do not, box-filtered once. `TileStreamer.groundHeightfield()` turns it
   into the `Heightfield` that vehicle physics, bot pathfinding, spawning, props,
   and terrain meshes sample.
2. **The 2.5D Deck Grid** (`deckGrid`): Elevated spans meeting narrow-ribbon
   geometry (`isNarrowSpan`, `isRoadwayRibbon`) with confirmed open vertical
   clearance underneath (`hasGroundClearance`) are classified as drivable decks.
   Terminal boundaries trace descending slopes down to ground level to connect
   solid approach ramps (e.g. Brooklyn Bridge earthen approaches).
   `Tileset.surfaceElevation()` evaluates this bilinearly in $O(1)$ time with zero
   allocations and zero raycasts.
3. **Building Colliders**: Cells standing $\ge 3.5\text{ m}$ above the base that
   are neither decks nor gradual driveable terrain (flood-filled by
   `isDriveableGround` to preserve slopes and knolls) merge into solid AABBs.
   Neighbor-aware horizontal insetting insets exterior street faces by 1.0 m to
   prevent 10 m raster quantization from protruding into street lanes, while
   keeping internal touching faces 100% flush.
4. **Road Corridors (`services/osm/roads.ts`, see `docs/ROAD-MASK.md`)**: In hilly cities, morphological
   opening sags by up to 17 m across crests, misclassifying streets as buildings.
   The road network is taken from a Google Static Maps roadmap styled down to road
   fills (thresholded to a raster), with drivable OpenStreetMap centrelines from
   Overpass as the fallback, and rasterized
   into a `roadMask` grid with reach-aware bounding box clearance (`halfWidth + cellSize * 0.85`).
   Road cells are exempt from building classification, and their driving ground height in
   `AmortizedGroundBuilder` is pinned directly to the true surface (`Math.min(top, low)`)
   rather than the sagging estimate. An asynchronous event (`onRoadsLoaded`) dynamically
   rebuilds colliders in a Web Worker as soon as Overpass queries return, ensuring
   driving corridors carve out seamlessly without delaying match start.
5. **Building Footprints (`MapsApi.fetchBuildingRaster`, see `docs/ROAD-MASK.md`)**: Google's
   building outlines at zoom 17, flood-filled into a footprint raster and rasterized by area
   coverage (70 % of a cell inside an outline). A footprint cell is a building whatever the
   ground estimate or the road corridor says, so a hillside block no longer shrinks to its
   tallest core and boxes reach the true building line instead of stopping a cell short of
   the street. Lands asynchronously like the roads (`onBuildingsLoaded`).

### "Painted 3D" Visual Mode (`render/FacadeBaker.ts`)

The collision boxes wearing photographs of the Google 3D Tiles. For every
wall face of every box, an orthographic camera standing in the street looks
straight at the face and renders the tiles into that face's rectangle of one
4096² atlas; the box shader reads the atlas through per-instance rectangle
attributes (`aRectNX/PX/NZ/PZ`). Only satellite ground and painted boxes are
drawn in the mode, so nothing can float and no road is ever covered. The face
camera looks half the gap to the box across the street (capped at 25 m) so
the far side cannot leak in, and 12 m behind the face for walls standing
inside their cell-quantized box. Faces are baked nearest the car first under a
4 ms frame budget, photos survive collider rebuilds for boxes whose bounds did
not change, and the nearest faces are refreshed every few seconds so tiles
that refined since show up. Texel size follows the total wall area (about
1 m downtown). Where the photo saw nothing (alpha 0) the box shows the same
satellite-toned fill as Best 3D.

### "Footprint 3D" Visual Mode (`render/PrismMeshView.ts`, `services/overture/buildings.ts`)

Painted 3D with the buildings drawn as the prisms they are. Overture Maps
publishes its buildings theme as one PMTiles archive on S3 with open CORS,
so `fetchFootprints` range-reads the few zoom-14 vector tiles covering the
inner field straight from the browser (about 1 MB a tile downtown, no key,
no server of ours) and returns metre-exact polygons in world metres with
Overture's `height` (95 % of downtown San Francisco has one; `num_floors`
times 3.2 m otherwise, and failing that the photogrammetry roof over the
footprint from the classifier's per-cell tops, then 6 m). `rebuildPrisms`
in `main.ts` extrudes each polygon from a metre under the lowest ground on
its outline to its height; building parts stack on their building. The mesh
is one BufferGeometry: a quad per footprint edge with an outward normal
(`prismWalls`), the roof triangulated by `ShapeUtils`, and per-vertex atlas
rectangles the same `FacadeBaker` fills, generalised from box faces to
`Wall` segments (`setWalls`). `wallReaches` decides how far each wall's
camera stands out with a 2D ray along the wall normal against every other
wall in a 40 m spatial hash: half the gap to the first wall that rises above
its base, 0 for a party wall on the same line (so it is never baked), and a
duplicate outline facing the same way (a part tracing its building) does not
count. The same polygons, rasterized, replace the Google outline fetch as
the classifier's footprint mask (`footprintRasterFromPolygons`), so every
mode gets the exact footprints and no Static Maps request for them; the
outline fetch stays as the fallback when Overture does not answer. Measured
downtown: 10,871 polygons, 96,531 walls, 765 ms to extrude (once per
place), about 1.4 m per texel across the whole set.

"Best 3D" (`render/TileClutterFilter.ts`, `snap`) is the earlier approach:
tile vertices moved onto the nearest box face so the tiles themselves are the
walls. It is kept for comparison; its failure modes (shards, walls buried in
overlapping boxes, bare faces) are what Painted 3D was built to remove.

### "Game 3D" Visual Mode (`render/BuildingMeshView.ts`)
To eliminate the visual-vs-collision mismatch inherent in photogrammetry,
"Game 3D" mode renders the exact extracted physical geometry:
- Instanced, extruded building boxes with height-based arcade palette (skyscrapers,
  mid-rise, residential).
- Instanced bridge deck slabs from `deckGrid`.
- Crisp 10 m grid terrain mesh.
This mode serves as both an arcade visual option and the primary QA diagnostic view:
what you see is physically what you hit by construction, with zero invisible walls.

### Street clutter filter (`render/TileClutterFilter.ts`)

Google's tiles bake parked cars, kerbs and street furniture into the same mesh
as the buildings, so nothing can be hidden by object. Instead every tile
material is patched through `onBeforeCompile` to read two textures the physics
already owns: the ground heightfield, and the collider pass's structure mask
(building, deck or ramp cells). Outside structure cells the filter either
flattens geometry under 2.5 m onto the ground plane, turning parked cars into
road decals while facades keep their ground floors, or discards it entirely,
leaving buildings and trees over streamed satellite ground. Hidden is the
default. Its per-fragment mask cut also removes any facade whose footprint
fell in a street cell, which the 10 m grid and the OSM road exemption make
common at the kerb. Swept is the alternative: flatten, then discard only
triangles whose three vertices all flattened. Kerbside walls survive, and so
do street trees, since no top-down mask separates a tree at the kerb from the
wall behind it; in open ground with no structure cell within reach the cut
rises to 6 m so buses and RVs go too, and there any triangle with even one
flattened vertex goes whole: a triangle from a flattened car roof up to a
sign or a tree was a dark tent lying across the road. The price is that a
tree standing in the open loses its trunk and floats; near a facade it keeps
everything. Both stream satellite ground under
tiles. Every patched material shares one set of uniform objects, so switching
modes is a value write and a ground refinement is a re-upload, never a
recompile.

**This is render-side only.** The colliders are built from the same rasters
regardless of mode, so anything the filter hides is still solid. That is a
deliberate visual-versus-collision mismatch and worth remembering when a street
looks clear but drives blocked.

## 3D Tiles, Collision & Alternative Architectures

Extracting gameplay physics from Google Photorealistic 3D Tiles is a fundamental
geospatial challenge because the tiles are visual aerial scans without semantic
metadata. The table below outlines how our architecture relates to industry
patterns:

| Architecture / Pattern | Mechanism | Pros | Cons / Trade-offs | Status in Repo |
| :--- | :--- | :--- | :--- | :--- |
| **A. 2.5D Raster + DeckGrid** *(Current)* | Rasterize tile mesh to 10m DSM (`top`/`low`/`mask`); extract DTM via morphological opening; sample decks bilinearly in $O(1)$. | Fast, deterministic in Node, zero runtime raycasts, frame-budgeted via `AmortizedGroundBuilder`. | Underdetermined: distinguishing bridges vs roofs vs slopes requires heuristic rules that risk city-by-city drift. | **Active default**. Standardized on $1:1$ scale with $O(1)$ queries. |
| **B. Mesh-BVH Collision** *(Cesium/Unreal pattern)* | Wrap GLTF meshes in spatial bounding hierarchies (`three-mesh-bvh`); raycast wheels down; sphere-cast walls. | True 3D topology; no classification needed for bridges or tunnels. | Photogrammetry is noisy: melted parked cars, jagged curbs, and non-manifold edges cause high-speed vehicle snags; BVH generation hitches during streaming. | Evaluated & spiked; mesh raycasting replaced by deckGrid in PR #2. |
| **C. Procedural Autogen / "Game 3D"** *(Flight Sim / Blackshark.ai)* | Use geospatial tiles purely as spatial input; render clean procedural boxes, roads, and props. | **Eliminates mismatches by construction**: 100% collision-visual parity, zero invisible walls, authentic arcade look. | Replaces photorealistic imagery with stylized low-poly graphics. | **Implemented** in `BuildingMeshView.ts`; accessible via view-mode toggle. |
| **E. Vector Road Hybrid** *(Autonomous Sim / OSM)* | Ingest OpenStreetMap road centerlines (`highway=*`, `bridge=yes`, `layer=*`); drape vector ribbons over 3D tiles. | 100% semantic ground truth; exact lane widths, overpasses, and approach ramps with zero heuristics. | Additional network query (Overpass API / OSM vectors) per relocation. | **Implemented on `main`** in `services/osm/roads.ts` with reactive worker rebuilds (`onRoadsLoaded`) and 0.85 reach padding. |
| **F. Sub-Lane High-Res Grid (5m)** *(Fine-grained Voxelization)* | Increase raster resolution from 10m to 5m cells for tile collision pass. | Separates 6–8m vehicle lanes from curbside tree canopies and building overhangs 100% offline. | 4× cell count; requires workerized rasterization and memory indexing. | **Spiked & validated** in driving experiments; eliminates curbside canopy bleed. |

## UI notes

Components style themselves from the token scale in `index.html`'s `:root`
(`--space-*`, `--radius-*`, `--text-*`, the palette, and derived surfaces),
backed by the modular color theme registry in `core/theme.ts`. Themes define
consistent palettes across CSS variables, HUD radar relief, atmospheric sky,
and 3D terrain biomes, with support for swappable presets (`CYBER_OBSIDIAN_THEME`,
`NEON_NIGHT_THEME`). Where one value should drive several, they derive: the nav
chevron sets `--chev-face` and mixes its shaded back and edge from it with `color-mix()`, so
a state change is one custom property rather than three rules.

Navigation is deliberately two things, as it was in Smuggler's Run. The
chevron gives a bearing and knows nothing about the ground — it will point you
straight through a ridge — and the radar (`ui/hud/Minimap.ts`) is what you read
to pick a line around one, which is why its substance is shaded terrain relief
rather than blips on a flat fill. It is heading-up so "left around that hill"
is left on screen too, with a north tick on the rim; anything past its range is
pinned to the rim keeping its bearing, so an objective is never simply absent.
The relief is rasterised once per terrain and only rotated per frame, because a
real place is a 313k-vertex heightfield. Both halves read the same target from
`navMarker()`, so they can never disagree. `ui/hud/radar.ts` holds the pure
projection and shading maths, tested in node.

The HUD's corners are positioned in `index.html` — the `.hud-corner` classes
were named in `main.ts` from the first commit but never styled, so until
recently the whole HUD stacked in normal flow underneath the canvas. Corners
use `env(safe-area-inset-*)` so nothing hides under a notch, and shrink on
small or short viewports. The game has no touch controls and is not playable on
a phone, but the page behaves: `dvh` heights, no overscroll, `touch-action:
none` on the canvas, 16px form fields so iOS does not zoom on focus, and no
horizontal overflow at 390 px.

`ui/hud/navArrow.ts` holds the nav chevron's orientation and `app/navTarget.ts`
decides where it points; both are pure and DOM-free, so they unit test in node
despite serving the HUD. The chevron is a rigid plate lying on a leaned ground
plane, turning about that plane's normal only — composing the lean *after* the
yaw turns it into roll, which is what made an earlier version tumble.
`navTarget` answers "am I carrying?", never "is anyone carrying?", so a rival
stealing your crate swings the marker onto them rather than leaving it on a
base you can no longer deliver to. Which of the four it picks is
`chooseCrate()`'s call, above.

Keyboard guards go through `isTypingInField()` in `ui/controls.ts`, never
`document.activeElement` directly: that retargets to the shadow *host*, so a
field inside a Lit component reads as `<SR-LOBBY>` and every naive guard
concludes the player is not typing. The guard lives in `ui/` (not `input/`)
because the keyboard source consumes it to suppress gameplay keys while a
field has focus, and `input/` keeps no dependency on `ui/`.

## Render notes

`VehicleView` keeps the world position on its group and rotates the car body
inside it, so the health bar stays upright. The body's pose is
interpolated between sim steps; a cosmetic pitch/roll from the terrain under
the wheels is added on top. The mesh's origin is its ground contact while the
physics origin sits `groundClearance` above the ground, so the mesh hangs a
clearance below the body (it rode a metre in the air until the contact shadow
gave that away), and the wheels reach down by however far the suspension is
holding the body above its ride height, so the tyres stay planted without
giving up the smoothing that keeps the camera calm. `render/vehicleMeshes.ts` builds one silhouette
per roster type from primitives (buggy cage, rally spoiler, SUV rack, lifted
pickups) with clearcoat paint in the team color, the type's accent on trim,
headlights, and tail lights that flare while braking. Wheels sit in pivots
(the front pair steer with the input) and spin on their axle with forward
speed; wheel radius scales with the type's mass. `render/Pickups.ts` pools a
crate mesh per live crate — a fading light beacon each, hidden while carried,
bob phases staggered so a wave does not pulse in lockstep — and draws each base
as a landing pad: glow disc, edge ring, rotating dashes, lit pylons and a beam,
all in team color.

The app boots into the garage (`ui/screens/IntroScreen.ts`) with no match
spawned: the HUD, relocate bar and pickups are hidden, and `render/Showroom`
turns the selected vehicle at the field center with the camera orbiting it
and the frustum shifted right of the garage panel (`setViewOffset`).
`Game.playerType` records the pick; START spawns the match.

The sky is an equirectangular canvas painted once (`render/skyTexture.ts`):
gradient, sun disc at the light's direction, a cloud band above the horizon,
haze below; the fog takes the horizon color. The same canvas, run through
PMREM, is the environment map for car paint, glass and chrome, so a car
reflects the sky it is parked under rather than a studio.

### Compositing game objects into photo tiles

A real place is two photographs with their own sunlight baked in: Google's
tiles (unlit `MeshBasicMaterial`s straight from the GLB) and the satellite
ground. Everything the game draws on top is lit by one scene sun. Making the
two read as one picture is the same problem as augmented reality, and it uses
the same standard answers:

- **The photo is shown as shot.** Tile, satellite terrain and ground patch
  materials are unlit and `toneMapped = false`: running display-referred
  imagery through the filmic curve again crushed facades and darkened every
  street, and lighting the satellite ground with the scene lights put a blue
  cast on it that the buildings standing on it did not have. The satellite
  terrain used to be a lit `MeshStandardMaterial`; that is why.
- **Two light rigs** (`GameRenderer.setLightRig`). `arcade` is the original
  sun/ambient/hemisphere for the procedural desert and Game 3D. `photo`
  scales them so a lit car's upward faces land at about the brightness of a
  photographed surface with the same albedo. `main.ts` switches on view mode
  and whether the terrain is real.
- **Ground shade** (`render/GroundShade.ts`). The imagery's own shadows are
  the truth about the light here, so each car samples the brightness of the
  ground under it and scales its body colours to match, easing in over
  ~0.15 s. The base satellite canvas and every streamed patch are reduced once
  to a small luminance grid on load; "sunlit" is the field's 45th percentile,
  which is ordinary asphalt, not roofs. Headlights and tail lights keep their
  own glow. Off in Game 3D.
- **Contact shadow.** Every car carries a soft dark ellipse on the ground,
  always on, thinning as it lifts off. A real shadow map would fight the
  shadows already baked into the tiles; this is the ambient-occlusion pool a
  car has under it in any light, and it is what stops the car floating over
  the picture.
- **Detail grain** (`render/DetailGrain.ts`). Within ~100 m of the camera a
  satellite patch or tile is magnified thirty times and turns to smear, so a
  tiling grey grain (three cache-resident reads, triplanar so facades get it
  too, fading to nothing by 110 m) is multiplied into the albedo. It is
  injected into every tile material by the clutter filter's shader patch and
  into the ground materials directly.
- **Patch coverage cutout.** A streamed patch and the base terrain are two
  triangulations of the same heightfield, so polygon offset alone let the
  blurry zoom-15 base bleed through as dark polygons wherever the coarser
  patch dipped under it. `GroundStreamer.onCoverageChanged` hands the terrain
  a 32×32 grid of which patch cells are loaded and the terrain shader discards
  its fragments under them. Patches are also subdivided to ~10 m so they
  follow the same bumps the physics ground has.

What this cannot fix is the two photographs disagreeing: the satellite pass
and the tile capture were flown on different days, so a street in a tower's
shadow in one is sunlit in the other. Ground shade follows the satellite
because that is what the car is standing on.

## Performance

The game has to run on modest machines, so cost scales rather than being
fixed:

- **Adaptive resolution** (`GameRenderer.adapt`): the base pixel ratio is 1.0
  on standard displays and capped at 1.5 on high-DPI ones, and three discrete
  tiers (1.0, 0.86, 0.74) multiply it. A tier change resizes the canvas and
  reallocates the multisampled backbuffer, roughly a 150 ms stall, so it must
  answer only sustained GPU load: the trigger is the **median** of the last
  1.5 s, after a 5 s grace and with 5 s between changes. It used to trigger on
  a moving average, which any single streaming hitch dragged over the line, so
  the scaler was itself a reliable source of stutter at match start. The 1.5
  cap was measured rather than guessed: on an M1 Pro driving Manhattan, 1.25
  holds 120 Hz while 1.5 and 2.0 both hold a locked 60 Hz.
- **Draw calls**: props are two `InstancedMesh`es for the whole field;
  vehicles are ~25 meshes each; tiles are one mesh each and capped
  (`MAX_TILES`).
- **Physics broadphase**: building colliders live in a 40-unit spatial hash;
  each car tests only the 3×3 cells around it instead of every box in the
  city.
- **Nav**: the grid is 6 m over the 5600 m field, so a full sweep is ~870k
  cells and measured 25-60 ms. Fields are cached per target, and the BFS now
  **expands lazily**, only as far as the cell being asked about. A cell's
  distance is final on discovery and every neighbour nearer the target is
  discovered before it, so routing is identical to a full sweep. Respawn asks
  a local clearance window instead of a whole-grid distance transform.
- **HUD**: the store pushes at 10 Hz; health-bar textures re-upload only when
  integrity changes; the direction arrow bypasses the store.
- **Off the frame**: what makes this game feel bad is single-frame stalls, not
  average framerate — p95 was a perfect 16.7 ms while 60-200 ms stalls landed
  about once a second. Collider rebuilds moved to a Web Worker; the terrain
  re-drape copies heights straight from the heightfield grid and takes normals
  by central differences instead of sampling 315k vertices; tile programs and
  textures are compiled and uploaded as each tile lands rather than when it
  first enters the frustum; and the satellite footprint repaint, a 3840²
  re-upload with mipmaps, is throttled.
- **Shader linking**: a program's link status is only read on its first draw,
  and reading it blocks until the driver has finished linking, so a
  synchronously compiled tile still cost 30-100 ms inside the first frame
  that drew it (`getProgramInfoLog` in a profile). `GameRenderer.warm` now
  uses `compileAsync`, which polls `KHR_parallel_shader_compile`, and hides
  the object until every program is ready. `scripts/hitch-profile.mjs`
  attributes long frames like that one function by function.
- Remaining known costs: tile rasterization on the main thread, ground-builder
  completion (~15-25 ms), and satellite patch decode (~10 ms each).

Future work is tracked in [`ROADMAP.md`](ROADMAP.md).

## Extension points

- **New vehicle type** — append to `VEHICLE_TYPES` in
  `core/physics/vehicleStats.ts`, collider included. Physics, AI, and HUD
  pick it up automatically.
- **Finer collision** — more spheres in a roster entry's collider (wheels,
  a bumper) need no new code. A new shape kind or a per-layer rule (soft
  props, trigger volumes) goes in `core/physics/collision.ts`.
- **Spawn tuning** — `SpawnConfig` in `core/spawn/SpawnPlanner.ts`: ring
  size, clearances, drop height, base offset.
- **New AI behavior** — add a state in `DriverBrain`'s state machine. The
  brain only produces a `VehicleInput`; no other layer changes.
- **New terrain source** — implement `TerrainProvider` (e.g. an offline
  DEM file) and pass it to `Game.reset()`.
- **New input source** — implement `InputSource` (e.g. `TouchSource`) and add
  it to `InputManager`'s sources. The merge and edge routing take it up
  automatically; the sim and screens don't change.
- **Tuning** — every constant lives in `app/config.ts` in sections. The
  prototype's hardcoded numbers are all there.

## Testing philosophy

`core/` is DOM-free and network-free by construction, so its tests run in
plain node with no jsdom: geo projections against hand-computed points,
physics invariants (momentum conservation, auto-righting recovery time,
angular-velocity caps), gameplay rules (transfer cooldowns, scoring,
winning), AI state transitions, and store/event plumbing. The render and UI
layers are thin enough over core that they're exercised by the smoke path
(dev server + headless console check) rather than unit tests — except the pure
UI logic that has bitten us (`navArrow`, `navTarget`), which is DOM-free
precisely so it can be tested here.

The renderer and HUD are covered by `npm run smoke`, which drives a headless
desert match at four widths and asserts the things that have
actually broken: console errors, HUD corners off-screen, horizontal overflow,
and a radar that never rasterised its relief. Multiplayer has `npm run
e2e:online`, two headless browsers through a real room against Firebase. Both
take `E2E_URL`, so both can run against a deployment.

The local sim and the network client are two `WorldView` implementations of one
match, so anything they both need is shared rather than copied: `navMarkerFor`
in `app/navTarget.ts` and `buildHudSnapshot` in `app/hudSnapshot.ts`. They each
used to hold their own copy — 15 of 17 lines and 19 of 24 identical — which is
how one bug in the nav target came to exist in two places and get fixed in
one.
