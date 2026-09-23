# Deploying

The game is a static bundle: `npm run build` writes `dist/`, Firebase
Hosting serves it. No server, no secrets in the build — the Google Maps key
is pasted by the player at runtime and lives in their `localStorage` only.

```bash
npm run deploy     # build + firebase deploy --only hosting
npm run serve      # build + hosting emulator on :5000
```

Both use the account the Firebase CLI is logged in as. This project lives on
the personal account, so add `--account <personal-account>` if the CLI's
active login is a work account:

```bash
firebase deploy --only hosting --account <personal-account>
```

The site answers at https://st3d.roytown.net, a custom domain on Firebase
Hosting; `https://smugglers-town-3d.web.app` is the same site. Link the custom
domain.

Players on different networks need a TURN relay, since a direct WebRTC link
often cannot get through two home routers. The build reads it from
`VITE_TURN_SERVERS` in `.env.local` (gitignored), a JSON `RTCIceServer[]`:

```bash
VITE_TURN_SERVERS='[{"urls":"turn:relay.example.com:443?transport=tcp","username":"…","credential":"…"}]'
```

It ships inside the public bundle, so use a relay account whose credentials
are meant for browsers. Without it, only players whose direct link works can
join each other.

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

pushes the rules. **A change to `database.rules.json` has to be deployed before
the code that depends on it**, or the writes come back `permission_denied` and
room creation fails with "could not allocate a room code" — the client retries
ten codes and every write is refused for the same reason. The room record is
shape-strict (`$other: false`), so adding one field to a room means adding its
validator here too.

Every path requires a signed-in user (Anonymous auth is
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
  `auth.uid`, so neither per-peer ownership nor a shape is expressible here.
  What that leaves open: a signed-in stranger who knows a room code can join
  the WebRTC mesh and watch snapshots, and anyone signed in can write
  arbitrary data under `signal/`. Without a seat token they can never drive a
  car or write a room, but the storage is theirs to fill. Worth a size
  validator if this is ever more than friends-with-a-code.

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

**Logs are kept until you delete them.** Each session appends up to 300
entries and nothing prunes them: the Realtime Database has no TTL, and this
repo runs no scheduled job. A day of testing leaves tens of sessions (39 after
the one that wrote this), which is nothing yet and unbounded in principle.
`firebase database:remove /logs` is the whole retention policy for now, so run
it when you are done debugging; if that gets tiresome the fix is a scheduled
Cloud Function dropping sessions older than a week, not a bigger plan.

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

`src/services/firebase.ts`'s `identity()` calls `signInAnonymously` on first
use and caches the returned uid for the session. If sign-in fails (Anonymous
auth not enabled on the project, or offline) it throws rather than inventing
an id — the database rules bind every seat to `auth.uid`, so there is no
useful identity without a real sign-in. When richer auth lands (leaderboards,
saved garages), add the emulator ports to the `emulators` block so local
work never touches production data.
