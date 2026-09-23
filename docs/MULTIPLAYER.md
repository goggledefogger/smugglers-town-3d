# Internet multiplayer

Status: **version 1 is implemented and live** — lobby with room codes,
WebRTC host-authoritative play, bots in the empty seats, real-world locations,
two-browser e2e in `scripts/online-e2e.mjs`. Not yet: client prediction, host
migration, quick-match.

## Goal

Friends play a 4v4 round over the internet from the deployed site. Bots fill
the empty seats. Nobody makes an account, and nothing costs money while
nobody is playing.

## What we looked at

| Option | Model | Needs a server? | Cost | Verdict |
|---|---|---|---|---|
| [Trystero](https://github.com/dmotz/trystero) (MIT) | WebRTC peer-to-peer; peers find each other through Firebase Realtime Database | No | RTDB free tier | **Pick.** One dependency, zero hosting, and the Firebase piece is the same one the lobby needs anyway |
| [Colyseus](https://docs.colyseus.io/) (MIT) | Authoritative Node rooms, built-in matchmaking, binary delta state sync | Yes, always-on Node with WebSockets. Not Firebase Functions (no WebSockets); Cloud Run with a minimum instance or a small VM | ~$15/mo hosted, or a VM | The upgrade if fairness or cheating ever matters. Same sim code runs on it |
| [NetplayJS](https://github.com/rameshvarun/netplayjs) (ISC) | Rollback or lockstep, peer-to-peer | Signalling only (public instance or your own) | Free | Rollback wants a rewindable serialised state; eight physics cars rewinding is heavy, and parts are marked WIP |
| [PlayroomKit](https://docs.joinplayroom.com/) | Hosted shared state | Vendor | Free tier, closed source | Not open source, so no |
| Firebase RTDB as the transport | Write inputs and state into the database | No | Free | Fine for a lobby. Round trips of 100 ms and up make it wrong for a 60 Hz driving sim |
| Socket.IO / PartyKit | Roll your own rooms over WebSockets | Yes | Same as Colyseus | Colyseus is this with rooms and matchmaking already written |

The [2026 consensus](https://app.cinevva.com/guides/multiplayer-browser-game)
is "WebSockets to an authoritative server, WebRTC only when you need
peer-to-peer." We need peer-to-peer because we do not want a server bill for
a game friends play a few evenings a month. The escape hatch below keeps the
door to Colyseus open.

## Decision

**Host-authoritative over WebRTC, Firebase for lobby, signalling, and auth.**

- One player is the host. Their browser runs the simulation at 60 Hz exactly
  as the single-player game does today, bots included.
- Everyone else sends inputs and receives state. They render, they do not
  simulate.
- Firebase Realtime Database holds the room list and the WebRTC handshake.
  Anonymous Auth gives every browser an id the security rules can name.
- `Transport` is an interface with one implementation (Trystero). Swapping in
  a Colyseus room later touches `src/net/`, nothing in `core/`.

Cheating is a non-goal: a host can only cheat their own friends.

## Wire protocol

Three message kinds, all defined in `src/net/protocol.ts`:

**Input** (client to host, 30 Hz, unreliable, latest wins). Throttle, brake,
steer, jump, pitch, handbrake, plus a sequence number so the host ignores
stale packets.

**Snapshot** (host to all, 20 Hz, unreliable). Per body: position, orientation,
velocity, damage, on-ground. Position y is height above the host's ground,
not world y; see "Every player's own ground" below. Per match: phase, clock, scores, and every crate
(id, position, carrier, delivered). Measured: eight bodies and four crates is
~1090 bytes as JSON, so ~21 KB/s per
client at 20 Hz and ~150 KB/s upstream from a host with seven guests, sent
once per peer connection since WebRTC has no relay to fan it out.
Fine for a friends match on broadband; binary packets are the version 2
item if a host's uplink turns out to be the bottleneck.

**Event** (host to all, reliable). Pickup, delivery, steal, wreck, respawn,
countdown tick, round over. These drive the HUD and audio once each, and must
not be inferred from snapshots.

Clients render each remote body by interpolating between the two most recent
snapshots, about 100 ms behind the host. Version 1 does no prediction, so the
local car feels 100 to 150 ms behind the keys. Version 2 predicts the local
car and reconciles it against the host's snapshot; the sim is already
deterministic per seed, which is what makes that cheap.

## Lobby

```
rooms/{code}
  host:      uid
  createdAt: serverTimestamp
  phase:     'lobby' | 'playing'
  seed:      number
  map:       { kind: 'desert' }
           | { kind: 'city', query, label, lat, lon }
  keyShared: boolean
  players/{uid}: { name, vehicle, team, ready, joinedAt }
signal/{code}/...   Trystero's namespace; peers only
```

- A city map stores the **geocoded centre**, not just the search text. Every
  player builds its world from those coordinates, so nobody re-geocodes and two
  players can never land on different Portlands. `decodeMatchMap` in
  `protocol.ts` is the single validator for both the room record and the wire.
- `keyShared` says the host will hand its Maps key to players at start. It
  lives in the room because a joiner has to know *before readying up* whether
  it needs a key of its own; the hello arrives far too late for that.
- Room codes are four letters from an alphabet without look-alikes. Join by
  code is the whole matchmaking story for version 1. Quick-match later is
  "list rooms in `lobby` with an open seat."
- Presence: each player registers `onDisconnect().remove()` on their own
  node. The host registers one on the room, so a vanished host takes the
  room with it.
- Seats: four per team, bots in the rest. The host assigns vehicles and
  teams; the seed is chosen when the host presses Start and shipped in the
  first snapshot, so everyone spawns the same layout.

Security rules (all under `auth != null`; the deployed set is described in
`docs/DEPLOY.md`):

- `rooms/{code}` create and room-level writes: only `host == auth.uid`.
- `rooms/{code}/players/{uid}`: only that uid, and no new seat after start.
- `tokens/{code}/{uid}`: the seat's secret; owner writes, owner and host read.
- `signal/{code}`: any signed-in user, for the WebRTC handshake.
- Everything else denied. Stale rooms are not cleaned up yet; a scheduled
  Cloud Function to delete rooms older than two hours would be the first
  backend code, and can wait for version 2.

## Host leaves

Version 1: the room ends and everyone returns to the lobby with a message.
Version 2: the remaining client with the lowest uid becomes host from the
last snapshot it received.

## Code layout

```
src/net/
  Transport.ts          send / receive / peers; one interface
  TrysteroTransport.ts  the only implementation for now
  LoopbackTransport.ts  in-memory hub for tests, not used in production
  protocol.ts           Input, Snapshot, Event types and codecs
  HostSession.ts        owns the Game, applies remote inputs, broadcasts
  ClientSession.ts      sends inputs, buffers snapshots, drives the views
  lobby.ts              room create / join / presence in RTDB
  OnlineFlow.ts         composition root: lobby screen -> room -> peer -> match
src/services/firebase.ts  app init and anonymous sign-in
```

`core/` never imports from `net/`. The sim does not know what a peer is.

## Choosing where you play

The host picks a map while setting the room up. Two costs are deliberately
kept apart:

- **Checking a place** is one geocode plus one Static Maps thumbnail, and
  nothing else. Picking a location is browsing — you may try five cities
  before settling — so `previewPlace()` stops there and shows the resolved
  address and coordinates for confirmation.
- **Loading the world** is the elevation grid, a nine-image satellite stitch
  and ~85 building tiles. `relocateTo()` pays that once, at match start, for
  the place the room actually settled on, with the loader overlay reporting
  progress to every player at the same time.

Every browser in the match needs a Maps key, because the terrain, imagery and
tiles are fetched per client — the host cannot relay Google's tree. So the
host chooses:

- **Share my key with this room** (default): the key rides the hello message,
  sent per-peer only to seats that already proved their token, never
  broadcast. Friends join with just the code. Anyone in the room can spend the
  host's Maps quota, so a leaked code leaks quota.
- **Off**: `keyShared` is false, and a joiner without a key of its own is
  shown a key field and cannot ready up until it has one — better than
  discovering the problem at the countdown.

## Every player's own ground

Each browser streams its own city, and since the 3D tiles started shaping the
ground (bridge decks 2026-09-04, ground refined from tiles 2026-09-05) no two
players have quite the same ground: tile detail follows each player's own car,
the quality setting changes it, each side calibrates the tile datum from the
tiles it happened to load, and the OSM road data that flattens road cells can
fail on one side. Absolute heights from the host then float or sink cars on
every screen but the host's, worst for a guest's own car, which the host
simulates on its coarse far-away tiles.

So since protocol 4 the host sends height above its driving surface
(`pos.y - groundY`, and crates above its heightfield), and a guest adds its own
surface back (`ClientSession.groundAt`: heightfield, then bridge decks). Same
bytes on the wire, one lookup per car per frame, and the host stays
authoritative for everything else. What it does not cover: walls and
colliders still differ a little per player, so a car can touch a wall a hair
early or late on a guest's screen.

Alternatives, kept for if this is not enough:

- **Same world for everyone.** Build the ground only from inputs every player
  shares (the Google elevation grid), as city matches did before 2026-09-05,
  and keep tile-derived ground and decks cosmetic in online play. Exact
  agreement, at the cost of cars not riding bridges or tile-refined ground
  online.
- **Host sends the ground.** Ship the host's refined heightfield (560² cells,
  a few hundred KB compressed) or per-body ground heights once. Guests match
  the host exactly; costs a large one-off transfer and a slower start, and the
  host's far tiles are coarse anyway.
- **Pin the quality setting per room.** The host's resolution profile rides
  the hello and every player uses it. Removes one source of difference, not
  the streaming one.
- **Guest-side prediction of its own car** (the version 2 item above) would
  also run the guest's car on the guest's own ground, removing the worst case,
  but it is the biggest change of the four.

## Prerequisites

- [x] Seeded RNG through `VehicleBody`, `DriverBrain`, `SpawnPlanner`, and
      vehicle collisions
- [x] `SpawnPlanner` deterministic from seed plus occupancy, same path for
      humans and bots
- [x] Fixed 60 Hz step with pose interpolation, so render rate never leaks
      into the sim
- [ ] Split `Game` into a `Simulation` (bodies, brains, rules, step) and the
      app glue (views, camera, events). The host runs a sim without a
      renderer; a client runs views without a sim
- [x] A per-driver input source interface, so keyboard, bot, and remote
      packet are interchangeable — `InputSource` in `src/input/types.ts`,
      with `KeyboardSource` and `GamepadSource` live; a remote packet is a
      third `InputSource` to add
- [ ] `serialize()` / `apply()` on `VehicleBody` and match state, which is the
      snapshot
- [x] The ground is cut from the tiles, and each client streams tiles at
      its own LOD, so the host's heightfield is the physics ground and a
      client's own is only for its shadows and camera. Clients still extract
      colliders; only the host's are consulted by the sim

## Starting together

A city is tens of seconds of streaming, and every player fetches their own, so
the start is a barrier rather than a moment:

1. The host loads its world and sends the hello, which is what tells each
   client the seed and roster.
2. Each client builds its world and replies with a `ReadyMsg`. It does not
   wait for the hello to *begin* — the room record already names the place and
   the seed, so a client with a key starts loading as soon as the phase flips,
   and the two loads overlap instead of running back to back.
3. The host waits for every connected player, then starts the clock. After
   20 s it starts anyway and the straggler joins when it finishes; a player who
   *drops* while loading stops being waited for immediately, because the
   timeout is for the stuck, not the gone.
4. A loaded client waits for the host's first snapshot before it enters, so it
   never sits in an empty world while somebody else finishes.

## Phases

1. Firebase init, anonymous auth, and a lobby screen: create a room, join by
   code, see who is in it. No game yet.
2. Transport and protocol. The host runs the match; one remote client drives
   with interpolation. Tested with two browser windows on one machine.
3. Events over the wire, HUD, wreck and respawn, bots filling seats, ready-up
   and a synchronised countdown.
4. Client prediction for the local car, binary packets, quick-match, host
   migration, and a decision on TURN.

## What version 1 does not do yet

- **Every browser needs a Maps key for a city**, because terrain, imagery and
  tiles are fetched per client and the host cannot relay Google's tree. The
  host can share theirs; see *Choosing where you play*.
- **No prediction.** The local car feels ~100–150 ms behind the keys.
- **Host leaves = match over.** No migration.
- **Rematch reloads the page** back to the garage.
- **Seats bind to Firebase identity, not to a verified WebRTC peer.** A
  per-seat token that only the owner and host can read is required in the
  join message, and a seat binds once; see `docs/DEPLOY.md` for the rules.
- **STUN only.** Peers behind symmetric NATs on both ends will not connect.

## Questions for Danny

- **TURN.** Roughly one connection in ten sits behind a NAT that WebRTC
  cannot cross with free STUN alone. Accept that for version 1, or budget a
  metered TURN service later?
- **Codes or public matchmaking** for version 1? Codes is the
  recommendation.
- Should a browser tab be able to host a bot-only match nobody is driving in,
  as a stand-in dedicated server?
