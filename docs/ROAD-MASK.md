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
downtown). `fetchRoadRasters` stitches two 3×3 grids of 640 px tiles like the
satellite ground does: zoom 15 for the whole 5.6 km field, and zoom 16 for
the inner 3.6 km, because Google only draws alleys and service roads at 16
and closer. Each is thresholded to a 1-bit raster; `rasterizeRoadRaster`
samples the rasters at each cell centre with a small dilation
(`roadReachSlackMultiplier` cells), and a cell is road if either layer says so.

- Same API key, same tile pipeline and browser cache as the imagery, Google
  uptime. No new dependency.
- Road widths are cartographic, not surveyed. Fine for carving corridors;
  not a source of lane counts or one-way direction.
- Costs Static Maps requests like the satellite fetch does (18 per relocate,
  browser-cached).
- Knobs: the style weights in `roadsUrl`, the slack in
  `DEFAULT_COLLIDER_THRESHOLDS`.

### 2. OpenStreetMap ways via Overpass (second layer)

`fetchRoadPolylines` queries the Overpass API for drivable `highway` ways in
the field's bounding box, filters out footways and stairs (`isDrivableWay`),
assigns widths from `width`/`lanes`/class tags, and `rasterizeRoads` stamps the
polylines with `halfWidth + slack × cell` reach. Successful results are cached
per place in the tile cache; failures retry with backoff up to two minutes.

- Real OSM attributes: tagged widths, lane counts, road class, one-way.
- Overpass is a free, community-run query service that runs every query on
  demand. The public mirrors go down for hours at a time, sometimes all of
  them at once (2026-09-13 to 14 both default mirrors were out for a whole
  evening). Four mirrors run by different operators are listed in
  `OVERPASS_ENDPOINTS`; more exist, see the OSM wiki page "Overpass API".
  Beware regional mirrors (overpass.osm.ch covers Switzerland only and answers
  any other bbox with zero ways, which reads as "no roads here").
- Rate limits and a required User-Agent on some mirrors.

Layered on top of the Google raster whenever it answers: the mask is the
union of both, because Google omits some alleys and pedestrian passages that
OSM maps (Financial District alleys, for one). If the Google raster fails
(no key, canvas unavailable, Static Maps error), OSM is the only layer.

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

## Building footprints (the other mask)

The same trick, the other way round. On hills the ground estimate sags and
the driveable-terrain flood swallows all but the tallest core of a building,
so a whole block came out as one lone 4 m column; and even on the flat, the
road corridor (kerb width plus half a cell of slack on a 10 m grid) eats the
first cell of every block. `MapsApi.buildingsUrl` asks Static Maps for a
roadmap with building strokes white, road fills green and everything else
black. Google only draws building outlines from zoom 17, and the fill inside
them is the same man-made landscape as the ground between them, so the
outline is the only signal: `footprintsFromOutlines` flood-fills from every
road pixel (and the canvas edge) and whatever it cannot reach is inside a
closed outline. `fetchBuildingRaster` stitches a 6×6 grid of zoom 17 tiles
(the inner 3.6 km, 36 requests, browser-cached).

`rasterizeCoverage` turns it into a cell mask with a twist: a cell counts as
building only when 70 % of its area is inside an outline (`BUILDING_COVER`
in `Tileset.ts`). In the collider pass a footprint cell is a building
whatever the ground estimate says, and it outranks the road corridor; the
70 % rule is what keeps that safe, since a 10 m cell whose centre is a
metre inside the building line but whose area is mostly street stays
street, so a 12 m street between two exact outlines always keeps a free
cell. Measured downtown San Francisco: boxes 1,226 → 1,429, reachable road
cells 107,354 → 105,638 (centre-sampled instead of 70 %-covered, the same
override cut the network to 60 cells).

- Fails soft: no raster, no mask, the classifier judges alone as before.
- Outlines the antialiasing leaves a gap in flood and are missed, and a
  building under the logo or attribution corner loses its outline there.
- Bridges and ramps are classified before the footprint, so a deck over a
  road stays a deck; a building drawn over a tunnel becomes solid, which is
  what the photogrammetry shows anyway.

## Switching or adding a source

`TileStreamer.loadRoads` fetches the sources in order and
`publishRoadGrid` unions whatever has landed into one `RoadGrid`, announcing
it to the collider pass each time a layer arrives. A new source needs a fetch
that returns either polylines (then `rasterizeRoads`) or a raster (then
`rasterizeRoadRaster`) and a line in `publishRoadGrid`. Everything downstream
reads `roadGrid.mask` only.

To compare sources on the same spot, `scripts/best3d-boxes-probe.mjs` reports
how many structure cells sit on road cells, and `scripts/best3d-shots.mjs`
shoots the collider view modes.
