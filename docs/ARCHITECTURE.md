# Architecture

## Layers

```
┌─────────────────────────────────────────────────┐
│ ui/          Lit components, keyboard input      │  DOM
├─────────────────────────────────────────────────┤
│ app/         Game loop, store, events, config    │  orchestration
├──────────────────────┬──────────────────────────┤
│ core/                │ render/                   │
│ simulation           │ three.js presentation     │
│ (pure, DOM-free)     │ (reads sim state)         │
├──────────────────────┴──────────────────────────┤
│ services/    Google Maps, 3D Tiles (network)     │
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

## Frame data flow

```
KeyboardState ─► Game.update(dt) ─► VehicleBody.step ×8 ─► resolveVehicleCollisions
                                       │                        │
                                       │                        ▼
                                       │                  MatchRules (pickup/steal/deliver)
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
control, auto-righting, hard-landing tumbles, world bounds, and building AABB
resolution. The two quaternion gotchas preserved from the prototype (each is
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
flipped so the rear swings the way you steer. Damage from landings, walls
and rams is divided by the vehicle's `durability`; at integrity 0 the body
stays wrecked until `Game.wreck` drops its crate and respawns it. Physics
tuning enters through `app/config.physics` (plus the field size); the
`DEFAULT_PHYSICS` in the module exists for tests.

### `core/ai/DriverBrain.ts`
Bots have no pathfinding. A stuck detector (full throttle but crawling for
0.8 s while grounded) triggers a 0.9 s reverse with a random steer, which is
what gets them off building walls. Spawns use the most open spot
near the field center (`Game.findOpenCenter`) and contraband / drop-zone
placement requires clear ground around the point, so a downtown start never
wedges anyone between towers.

### `core/physics/vehicleCollisions.ts`
Pairwise sphere collisions: mass-weighted separation, elastic impulse
exchange, spin-out for light vehicles hit hard by heavy ones. The
ram-to-steal rule itself lives in `MatchRules.onRam` via callback — physics
just reports contacts.

### `core/gameplay/MatchRules.ts`
Contraband pickup, transfer-on-ram (any contact, teammates included, 0.6 s
cooldown), drop-on-wreck (the crate falls where the carrier died and the car
respawns just inside its own base), delivery
scoring at the carrier's own team base (two bases, placed on opposite sides
of the field once per match), win-at-5, respawn of contraband. Emits typed
`MatchEvent`s drained once per step by `Game`.

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
There is no coarsening — evict far tiles first if memory ever bites.

### `services/tiles/tileColliders.ts`
A tile is one merged photogrammetry mesh, so per-mesh bounds say nothing
about buildings. Each tile is rasterized once (`rasterizeTile`): every
triangle's top is stamped into a 10 m height grid over its footprint.
`collidersFromRasters` composites those, then calls a cell a building when
its top rises ≥18 real m above the elevation-grid terrain (tall buildings,
roof interiors included) *or* ≥6 m above the lowest neighbouring cell
(ramps, low buildings, poles — things the coarse elevation grid can't
see; the 1-cell window keeps hillsides out). Building cells merge into
AABBs: runs along X, then identical runs stack across rows. Colliders are
rebuilt every 1.5 s while streaming changes tiles. Scattered props
contribute their own AABBs.

Two ground datums meet here and they disagree: tiles are placed by height
above the WGS84 ellipsoid, the elevation grid is above mean sea level, and
the geoid runs ~20 m below the ellipsoid around Portland — untreated, that
buried bridge decks and ground floors. `tileGroundOffset` measures the tile
ground against the terrain over the field core after the initial load and
the streamer shifts the whole group so the tile ground sits
`TILE_GROUND_GAP` under the satellite drape, which then covers the
photogrammetry ground instead of z-fighting with it.

## Render notes

`VehicleView` keeps the world position on its group and rotates the car body
inside it, so the health bar and blob shadow stay upright. The body's pose is
interpolated between sim steps; a cosmetic pitch/roll from the terrain under
the wheels is added on top. Wheels sit in pivots (the front pair steer with
the input) and spin on their axle with forward speed; wheel radius scales
with the type's mass and the roll bar carries the type's accent color.

Future work is tracked in [`ROADMAP.md`](ROADMAP.md).

## Extension points

- **New vehicle type** — append to `VEHICLE_TYPES` in
  `core/physics/vehicleStats.ts`. Physics, AI, and HUD pick it up
  automatically.
- **New AI behavior** — add a state in `DriverBrain`'s state machine. The
  brain only produces a `VehicleInput`; no other layer changes.
- **New terrain source** — implement `TerrainProvider` (e.g. an offline
  DEM file) and pass it to `Game.reset()`.
- **Tuning** — every constant lives in `app/config.ts` in sections. The
  prototype's hardcoded numbers are all there.

## Testing philosophy

`core/` is DOM-free and network-free by construction, so its tests run in
plain node with no jsdom: geo projections against hand-computed points,
physics invariants (momentum conservation, auto-righting recovery time,
angular-velocity caps), gameplay rules (transfer cooldowns, scoring,
winning), AI state transitions, and store/event plumbing. The render and UI
layers are thin enough over core that they're exercised by the smoke path
(dev server + headless console check) rather than unit tests.
