# Cutout 3D: per-texel heights from the loaded tiles (option 2)

Status: design, 2026-10-08. Stage 1 (capture and field) is built, measured, not consumed. Stage 2 is sections 4 and 4b, and 4b ships first. Baseline: `npx vitest run tests/cutout.test.ts` passes, 49/49.

## 0. Measured since stage 1

- Field vs downward raycasts: within 1 m at 7 points. Per 900² chunk: render 1.8 ms, readback copy 11 ms.
- Overture polygon 4412 (Portland, 45.5188, -122.6780; 34×25 m, 45 m) rises 44.5-45 m everywhere, including the cell the classifier called empty: the oversized-lot case was a classifier error. The drop rule stays, but is not the first win.
- 2 in 3 known texels are kept (284,119 of 425,764), much of it street-tree canopy.
- The owner found the inverse failure: a mesh wider than its polygon is walled at the polygon edge and cut away outside it, because a 10 m cell within 3 m of a polygon texel counts as covered. Section 4b fixes it, first.

## 1. Where the tiles live, and how to render them top-down (built)

- `TileStreamer` (`src/services/tiles/Tileset.ts:362`) holds one LOD per area and changes its set only inside async `add`/`remove`/`refine` callbacks, so a synchronous render from the frame loop sees that frame's geometry: no LOD pinning needed. Tiles coarser than `RASTER_MAX_ERROR_M = 8` are hidden for the capture and read unknown. The streamer exposes `forEachTile` and a `dirtyRect`.
- `TopDownCapture` (factored out of `SurfaceCapture`, shared with the wheels) renders straight down with an `overrideMaterial` writing world Y into R32F and reads back asynchronously. The override bypasses the cutout discard, so a dropped footprint is still measured and can come back. `HeightCapture` (`src/render/HeightCapture.ts`) adds chunking and coarse-tile hiding.

## 2. The height field

- **Resolution 1 m.** It matches the stencil texel (`CUTOUT_TEXEL_M`, `src/main.ts:675`), so the fill can read it 1:1.
- **Extent.** The 3600 m stencil square, split into a fixed 4×4 lattice of 900 m chunks starting at x, z = -1800. Only chunks that hold fine tiles get captured. With `STREAM_LOD` (`Tileset.ts:76`), fine tiles sit within about 500 m of the player, so that is 1-4 chunks.
- **Format on the GPU.** R32F world Y. This is the proven readable path.
- **Format in the worker.** One persistent `Uint8Array(3600²)` (`heightField.ts`): stage 1 has bits 0-6 rise in 0.5 m steps (127 unknown) and bit 7 kept; stage 2 rearranges it to carry a rough bit (4b, Trees).
- **Baseline.** Subtracted on the CPU, in the worker, by bilinear sampling of the 10 m tileset terrain (`cutoutTerrain`, `main.ts:699`, the same source `roofInput` uses at `:877`). It is sent once per tileset.
- **Memory added.**
  - GPU: 6.5 MB, the 900² R32F colour target plus its depth.
  - Worker: 13 MB, persistent.
  - Main thread: 3.24 MB per chunk in flight, transferred to the worker rather than copied.

## 3. Readback and threading (built)

- `readRenderTargetPixelsAsync` (PBO plus fence), no stall. Measured per chunk in section 0.
- Never per frame: a chunk under `dirtyRect` is captured once no tile in it changed for 1 s, at most one chunk per frame with one readback in flight, only while the view cuts to footprints.
- The `Float32Array` is transferred to the cutout worker as `{kind:'heights', chunk, data}`; the worker folds it into the field and replies with `keepChanged`, and only then does main request a rebuild, so the stencil keeps its 2 s coalesced cadence. The digest gains a `heightVersion` counter, not 13 MB of bytes.

## 4. How footprintMask.ts consumes it

- **New pure helpers.**
  - `applyHeightChunk(field, chunk, worldY, terrain)`: quantise, then apply the hysteresis.
  - `riseAt(field, i, j)`.
- **Rise threshold and hysteresis.**
  - A texel becomes kept at a rise of 3.0 m or more (`CUTOUT_MIN_RISE_M`, `main.ts:701`, times `reliefBoost`).
  - A kept texel stays kept until its rise falls below 1.5 m.
  - An unknown texel keeps its last decision. A texel that has never been measured counts as "defer".

 
- **`polygonRoofCaps`** (`:552`). Scanline the polygon over the field, using the span logic of `fillPolygon` without writing.
  - If 50% or more of its texels are known: cap = 0 (drop) when it has fewer than 20 rising texels (about 20 m²); otherwise cap = max over its rising texels' world Y.
  - If fewer than 50% are known: the current 10 m `top` rule, unchanged.
