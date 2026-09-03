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
and watch the console.

`npm run smoke` does that headlessly at desktop and phone sizes, and is the
only automated cover the renderer and HUD have: it drives the car, then asserts
no console errors, all four HUD corners on-screen, no horizontal overflow, and
that the radar actually rasterised terrain rather than a flat fill. Everything
it checks is something that has really broken. Add a case when you fix a bug it
would have caught, and make sure the new check fails before your fix — a check
that cannot fail is worse than none.

`E2E_URL=… npm run smoke` runs it against a deployment.

### Checking multiplayer

`npm run e2e:online` (with the dev server running) launches two headless
Chrome contexts, creates a room in one, joins from the other, readies up,
starts, drives, and prints both HUDs. It talks to the real Firebase project,
so it needs network. For a manual check, two browser profiles (not two tabs:
they share the anonymous sign-in) against the deployed site is the closest
thing to a friend joining. When something goes wrong, the lobby's "copy
debug log" link and `?debug` on the URL are the first stop; `docs/DEPLOY.md`
covers reading the remote logs.

### Adding things

The architecture doc has an "Extension points" section. The short list:

- A vehicle: one row in `core/physics/vehicleStats.ts`, collider included.
- A bot behavior: a state in `core/ai/DriverBrain.ts`. It only produces a
  `VehicleInput`.
- Finer collision: more spheres in a vehicle's collider, or a new shape kind
  in `core/physics/collision.ts`.
- A terrain source: implement `TerrainProvider`.

## Logging

One logger, `src/app/log.ts`, and nothing else — a raw `console.log` in `src/`
is a bug, because it reaches neither the ring buffer a player copies out nor
the Firebase sink. Get a scoped logger once per module and use it:

```ts
const log = logger('tiles');
log.info('tiles loaded', { tiles: 84, ms: 9100 });
```

Scopes in use: `app`, `render`, `tiles`, `relocate`, `online`, `lobby`,
`firebase`, `rtc`, `host`, `client`. `core/` does not log; it returns.

Levels earn their place by who reads them:

- `debug` — ring buffer only, plus the console with `?debug` in the URL. Where
  per-item detail goes: one dropped tile, a frame-scale change.
- `info` — the events you would want in a stranger's bug report: boot, match
  start, a finished relocation. Every session starts with one `boot` line
  carrying the protocol version, user agent and GPU.
- `warn` / `error` — something the player will notice.

Pass structured data as the second argument, never interpolated into the
message: `log.info('tiles loaded', { tiles, ms })`, not
`log.info(\`loaded \${tiles} tiles\`)`. The messages are grepped and the data is
parsed. High-frequency failures log at `debug` and are counted, with one
summary at `info` or `warn` — see the tile failure tally in `Tileset.ts`.

Reading them back: `stt.dump()` in the console, the lobby's *copy debug log*
button, or `firebase database:get /logs/<session>` (see `docs/DEPLOY.md`).

## Styling

Every component styles itself from the token scale in `index.html`'s `:root` —
`--space-*`, `--radius-*`, `--text-*`, `--border`, the palette, and the derived
surfaces (`--scrim`, `--field-bg`, `--inset-bg`). Reach for a token before a
number: a raw `padding: 11px` or `background: #3f3` in a component is the thing
to fix, not to match.

Where one value should drive several, derive rather than restate. The nav
chevron sets `--chev-face` and mixes its shaded back and edge from it with
`color-mix()`, so retinting the whole marker for the delivery state is one
property. Component-local tokens like that belong on the component's `:host`;
only genuinely shared scales go in `index.html`.

`index.html`'s `* { box-sizing: border-box }` does **not** cross a shadow
boundary. Any component that sets an explicit width alongside padding or a
border needs its own `*, :host { box-sizing: border-box; }`, or the box grows by
the padding and hangs off the side of a phone. Watch the tagged template too: a
backtick inside a CSS comment ends the `css` literal and the whole module fails
to parse.

Sizes come from the scale too, so the HUD survives a phone: corners offset by
`max(var(--space-lg), env(safe-area-inset-*))`, panels sized in `rem` or
`clamp()` rather than fixed pixels, and form fields at 16px so iOS does not zoom
the page when one takes focus. There are no touch controls and the game is not
playable on a phone, but nothing should overflow or hide under a notch.

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
