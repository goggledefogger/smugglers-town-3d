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
There is no coarsening — evict far tiles first if memory ever bites.

### `services/tiles/tileColliders.ts` — one ground
A tile is one merged photogrammetry mesh, so per-mesh bounds say nothing
about buildings. Each tile is rasterized once (`rasterizeTile`) into a 10 m
grid with two values per cell: the highest surface (`top`: roofs, canopy,
wall tops) and the lowest (`low`: the street under a tree or a bridge deck).
Ground level is estimated from `top` alone by a morphological opening — a
min filter then a max filter at a 60 m radius, wider than a block — which
returns a slope unchanged and erases anything narrower than the window. A
cell is a building when `top` stands ≥ 8 real m above that base. Building
cells merge into AABBs whose floors are cut from the base.

`groundField` then produces **the one ground everything plays on**: the
tile surface where tiles exist (`low` on streets, the base under buildings,
plus `TILE_GROUND_GAP` so the satellite drape covers the photogrammetry
street), the elevation-grid terrain where they do not, box-filtered once.
`TileStreamer.groundHeightfield()` turns it into the `Heightfield` that
physics, spawning, props, shadows, the camera and the drape all sample;
`main.ts` swaps it in before the match starts and refreshes it in place
(`Heightfield.copyFrom`, `TerrainMesh.refresh`) every few seconds while
streaming sharpens the tiles. Before play, `refineCore` brings every tile
within 600 m of the start to the streaming LOD, because a ground and a set
of colliders taken from the coarse first load put cars where buildings turn
out to be.

Why one ground: the elevation grid is 64×64 samples over 5.5 km — one every
87 m — smoothed with a bicubic. Over flat Portland its error stays inside
the drape gap. In San Francisco a hill is four samples wide and the grid is
off by whole storeys either way, so cars sat inside the tile mesh (the
camera in geometry) and passed under building boxes whose floors were cut
from the other ground. No spawn heuristic can fix standing on the wrong
ground.

The two datums still meet here: tiles are placed by height above the WGS84
ellipsoid, the elevation grid is above mean sea level, and the geoid runs
~20 m below the ellipsoid around Portland. `tileGroundOffset` measures the
tile base against the terrain over the field core (30th percentile) and
shifts the whole group so the fallback seams stay small. The elevation grid
remains the ground for the terrain mesh before tiles load and for
relocations where tiles fail.

Known limit: a single heightfield has no second layer, so a bridge deck is
not drivable — the ground under it is. Colliders are rebuilt every 1.5 s
while streaming changes tiles; scattered props contribute their own AABBs.

## Render notes

`VehicleView` keeps the world position on its group and rotates the car body
inside it, so the health bar and blob shadow stay upright. The body's pose is
interpolated between sim steps; a cosmetic pitch/roll from the terrain under
the wheels is added on top. `render/vehicleMeshes.ts` builds one silhouette
per roster type from primitives (buggy cage, rally spoiler, SUV rack, lifted
pickups) with clearcoat paint in the team color, the type's accent on trim,
headlights, and tail lights that flare while braking. Wheels sit in pivots
(the front pair steer with the input) and spin on their axle with forward
speed; wheel radius scales with the type's mass. `render/Pickups.ts` draws
the crate with a fading light beacon (hidden while carried) and each base as
a landing pad: glow disc, edge ring, rotating dashes, lit pylons and a beam,
all in team color.

The app boots into the garage (`ui/screens/IntroScreen.ts`) with no match
spawned: the HUD, relocate bar and pickups are hidden, and `render/Showroom`
turns the selected vehicle at the field center with the camera orbiting it
and the frustum shifted right of the garage panel (`setViewOffset`).
`Game.playerType` records the pick; START spawns the match.

The sky is an equirectangular canvas painted once (`render/skyTexture.ts`):
gradient, sun disc at the light's direction, a cloud band above the horizon,
haze below; the fog takes the horizon color.

## Performance

The game has to run on modest machines, so cost scales rather than being
fixed:

- **Adaptive resolution** (`GameRenderer.adapt`): the pixel ratio steps down
  when frames average under 45 fps and back up when they run under 17 ms,
  between half and the display's native ratio. Resolution is the knob that
  scales GPU cost on every machine without changing what the game looks like
  up close.
- **Draw calls**: props are two `InstancedMesh`es for the whole field;
  vehicles are ~25 meshes each; tiles are one mesh each and capped
  (`MAX_TILES`).
- **Physics broadphase**: building colliders live in a 40-unit spatial hash;
  each car tests only the 3×3 cells around it instead of every box in the
  city.
- **Nav**: BFS fields are cached per target and only recomputed when the
  target moves; the grid is 20 m so a field is ~78k cells (a few ms).
- **HUD**: the store pushes at 10 Hz; health-bar textures re-upload only when
  integrity changes; the direction arrow bypasses the store.
- Known hitches: collider rebuilds during tile streaming (~15–30 ms every
  1.5 s while tiles change) and the initial tile rasterization — candidates
  for a worker (see ROADMAP).

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
