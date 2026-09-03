# Internet multiplayer

Status: **version 1 is implemented and live** — lobby with room codes,
WebRTC host-authoritative play, bots in the empty seats, two-browser e2e in
`scripts/online-e2e.mjs`. Not yet: client prediction, host migration, city
maps online, quick-match.

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
steer, jump, pitch, plus a sequence number so the host ignores stale packets.

**Snapshot** (host to all, 20 Hz, unreliable). Per body: position, orientation,
velocity, damage, on-ground. Per match: phase, clock, scores, carrier, crate
position. Measured: eight bodies is ~790 bytes as JSON, so ~16 KB/s per
client at 20 Hz and ~110 KB/s upstream from a host with seven guests.
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
  map:       { kind: 'desert' | 'city', lat, lng, seed }
  players/{uid}: { name, vehicle, team, ready, joinedAt }
signal/{code}/...   Trystero's namespace; peers only
```

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
- Everything else denied. A scheduled Cloud Function deletes rooms older
  than two hours; it is the first backend code and can wait for version 2.

## Host leaves

Version 1: the room ends and everyone returns to the lobby with a message.
Version 2: the remaining client with the lowest uid becomes host from the
last snapshot it received.

## Code layout

```
src/net/
  Transport.ts          send / receive / peers; one interface
  TrysteroTransport.ts  the only implementation for now
  protocol.ts           Input, Snapshot, Event types and codecs
  HostSession.ts        owns the Game, applies remote inputs, broadcasts
  ClientSession.ts      sends inputs, buffers snapshots, drives the views
  lobby.ts              room create / join / presence in RTDB
src/services/firebase.ts  app init and anonymous sign-in
```

`core/` never imports from `net/`. The sim does not know what a peer is.

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
- [ ] A per-driver input source interface, so keyboard, bot, and remote
      packet are interchangeable
- [ ] `serialize()` / `apply()` on `VehicleBody` and match state, which is the
      snapshot
- [ ] The ground is cut from the tiles, and each client streams tiles at
      its own LOD, so the host's heightfield is the physics ground and a
      client's own is only for its shadows and camera. Decide whether
      clients skip collider extraction entirely

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

- **Desert only.** A city needs every player's own Maps key and identical
  tiles; the seed cannot reproduce Google's tree.
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
