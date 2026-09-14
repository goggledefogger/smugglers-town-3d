# Road mask: where the streets come from

The collider pass needs to know where the streets are. Photogrammetry alone
cannot tell a road from a low roof, and on hills the ground estimate sags
across crests, so without an independent road layer whole blocks, streets
included, merge into one collider and every collider view mode shows walls
across open road. The HUD says `OSM: Pending` while the mask is missing.

The mask is an n×n grid of cells (10 m by default) with 1 where a road
corridor covers the cell centre (`RoadGrid` in `services/osm/roads.ts`). Road
cells are exempt from building classification, their driving height is pinned
to the true surface, and the Best 3D snap uses the same mask to keep parked
cars off walls. The pipeline does not care how the grid was made.

## Sources

### 1. Google Static Maps styled roadmap (current primary)

`MapsApi.roadsUrl` asks Static Maps for a roadmap with every feature hidden
except road fills, drawn white on black with per-class stroke weights
(highway 6 px, arterial 4 px, local 3 px; about 23 / 15 / 11 m at zoom 15
downtown). `fetchRoadRaster` stitches the same 3×3 grid of 640 px tiles the
satellite ground uses and thresholds it to a 1-bit raster;
`rasterizeRoadRaster` samples that raster at each cell centre with a small
dilation (`roadReachSlackMultiplier` cells).

- Same API key, same tile pipeline and browser cache as the imagery, Google
  uptime. No new dependency.
- Road widths are cartographic, not surveyed. Fine for carving corridors;
  not a source of lane counts or one-way direction.
- Costs Static Maps requests like the satellite fetch does (9 per relocate).
- Knobs: the style weights in `roadsUrl`, the slack in
  `DEFAULT_COLLIDER_THRESHOLDS`.

### 2. OpenStreetMap ways via Overpass (fallback)

`fetchRoadPolylines` queries the Overpass API for drivable `highway` ways in
the field's bounding box, filters out footways and stairs (`isDrivableWay`),
assigns widths from `width`/`lanes`/class tags, and `rasterizeRoads` stamps the
polylines with `halfWidth + slack × cell` reach. Successful results are cached
per place in the tile cache; failures retry with backoff up to two minutes.

- Real OSM attributes: tagged widths, lane counts, road class, one-way.
- Overpass is a free, community-run query service that runs every query on
  demand. The public mirrors go down for hours at a time, sometimes all of
  them at once (2026-09-13 to 14 both default mirrors were out for a whole
  evening). Five mirrors run by different operators are listed in
  `OVERPASS_ENDPOINTS`; more exist, see the OSM wiki page "Overpass API".
- Rate limits and a required User-Agent on some mirrors.

Used only when the Google raster fails (no key, canvas unavailable, Static
Maps error).

### 3. OSM vector tiles from a CDN (not implemented)

OpenFreeMap, Protomaps and MapTiler serve OSM as Mapbox Vector Tiles
(PMTiles or z/x/y) from CDNs, free or with generous free tiers, with the
`transportation` layer carrying road class, one-way and surface tags.

- Reliable like option 1, with real attributes like option 2.
- Needs a vector tile decoder (`@mapbox/vector-tile` + `pbf`, small) and a
  z14 tile fetch for the field (about 3×3 tiles), then the same
  `rasterizeRoads` stamping from the decoded line geometry.
- The place to go when the game wants lane counts or one-way direction.

### 4. A shared server-side cache (not implemented)

A small Firebase function that fetches a place once (from any source above)
and stores the result in Firestore or Storage, so every player shares one
fetch per place and a client never talks to Overpass directly.

- Removes per-client fetch cost and rate-limit exposure; makes the mask
  deterministic across players in a multiplayer match.
- Worth it once the game has enough players that per-client fetches cost
  money or diverge between clients.

## Switching or adding a source

`TileStreamer.loadRoads` tries the sources in order and keeps the first
`RoadGrid`. A new source needs a fetch that returns either polylines (then
`rasterizeRoads`) or a raster (then `rasterizeRoadRaster`), and a re-rasterize
branch in `setExperimentMode` for when the grid cell size changes. Everything
downstream reads `roadGrid.mask` only.

To compare sources on the same spot, `scripts/best3d-boxes-probe.mjs` reports
how many structure cells sit on road cells, and `scripts/best3d-shots.mjs`
shoots the collider view modes.
