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
| `V` | Cycle view mode (starts in Cutout 3D) |
| `P` | Pause and controls |

Gamepads work too, and every binding can be changed from the garage.

## Real places

Paste a Google Maps API key in the top bar and search for a place. The key
needs Maps JavaScript, Geocoding, Elevation, Static Maps, and Photorealistic 3D
Tiles enabled. It stays in your browser.

Real places draw in Cutout 3D: Google's photogrammetry kept only inside
building footprints, over satellite ground, with the car hitting walls traced
from the same footprints. `V` cycles the other view modes, and `?view=<mode>`
starts in one (`photoreal`, `masked-tiles`, `best-3d`, `painted-3d`,
`painted-metro`, `footprint-3d`, `vector-city`, `game3d`). Why Cutout 3D is the
default: [Architecture, View modes](docs/ARCHITECTURE.md#view-modes-cutout-3d-is-the-default).

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Multiplayer](docs/MULTIPLAYER.md)
- [Roadmap](docs/ROADMAP.md)
- [Deploying](docs/DEPLOY.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE). Covers this code only; Google map data is under Google's terms.
