# Smugglers Town 3D: Turf Wars

A 4v4 arcade vehicle combat game — a single piece of contraband spawns on the
map. Grab it, rush it back to your crew's base (each team has one, fixed for
the match). Get rammed and it transfers to the attacker. First team to
**5 deliveries** wins, or whoever leads when the **5-minute** clock runs
out; a tie goes to sudden death.

Plays instantly on a procedural desert. With a Google Maps API key (Maps
JavaScript + Elevation + Static Maps + Photorealistic 3D Tiles), relocate the
match to any place on Earth — real terrain, satellite imagery, and collidable
photorealistic buildings streamed from Google's 3D Tiles.

## Quickstart

```bash
npm install
npm run dev        # → http://localhost:5173
```

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm test` | Vitest suite (81 tests, node env) |
| `npm run test:watch` | Tests in watch mode |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run build` | Typecheck + production build to `dist/` |

## Controls

| Key | Action |
|---|---|
| `W` / `↑` | Accelerate |
| `S` / `↓` | Brake / reverse |
| `A` `D` / `←` `→` | Steer |
| `Space` | Jump-boost (dune launch) |
| `R` | Reset car to a nearby spot |
| `C` | Cycle camera (chase / far / hood) |
| `1`–`5` | Switch vehicle (Buggy, Rally, SUV, Trophy, Monster) |

Keys typed into a text field (search box, API key) never reach the game.

The game opens in the garage: pick a ride from the roster (`↑`/`↓` or `1`–`5`,
`Enter` or **START ENGINE** to go). The selected vehicle turns on a 3D
showroom stand with its stats alongside, and the choice sticks for rematches.

## Vehicle roster

| Vehicle | Mass | Accel | Top speed | Durability | Grip |
|---|---|---|---|---|---|
| Dune Buggy | 1.0 | 1.4× | 1.15× | 0.55 | 0.82 |
| Rally Car | 0.9 | 1.5× | 1.30× | 0.45 | 0.70 |
| SUV | 1.4 | 1.0× | 1.00× | 1.00 | 1.00 |
| Trophy Truck | 1.3 | 1.1× | 1.05× | 0.90 | 0.95 |
| Monster Truck | 2.0 | 0.75× | 0.85× | 1.50 | 1.20 |

Heavier vehicles dominate rams; lighter ones out-handle them. Any ram steals
the contraband, teammates included, with a 0.6 s cooldown between transfers.
Landings, walls and rams cost integrity (divided by durability); at zero you
wreck, the crate drops where you died, and you respawn just inside your base.

Where this is headed: [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Project layout

```
src/
├── main.ts          composition root — wiring, frame loop
├── app/             Game loop, state, events, config
├── core/            Simulation: physics, AI, gameplay, terrain, geo math
├── render/          three.js views (renderer, terrain, vehicles, camera)
├── services/        Google Maps + 3D Tiles behind interfaces
└── ui/              Lit HUD components + screens, keyboard controls
tests/               Vitest — core is fully DOM-free and unit-tested
```

Layer rules and data flow are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Tech

- **TypeScript** (strict, `noUncheckedIndexedAccess`)
- **three.js** — rendering, vector/quaternion math
- **Lit** — HUD and screen components
- **Vite** — dev server and builds
- **Vitest** — unit tests

Runtime dependencies are exactly `three` and `lit`. The simulation core has
zero DOM dependencies and runs in node for tests.

## Google Maps relocation (optional)

Paste a Maps API key in the top bar, then search any place. The key is stored
in `localStorage` only. Required APIs on the key:

- **Maps JavaScript** (geocoding + elevation; handles its own CORS)
- **Static Maps** (satellite tiles — `crossOrigin='anonymous'` works because
  the endpoint sends `access-control-allow-origin: *`)
- **Photorealistic 3D Tiles** (real building geometry, auth via
  `X-Goog-Api-Key` header)

Elevation sampling respects the ElevationService 512-locations-per-call limit
(64×64 grid in 9 chunks). 3D tiles are best-effort — if they fail, real terrain
still loads.

The tile loader walks Google's ~22-level tree to a distance-based level of
detail (`DEFAULT_LOD` in `services/tiles/Tileset.ts`: 16 m geometric error
near the match center, 64 m toward the field edge — roughly 85 tiles / 20 MB
for a downtown), then keeps streaming finer tiles around the player as you
drive (8 m within 360 m). Each tile is one merged photogrammetry mesh, so
building colliders come from rasterizing those meshes into a 10 m height
grid and boxing every cell that rises well above the terrain or above its
surroundings.

## Origin

Ground-up rebuild of the single-file `version_glm_53/smugglers_run.html`
prototype (~1.6 k lines) into a modular, tested, documented codebase. The
prototype remains untouched as reference.
