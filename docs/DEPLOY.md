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

`firebase.json` deliberately configures **hosting only**, so a full
`firebase deploy` can't fail on a service the project hasn't provisioned.
Rules files are already written with deny-all defaults; wire each one up when
its feature actually lands.

### Realtime Database (the likely fit for live match state)

Positions at 10–20 Hz, lobbies, and score sync suit RTDB's latency better
than Firestore. Create the instance, then add to `firebase.json`:

```json
"database": { "rules": "database.rules.json" }
```

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

Not needed yet: nothing is saved per-player and no key is held server-side.
When it lands (leaderboards, saved garages, multiplayer identity), enable the
provider in the console, then tighten the rules files from deny-all to
per-user scopes. Add the emulator ports to the `emulators` block so local
work never touches production data.
