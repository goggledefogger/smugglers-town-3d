# Deploying

The game is a static bundle: `npm run build` writes `dist/`, Firebase
Hosting serves it. No server, no secrets in the build — the Google Maps key
is pasted by the player at runtime and lives in their `localStorage` only.

```bash
npm run deploy     # build + firebase deploy --only hosting
npm run serve      # build + hosting emulator on :5000
```

Both use the account the Firebase CLI is logged in as. This project lives on
the personal account, so add `--account dannybauman@gmail.com` if the CLI's
active login is a work account:

```bash
firebase deploy --only hosting --account dannybauman@gmail.com
```

Caching is set in `firebase.json`: hashed files under `assets/` are immutable
for a year, `index.html` is `no-cache`, so a deploy is live immediately.

## Adding a backend later

Rules files are written deny-all (or, for the database, shape-strict but
open — see below) by default; wire each service into `firebase.json` when
its feature actually lands, so a full `firebase deploy` never fails on a
service the project hasn't provisioned.

### Realtime Database

Backs the [lobby](MULTIPLAYER.md#lobby): room codes, presence, seat tokens,
and Trystero's signalling. `firebase.json` points at `database.rules.json`;

```bash
firebase deploy --only database
```

pushes the rules. Every path requires a signed-in user (Anonymous auth is
enabled on the project; `identity()` signs each browser in and refuses to
run the lobby without it). Ownership is enforced by the rules:

- `rooms/$code`: only the host may create it (`host` must be their own
  uid), change room-level fields, or delete it; the host can never change.
- `rooms/$code/players/$uid`: only that uid may write its seat, and a new
  seat is refused once `phase` is `playing`. The join writes only its own
  seat for exactly this reason; the 8-seat cap is enforced by the host at
  start, since rules cannot count children.
- `tokens/$code/$uid`: a random secret each player writes for itself,
  readable only by that player and the room's host. The host demands it in
  the WebRTC join message, which is what ties a transport peer to an
  authenticated seat.
- `signal/$room`: any signed-in user, for Trystero's handshake. Trystero
  keys its entries by its own random peer id, which Firebase cannot tie to
  `auth.uid`, so per-peer ownership is not expressible here. What that
  leaves open: a signed-in stranger who knows a room code can join the
  WebRTC mesh and watch snapshots; without a seat token they can never
  drive a car or write a room.

Shapes are validated field by field; `players` is deliberately not a
required child of the room, because a host's pre-registered `onDisconnect`
removal of its own seat is validated while the room is still standing.

### Debugging an online session

Three places to look, cheapest first:

1. **The lobby's "copy debug log" link** puts the browser's log ring (last
   500 entries, one JSON object per line) on the clipboard; `stt.dump()` in
   the console does the same. Add `?debug` to the URL for the verbose
   console.
2. **Remote logs.** Once a player is signed in, everything at `info` and up
   (including what was buffered before sign-in) is appended under
   `logs/<uid-prefix>-<time>/`. Clients can write their own entries and
   never read any; read them with the CLI:

   ```bash
   firebase database:get /logs --shallow --account <you>      # sessions
   firebase database:get /logs/<session> --account <you> | jq
   firebase database:remove /logs --account <you>             # clear
   ```

3. `npm run e2e:online` reproduces a full match with two profiles.

### Firestore (profiles, stats, saved locations)

Documents that are read far more than written. Create the database
(`gcloud firestore databases create --location=us-central1`), then add:

```json
"firestore": { "rules": "firestore.rules", "indexes": "firestore.indexes.json" }
```

### Functions

```bash
firebase init functions   # TypeScript, in functions/
```

That writes the `functions` block itself. Keep the simulation in `src/core/`
as the source of truth — it is DOM-free and already runs in node, so server
authority can import it directly rather than reimplementing rules.

### Auth

`src/services/firebase.ts`'s `identity()` already tries Anonymous auth on
every load — it calls `signInAnonymously` and uses the returned uid. Nothing
in the console has enabled the provider yet, so that call fails and
`identity()` falls back to a random id kept in `localStorage`
(`stt_client_id`), silently, no throw. The lobby works either way; enabling
Anonymous auth in the console just upgrades every browser's id to a real
Firebase uid without a code change, which is what the tightened database
rules above key off. When richer auth lands (leaderboards, saved garages),
add the emulator ports to the `emulators` block so local work never touches
production data.