- **`fillPolygon`** (`:97`) takes an optional `keep` view and skips texels whose state is known and not kept. Defer texels fill as today. Before filling, one 3×3 open-then-close pass on the keep bits stops 1 m stair-step noise and single-texel trees from becoming walls.
- **Gap cells.** `classifierCells` (`:414`) and `requireRoofed` (`:356`) are unchanged: lowRise has no top-down equivalent. `paintGapCells` (`:471`) paints only the kept texels inside a gap cell where the field is known, and the whole cell where it is not.
- **Collider rule intact.** `core` is still the undilated fill plus the painted gap texels. `mask` is still `dilate(core)`. Walls still trace `core` (`build`, `:697`, `traceStencil(core, 0.5, base)`).

## 4b. Growing a footprint into the connected mesh

Section 4 trims a footprint to where the mesh rises; this grows it to where the connected mesh still rises.

**Rule.** After the keep-filtered fill, before dilation, `growFootprints` runs one multi-source breadth-first flood on `filled`. Seeds: filled texels with a 4-neighbour that is unfilled, known, kept and not rough. A step enters such a neighbour if its rise is at most the parent's cap (a taller one is another building, left to the gap rule), for at most 8 layers (`CUTOUT_GROW_M`).

**Bound: a fixed 8 m.** The error is absolute: registration (1-3 m) plus an unmapped bay or wing. A fraction of polygon size gives a shed 1.5 m and a 200 m block 50 m of canopy; "until the rise drops" never ends along rowhouses or canopy. Past 8 m a rising front is likely a separate building, whose cells the gap rule paints. Fronts stopped while still kept count as `grownTruncated`, so the survey shows whether 8 is short.

**Neighbours.** A neighbour's kept texels are already filled, so a front stops at its edge; unclaimed texels between two go to the nearer front. No ownership raster.

**Cap.** A grown texel takes its parent's cap byte: it is the whole structure's ceiling, it keeps the clip continuous across the old edge, and a texel's own rise would let one canopy spike set it. Meeting fronts keep the higher, as `fillPolygon` does.

**Cost.** Seed scan over the 6101 boxes (the outline test `dilateBox` does): 5-10 ms. Flood at 100-300k grown texels: 5-15 ms. Dilation stamps grown texels from the flood queue rather than widening every box (+30 ms). Total about +15-30 ms on the 895 ms build. Rejected: a per-polygon flood (26 MB visited stamp, order-dependent) and a morphological band pass (8 passes, 60-100 ms).

**Walls.** Grown texels are in `core`, `mask` stays `dilate(core)`, walls trace `core`: they move with the mesh. The gap-cell paint-and-restore stays exact, since grown texels lie inside the dilation a gap cell is 3 m clear of.

**Skirt.** Measured at Pioneer Courthouse (2026-10-08): a 3 m strip at the foot of a 14-17 m face reads clear (below the 3 m keep rise), so growth never entered it and satellite ground showed through a band at the base of the wall. After the kept growth, the same flood runs at most 3 more layers (`CUTOUT_SKIRT_M`; option `skirtM`, default 0, off at `cell === 2`) from the final front (every filled or grown texel bordering a candidate) into texels that are unfilled, measured, not kept, not rough, with a rise at or over the hysteresis floor (`keepFloorM(keepRiseM)`, half the keep rise: 1.5 m at default relief; the build is passed `keepRiseM`, and without it the skirt does not run) and at most the parent's cap. Ground reads 0-1.5 m; a plinth, steps, porch, terrace edge or entrance canopy reads 1.5-3 m and belongs to the building. A skirt texel takes its parent's cap and joins `core` like a grown one (walled, stamped by the dilation); a skirt front only enters more skirt texels and never a kept one, so it cannot carry kept growth past the 8 m bound, and `grownTruncated` is unchanged. Counted as `skirted`. Cost: one seed scan over the boxes and the grown texels plus three bounded layers over a thin strip, the same class as a growth layer: a few ms on the ~900 ms build. With `skirtM` 0 the mask is byte-identical.

**Unknown field** (never captured, coarse tile): no seed, no step, today's footprint. Off at `cell === 2`. `baseKey` gains a keep version, bumped when a chunk flips a kept or rough bit.

### Trees

**Planarity, from the floats at apply time.** Rough means |y(i-1) + y(i+1) - 2y(i)| ≥ 1 m along both x and z, an unkept neighbour counting as not planar. Flat and pitched roofs are planar both ways, a parapet or ridge one way, canopy neither. Growth never enters a rough texel and `paintGapCells` skips them; inside a polygon the bit is ignored, so rooftop plant drills no holes.

- False positives: single corner texels (the 2 m dilation covers them), noisy glass roofs, domes. Growth stops short; no building is lost.
- False negatives: a big crown's smooth top (an island in a rough ring, unreachable), and street trees fused into a smooth band along a façade, which grows up to 8 m.

Rejected: range or variance (every roof edge has the full height in its window; 45° roofs read rough); rise relative to the parent roof (blocks a 12 m podium off a 45 m tower); blob area (street canopy is one blob); satellite green (main-thread readback, leaning orthophotos, leaf-off winters, green roofs).

**Byte.** Bits 0-5 rise: 0-31 is 0-15.5 m in 0.5 m, 32-62 is 16-61 m in 1.5 m, 63 unknown. Bit 6 rough, bit 7 kept. Hysteresis stays in the fine range; caps decode a coarse step's top. 3-5 ms per chunk; seam neighbours come from the field.

