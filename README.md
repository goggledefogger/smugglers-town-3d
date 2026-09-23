# Smugglers Town 3D: World Tour

A 4v4 arcade car game in the browser. Grab a crate, get it back to your team's
base, and ram anyone carrying one. First team to five deliveries wins.

It starts on a desert with no setup. Add a Google Maps API key and play
anywhere on Earth, with real terrain and buildings.

**Play:** https://st3d.roytown.net

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test
```

## Controls

| Key | Action |
|---|---|
| `W` `S` / `↑` `↓` | Accelerate, brake, reverse |
| `A` `D` / `←` `→` | Steer |
| `Space` | Jump |
| `R` | Reset car |
| `C` | Camera |
| `V` | View mode |
| `P` | Pause and controls |

Gamepads work too, and every binding can be changed from the garage.

## Real places

Paste a Google Maps API key in the top bar and search for a place. The key
needs Maps JavaScript, Geocoding, Elevation, Static Maps, and Photorealistic 3D
Tiles enabled. It stays in your browser.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Multiplayer](docs/MULTIPLAYER.md)
- [Roadmap](docs/ROADMAP.md)
- [Deploying](docs/DEPLOY.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE). Covers this code only; Google map data is under Google's terms.
