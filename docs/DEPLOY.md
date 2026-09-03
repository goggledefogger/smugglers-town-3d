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

Backs the [lobby](MULTIPLAYER.md#lobby): room codes, presence, and Trystero's
signalling. `firebase.json` already points at `database.rules.json`, but
that deploys only once the instance exists — create the default instance in
the console (region **us-central1**, to match Hosting), then:

```bash
firebase deploy --only database
```

pushes the rules. Version 1 does not require auth, so the rules validate
shape instead of ownership (`players` is deliberately not a required child:
a host's pre-registered `onDisconnect` removal of its own seat must pass
validation while the room is still standing): anyone can write a well-formed room or player, but a malformed
one (wrong types, an extra field, a `phase` outside `lobby`/`playing`) is
rejected. Anonymous auth is enabled on the project and `identity()` signs every
browser in, so the rules can be tightened to per-user ownership once the
join stops rewriting the whole room in one transaction:

```json
{
  "rules": {
    "rooms": {
      "$code": {
        ".read": true,
        ".write": "auth != null && (!data.exists() || data.child('host').val() === auth.uid)",
        ".validate": "$code.matches(/^[A-Z2-9]{4}$/) && newData.hasChildren(['host', 'createdAt', 'phase', 'seed', 'map'])",
        "players": {
          "$uid": {
            ".write": "auth != null && $uid === auth.uid",
            ".validate": "newData.hasChildren(['name', 'vehicle', 'team', 'ready', 'joinedAt'])"
          }
        }
      }
    },
    "signal": {
      "$room": { ".read": "auth != null", ".write": "auth != null" }
    }
  }
}
```

i.e. only the host may write room-level fields (`host === auth.uid`), only a
player may write their own `players/$uid`, and signalling requires a signed-in
peer instead of being open to anyone.

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
