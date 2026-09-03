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

## 1b. Menus

The garage (vehicle pick) exists, and the online lobby now sets the location
(desert or any place on Earth, with presets and a cheap check). Left: the rest
of game setup (round length, team size, bot difficulty) including for single
player, a pause menu, and options (key bindings, audio). Mid-match `1`–`5` vehicle switching should go
once setup exists; it is a debug leftover.

## 2. Round structure — mostly done

Done: 5-minute clock, 3-2-1 countdown, final-minute warning, sudden death on
a tie. Left:

- Match summary on the end screen: deliveries and steals per driver.

## 3. Bots — pathing done

Done: BFS flow fields over a 20 m occupancy grid built from the colliders;
bots follow waypoints around buildings and props. Left:

- Roles: when an ally carries, escorts should body-block chasers rather than
  drive to the base and wait.
- Difficulty setting: reaction time (`reevaluateS`), top-speed cap, steal
  aggression.
- Field quality: the 20 m grid treats any cell touching a collider as
  blocked, so streets narrower than ~20 m close; a finer grid or a
  clearance-aware BFS would open them.

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
- Time of day: the painted sky (`skyTexture.ts`) takes a sun direction, so
  a dusk/night palette and a moving sun are a repaint plus light tweaks.
- Performance headroom: move tile rasterization and collider rebuilds to a
  Web Worker (they hitch 15–30 ms during streaming); add a quality preset
  (tile caps, streaming LOD, MSAA off) on top of the adaptive resolution for
  very weak GPUs.

## 5. Input and platforms

- Gamepad via the Gamepad API (analog steer/throttle, triggers) merged into
  `KeyboardState.toVehicleInput`.
- Touch controls. The HUD is responsive already — safe-area insets, a radar
  and corners that scale, no overflow down to 390 px — but there is no way to
  steer without a keyboard, so a phone can watch and not play.
- Rebindable keys.

## 6. Audio

Engine pitch from speed, ram and landing impacts, pickup/steal/deliver
stingers, a proximity cue near your base. Web Audio with procedural sounds
first, no assets needed.

## 7. Multiplayer — spec written

Version 1 is live: host-authoritative over WebRTC (Trystero), Firebase for
lobby, signalling and anonymous auth, bots in empty seats, and rooms that play
anywhere on Earth. Left: client prediction, host migration, quick-match, and a
decision on TURN. The remaining internal prerequisites (a `Simulation` split
out of `Game`, an input-source interface, body snapshots) are listed in
`docs/MULTIPLAYER.md` with the phase plan.

## 8. Tooling and code quality

- ESLint with typescript-eslint; `npm run lint`.
- CI: typecheck, tests, build, and a no-key Playwright smoke run on the
  desert (the scripts in this session's notes are a starting point).
- A per-frame HUD channel like the direction arrow's for speed and integrity,
  so they don't tick at 10 Hz.

## 9. Relocation polish

- Bridge decks and overpasses: the shared ground is one layer, so a deck is
  scenery and the car drives under it. Needs a second drivable layer or
  deck colliders that act as platforms.
- The ground refresh while streaming costs ~50 ms every 6 s (opening filter
  plus a 313k-vertex drape update). Move it to a worker or refresh only the
  cells that changed.
- Bicubic sampling for the 10 m tile ground if it feels like gravel at
  speed; the four-wheel mean and suspension hide most of it.

- Remember the last place and offer a few presets (Portland, SF, Tokyo).
- Progress with tile counts and byte totals; a clear message when the key is
  missing one of the four APIs.
- If a place has too little tile data near the center for the measured datum
  shift, fall back to an EGM96 geoid lookup.
