# Contributing

Thanks for helping. This is a small codebase with a few firm opinions; this
page is the short version of them.

## Getting started

```bash
npm install
npm run dev        # Vite on http://localhost:5173
```

Node 20 or newer. The procedural desert needs nothing else. To drive a real
city, paste a Google Maps Platform key into the bar at the top of the game;
it stays in your browser's `localStorage` and never enters the repo or the
build. The key needs the Map Tiles, Elevation, Geocoding and Places APIs
enabled.

Useful scripts:

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` under the strict config |
| `npm test` | The unit suite, plain node, under a second |
| `npm run build` | Typecheck plus a production bundle in `dist/` |
| `npm run serve` | Build and serve it the way hosting will |
| `npm run e2e:online` | Two headless browsers play an online match against the dev server |

## Where things live

```
src/core/       the simulation: physics, gameplay rules, AI, spawning, geo math
src/app/        glue: the game loop, config, events, the store the HUD reads
src/render/     three.js scene, meshes, textures, camera
src/ui/         Lit components for the HUD and menus
src/services/   the outside world: Google Maps, 3D Tiles, Firebase
tests/          vitest, one file per area
docs/           architecture, roadmap, deploy, multiplayer spec
```

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the tour; read it before a
change that crosses two of those directories.

## The one rule that matters

`core/` never imports from `app/`, `render/`, `ui/`, or `services/`. Its only
dependency is three.js math types. That is what keeps the whole simulation
testable in plain node with no browser, and it is easy to break by accident.
If you find yourself reaching for the renderer or the network from inside a
physics file, the answer is an event or a return value, not an import.

A few consequences worth knowing:

- Randomness in `core/` comes from an injected `Rng` (`core/rng.ts`), never
  `Math.random`. A seed must reproduce a match.
- Anything placed in the world goes through the `SpawnPlanner`, and human
  and bot drivers take the same path. There is no player special case.
- The sim steps at a fixed 60 Hz; views interpolate. Do not read the frame
  rate from inside `core/`.
- Every tunable lives in `app/config.ts`. A magic number in a physics file
  is a bug unless it has a comment saying why it cannot move.

## Making a change

1. Branch from `main`.
2. Make the change with its test. Anything with a branch, a loop, or a rule
   gets one; physics and gameplay changes especially. Several bugs in this
   codebase's history were caught only because a test pinned the old
   behavior.
3. Run the three commands below. All green before you push.
4. If the change can only be judged by looking at it, say so in the pull
   request and attach a screenshot.

```bash
npm run typecheck && npm test && npm run build
```

### Checking it in a browser

The desert start needs no key and covers physics, colliders, bots and the
HUD: start the dev server, press Start Engine, drive, brake, reverse, turn,
and watch the console. Headless works too; the repo's tests do not drive a
browser, but a short Playwright script that clicks Start Engine, holds a key
for a few seconds and reads the console is a fine smoke check, and how the
tile pipeline gets verified.

### Checking multiplayer

`npm run e2e:online` (with the dev server running) launches two headless
Chrome contexts, creates a room in one, joins from the other, readies up,
starts, drives, and prints both HUDs. It talks to the real Firebase project,
so it needs network. For a manual check, two browser profiles (not two tabs:
they share the anonymous sign-in) against the deployed site is the closest
thing to a friend joining.

### Adding things

The architecture doc has an "Extension points" section. The short list:

- A vehicle: one row in `core/physics/vehicleStats.ts`, collider included.
- A bot behavior: a state in `core/ai/DriverBrain.ts`. It only produces a
  `VehicleInput`.
- Finer collision: more spheres in a vehicle's collider, or a new shape kind
  in `core/physics/collision.ts`.
- A terrain source: implement `TerrainProvider`.

## Comments

Comment the *why*, not the *what*. This codebase has a few places where the
obvious implementation is wrong for a non-obvious reason: Google's tiles sit
on a different datum than the elevation API, glTF is Y-up where 3D Tiles are
Z-up, a fixed physics timestep aliases against a 120 Hz display. Those
comments earn their keep. `// increment the counter` does not.

If you fix a bug that came from a framework gotcha, leave two lines above the
fix explaining the constraint. Write it while you still remember.

## Performance

The game targets modest hardware. Before adding per-frame work, check what
it costs: draw calls, texture uploads, and allocations in the frame loop are
the usual suspects. Reuse scratch vectors instead of allocating in `sync()`
or `step()`. The architecture doc has the current budget and the known
hitches.

## Commits and pull requests

Conventional prefixes (`feat:`, `fix:`, `docs:`, `refactor:`). Say what
changed and why in the body; for a subtle fix, explain the root cause rather
than the symptom. Keep unrelated changes in separate commits.

A pull request should say what to look at first, what you tested and how,
and anything you deliberately left out. Small and focused beats large and
complete.

## Secrets and services

Nothing secret ships in the bundle. The Google Maps key is the player's own.
The Firebase web config in `src/services/firebase.ts` is an identifier, not
a secret; what anyone can do with it is set by the rules files in the repo
root. Deploying is in [`docs/DEPLOY.md`](docs/DEPLOY.md).
