# Roadmap

What would bring this closer to Smugglers Run, ordered by payoff against
risk. Items marked **(play-test)** change how the game feels and should be
tuned with a controller in hand, not shipped blind.

## 1. World scale 1:1 **(play-test)** — the biggest correctness gap

Today 1 real meter = 0.15 world units (`WORLD_M_PER_M`), chosen so a 5.5 km
terrain fits the 840-unit field while keeping the prototype's physics
numbers. Cars are 4 units long, which makes them 27 m long in the real city:
6.7× life size. The km/h gauge, the delivery radius (147 m real), spawn
clearances and the relief boost all inherit that mismatch, and downtown
reads as a model village from the driver's seat.

Recipe (all units become meters; the physics numbers already read sensibly
as m/s — 78 m/s top speed is 280 km/h, gravity 22 stays arcade-floaty):

- `WORLD_M_PER_M = 1`, `config.world.mapHalf = 2800`.
- Procedural desert: heights are absolute (`h * 16`, butte 40, canyon 14) and
  the noise lattice is normalized, so multiply heights by ~6.7 or regenerate
  in meters.
- Renderer: camera far plane 2000 → 8000, fog 200/700 → 1500/5000.
- Colliders: `CELL` 1.5 → 10 (cells were already 10 m), thresholds unchanged.
- Spawns: open-spot search ±210/30 → ±1000/60; ring radii ×3; base offset
  `0.65 · mapHalf` → ~0.45 or matches last too long.
- Relief boost: 2.2× tall buildings next to life-size cars will look wrong;
  cap at ~1.3 or drop it and add jump ramps as props instead.
- Props: counts ×5, rock sizes in meters.
- Tests: the 840-unit heightfields in `tests/physics.test.ts` and
  `tests/gameplay.test.ts` become 5600.

Expected feel: everything is larger and slower relative to the car; a
cross-field run takes ~70 s at top speed instead of ~11 s. That is closer to
the original, but it changes pacing enough to warrant a round timer (item 2).

## 2. Round structure

- Timed rounds (e.g. 5 min) with the score at the buzzer, in place of or on
  top of win-at-5; countdown in the HUD, "FINAL MINUTE" banner, sudden death
  on a tie.
- A 3-2-1 start countdown instead of dropping into a running sim.
- Match summary on the end screen: deliveries and steals per driver.

## 3. Bots

- Pathing: bots drive straight at their target and rely on the stuck-recovery
  reverse to get off walls. The building collider grid already exists; A* (or
  a flow field toward the contraband/base) over its 10 m cells would let them
  navigate a downtown.
- Roles: when an ally carries, escorts should body-block chasers rather than
  drive to the base and wait.
- Difficulty setting: reaction time (`reevaluateS`), top-speed cap, steal
  aggression.

## 4. Graphics

- Real shadows: a directional shadow map on a ~200-unit frustum that follows
  the player; vehicles cast, terrain and tiles receive. Biggest single visual
  upgrade for grounding the cars.
- Satellite drape: zoom 16 in a 5×5 grid (25 Static Maps calls) for
  1.7 m/px, or hide the drape where fine tiles cover the ground.
- Streaming: evict the farthest tiles when over `MAX_TILES` so long sessions
  keep refining; coarsen behind the player.
- Impact feedback: camera shake on rams and landings, sparks/smoke as
  integrity drops, skid marks.
- Sky dome with a sun and time of day; fog color tied to it.
- Vehicle silhouettes: the roster differs only by wheel size and accent
  color; a few boxes per type (buggy cage, truck bed, monster lift) would
  make types readable at a glance.

## 5. Input and platforms

- Gamepad via the Gamepad API (analog steer/throttle, triggers) merged into
  `KeyboardState.toVehicleInput`.
- Touch controls and a responsive HUD for phones/tablets.
- Rebindable keys.

## 6. Audio

Engine pitch from speed, ram and landing impacts, pickup/steal/deliver
stingers, a proximity cue near your base. Web Audio with procedural sounds
first, no assets needed.

## 7. Multiplayer

The fixed-step, DOM-free core is the right shape for lockstep over WebRTC
data channels with input delay. Prerequisites: a seeded RNG injected into
core (`Math.random` is used by AI, spawns, and the landing tumble), and no
per-client state in `core/`.

## 8. Tooling and code quality

- ESLint with typescript-eslint; `npm run lint`.
- CI: typecheck, tests, build, and a no-key Playwright smoke run on the
  desert (the scripts in this session's notes are a starting point).
- Injectable RNG in core (see 7), which also makes gameplay tests
  deterministic.
- Remove the `carScale` parameter threaded through core; it is always 1.
- A per-frame HUD channel like the direction arrow's for speed and integrity,
  so they don't tick at 10 Hz.

## 9. Relocation polish

- Remember the last place and offer a few presets (Portland, SF, Tokyo).
- Progress with tile counts and byte totals; a clear message when the key is
  missing one of the four APIs.
- If a place has too little tile data near the center for the measured datum
  shift, fall back to an EGM96 geoid lookup.
