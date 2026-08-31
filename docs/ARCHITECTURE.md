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
(`config.loop.step`), so physics is deterministic across refresh rates; views
sync once per animation frame. The HUD snapshot is pushed at 10 Hz —
high-frequency values (speed) interpolate visually, no one misses them.

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

### `core/physics/vehicleCollisions.ts`
Pairwise sphere collisions: mass-weighted separation, elastic impulse
exchange, spin-out for light vehicles hit hard by heavy ones. The
ram-to-steal rule itself lives in `MatchRules.onRam` via callback — physics
just reports contacts.

### `core/gameplay/MatchRules.ts`
Contraband pickup, transfer-on-ram (cross-team, 0.6 s cooldown), delivery
scoring, win-at-5, respawn of contraband + drop zone. Emits typed
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
Traverses the 3D Tiles tree for regions overlapping the target box. Region
lat/lon arrive in *degrees* despite the spec saying radians — detected by
magnitude (`> π`) and normalized. GLBs are fetched as arraybuffers with the
`X-Goog-Api-Key` header (GLTFLoader's own fetch can't set headers), then
placed via `tileTransformChain`. `mineBuildingColliders` extracts world-space
AABBs from meshes ≥2 world-units tall — the "building detection" that makes
cars smash into real buildings instead of driving through them.

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
