# Smugglers Town 3D: Turf Wars

Eight cars, four crates, two bases. Grab a crate and get it back to your crew's
base. Ram a carrier and it's theirs no longer. Four races run at once and each
is its own: a fresh set of four only drops when every one of them is home.
First team to five deliveries wins, or whoever leads when the five-minute clock
runs out.

It starts on a procedural desert, no setup needed. Add a Google Maps API key
and you can move the match to anywhere on Earth: real elevation, satellite
imagery, and photorealistic buildings you crash into.

## Play

Single player starts from the garage. **Play Online** opens a lobby: create a
room, share the four-letter code, and friends join from the deployed site; bots
fill the empty seats. Rooms play on the desert or anywhere on Earth — the host
picks a place while setting the room up, and can share their Maps key so
friends need nothing but the code.

```bash
npm install
npm run dev        # → http://localhost:5173
```

Pick a ride in the garage, then drive. Keyboard and gamepad are peers — both
work through the menus and in the match, and every binding is rebindable from
the garage's **Controls** screen.

| Key | Action |
|---|---|
| `W` `S` or `↑` `↓` | Accelerate, brake, reverse |
| `A` `D` or `←` `→` | Steer |
| `Space` | Jump |
| `W` `S` in the air | Pitch the nose down / up |
| `R` | Reset your car nearby |
| `C` | Camera: chase, wide, hood |
| `1`–`5` | Change vehicle mid-match |

Gamepad defaults are mapped from the original game's PS2 controller onto the
same physical positions on a Stadia pad: **A** accelerates, **X** brakes,
**B** reverses, **Y** and **RT** jump, **Select** cycles the camera, **Start**
pauses. Left stick or D-pad steers, right stick pitches in the air.

In the garage, `↑` `↓` or `1`–`5` browse the roster and `Enter` (or gamepad
**A**) starts. Typing in the search box never leaks into the game.

## The roster

| Vehicle | Mass | Accel | Top speed | Durability | Grip |
|---|---|---|---|---|---|
| Dune Buggy | 1.0 | 1.4× | 1.15× | 0.55 | 0.82 |
| Rally Car | 0.9 | 1.5× | 1.30× | 0.45 | 0.70 |
| SUV | 1.4 | 1.0× | 1.00× | 1.00 | 1.00 |
| Trophy Truck | 1.3 | 1.1× | 1.05× | 0.90 | 0.95 |
| Monster Truck | 2.0 | 0.75× | 0.85× | 1.50 | 1.20 |

Every number does something. Heavy cars win rams and shrug off damage. Light
ones accelerate and turn better. The Rally Car is the fastest thing on the
map and will slide off a corner if you ask too much of it.

The radar in the corner shades the terrain, because the direction arrow is a
bearing and nothing more — it will happily point you through a butte. Reading
the ground for a line around one is the game.

Hills are the point. Drive up one and over the lip and the car keeps the climb
it had, so a crest launches you — no button involved, and the faster and
steeper the run-up the further you go. In the air the throttle and brake keys
pitch the nose instead, which is how you land on your wheels, and rams and
contraband steals work mid-flight.

You carry one crate at a time — drive over a second while loaded and you leave
it for someone else, so committing to one race means giving up another.

Landings, walls, and rams all cost integrity. At zero you wreck: your crate
drops where you died and you respawn at your base.

## Going somewhere real

Paste a Google Maps API key in the top bar and search for a place. The key
stays in your browser's `localStorage` and never reaches the build.

The key needs five APIs enabled: **Maps JavaScript**, **Geocoding**,
**Elevation**, **Static Maps**, and **Photorealistic 3D Tiles**. Tiles are best-effort — if
they fail, you still get real terrain and imagery.

Online rooms go anywhere too: pick the place while creating the room, and the
host can share their key so friends need nothing but the four-letter code.
Checking a place costs one lookup — the city itself only loads when the match
starts, so trying a few before settling is cheap.

Downtowns work best. The tile loader streams finer geometry as you drive
toward it, and buildings become real collision, so you can wedge a Monster
Truck between two towers if you try.

## Working on it

| Script | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm test` | Test suite (258 tests, plain node) |
| `npm run test:watch` | The same, re-running as you edit |
| `npm run smoke` | Headless desert match: HUD, radar, input and layout, at four widths |
| `npm run e2e:online` | Two headless browsers play an online match against the dev server |
| `npm run typecheck` | Strict TypeScript, no emit |
| `npm run build` | Typecheck and build to `dist/` |
| `npm run serve` | Build and serve through the Firebase emulator, as hosting will |
| `npm run deploy` | Build and ship to Firebase Hosting |

```
src/
├── main.ts          wiring and the frame loop
├── app/             game loop, state, events, tuning
├── core/            simulation: physics, AI, rules, terrain, geo math
├── input/           input sources (keyboard, gamepad), rebindable bindings
├── render/          three.js views
├── services/        Google Maps and 3D Tiles
└── ui/              Lit HUD and screens
```

TypeScript, three.js, Lit, Vite, Vitest. The only runtime dependencies are
`three` and `lit`. Everything in `core/` is DOM-free and runs in node, which
is why the tests need no browser.

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the layers fit together
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what's next and why
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — hosting, and adding a backend later
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — conventions, if you're touching the code

## Where it came from

A ground-up rebuild of a 1,600-line single-file prototype into something
modular and tested. The prototype is still around as a reference.