## 5. Tests

Extend in `tests/cutout.test.ts`:

- `caps at the max photogrammetry roof…` (`:262`): the cap now comes from rising texels.
- `drops a footprint the mesh rises less than 3 m over` (`:454`): field known and flat, so the footprint is dropped.
- `builder: … a roof sample streaming in re-rasters the cap` (`:285`): a heights message re-rasters.
- `input unchanged…` (`:327`): `heightVersion` changes the digest.

New pure tests:

1. A lot polygon whose field rises over its west half only: `core` fills the west half alone, and the traced segments all lie within it plus 1 m (walls on that side only).
2. A polygon over a known, flat field is dropped. The same polygon over an unknown field falls back to the 10 m rule and stays.
3. A gap cell with rise in one corner paints only those texels. With the field unknown, it paints whole.
4. Hysteresis: kept at 3.2 m stays kept at 2.0 m, drops at 1.0 m, and an unknown chunk overwrite keeps the previous bit.

Growth and trees (mask `size: 64, roofCap: true`; field bytes written directly; roof 20 m):

5. Polygon x,z ∈ [-10,10], field kept at 20 m over x ∈ [-10,15), z ∈ [-10,10), 0 m elsewhere: `core` is those 500 texels, x ≥ 10 carries the polygon's cap, the east wall traces at x = 15 ±0.5, nothing at 10.5 < x < 14.5. Never-captured field: 400 texels.
6. Kept over x ∈ [-10,30): `core` ends at x = 18, `grownTruncated` = 20. A 50 m strip at x ∈ [10,14) instead: no growth.
7. A at x ∈ [-20,-2], B at [2,20], both z ∈ [-10,10]; field kept over x ∈ [-20,20), 30 m over A, 20 m elsewhere: x ∈ [-2,0) takes A's cap, [0,2) B's; segments form one outer rectangle.
8. `applyHeightChunk` on four 20×20 patches 10 m apart on 0 m ground (flat 20 m; slope 10-29 m; 20 m with a 2 m step; 4/12 m checkerboard): rough is the whole checkerboard plus only patch corners and step ends. Test 5 with the overhang as that checkerboard does not grow; as flat 12 m, it does.

By hand: `__cutoutStats.heights` and `__cutoutHeightAt(x, z)` against a raycast, plus `grown`, `grownTruncated` and `rough` in `scripts/cutout-survey.mjs`.

## 6. Cost ledger

| Item | Added | Where | Basis |
|---|---|---|---|
| Chunk render submit | 1.8 ms, about 1 per refresh, ≤1 per frame | main | measured |
| GPU per chunk | ~1-2 ms | GPU | estimated from measured 0.5-1.7 ms |
| Readback | 70-110 ms latency, 0 stall, 11 ms copy-out | main | latency measured (surface), copy measured |
| Field update | 2-4 ms per chunk, +3-5 ms rough bit | worker | estimated |
| Caps scanline | +20-40 ms on the 895 ms build | worker | estimated (about 3M footprint texels) |
| Fill keep test | +<5% of fill | worker | estimated |
| Growth (seeds, flood, grown dilation) | +15-30 ms per build at 6101 footprints | worker | estimated |
| Base re-raster on a kept/rough flip | one fill per heights message, 2 s coalesced | worker | design |
| Trace | 525 ms ±10% (smoothed); +30% if unsmoothed | worker | estimated |
| Landing | 15-25 ms, roughly proportional to segments | main | estimated |
| Upload | 26 MB unchanged | GPU | measured baseline |
| Memory | 6.5 MB GPU, 13 MB worker, 3.24 MB transient, ≤4 MB flood queue | — | computed |

## 7. Risks

- Trees: planarity stops growth at rough canopy, but a smooth street-tree band along a façade still grows up to 8 m, and canopy inside a lot is bounded only by the opening pass and the 20-texel floor.
- The 8 m bound is reasoned, not measured.
- The 11 ms readback copy runs on main, once per chunk.
- Under-footprint terrain error on hills: the 10 m DEM against the mesh ground can be off by 1-2 m, about half the threshold.
- The tile shaders could still compile on the first capture if the warm-up does not cover the shared program.
- Coarse-tile texels stay on the old rule, so far buildings keep the 10 m behaviour.

**Next prototype.** Run growth offline on captured chunks around the owner's building and polygon 4412, logging how far fronts would run unbounded, before wiring the stencil.

## Note: rebuilding the classifier from the same field

Only `topGrid` could come from the field (a 10×10 max-reduce, 2-5 ms per chunk). `structureGrid`, `lowRiseGrid` and `deckGrid` need the lowest geometry and vertical occupancy that `rasterizeTile` (`tileColliders.ts:223`) collects, which a top-down render cannot see, and the classifier also runs in node (`captureRasters`, `Tileset.ts:998`). Keep the CPU classifier; caps read the field directly.
