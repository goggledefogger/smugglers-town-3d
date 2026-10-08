# Cutout 3D: per-texel heights from the loaded tiles (option 2)

Status: design, 2026-10-08. Nothing built. Baseline: `npx vitest run tests/cutout.test.ts` passes, 49/49.

## 1. Where the tiles live, and how to render them top-down

- The tiles are not a view-dependent renderer. `TileStreamer` (`src/services/tiles/Tileset.ts:362`) owns one `group` (`:363`) of per-tile groups. It holds one LOD per area (refine REPLACE, atomic swap at `:1146-1180`). The set changes only inside async `add`/`remove`/`refine`/`coarsenOne` callbacks (`:1087`, `:1137`, `:1146`). `update()` (`:883`) only picks the next swap. main.ts puts every tile on layer 1 (`src/main.ts:402-406`).
- **LOD pinning needs no error-target switch.** A synchronous render issued from the frame loop sees exactly the geometry of that frame, because no streaming mutation can run during `renderer.render`. The one thing to pin is which tiles count. Tiles coarser than `RASTER_MAX_ERROR_M = 8` (`:92`) already never feed the classifier (`rasterOf`, `:1133`). The capture hides them for the call, so their texels read as unknown. New accessor: `TileStreamer.forEachTile(cb(group, geometricError))`, plus a `dirtyRect` that `add`/`remove`/`refine` widen.
- **Reuse `SurfaceCapture`** (`src/render/SurfaceCapture.ts`). It already does this pass for the wheels:
  - an orthographic camera straight down (`:162-174`);
  - the tile group moved into a private scene with an `overrideMaterial` that writes world Y (`:35-46`, `:94`, `:176-199`);
  - an R32F target (`:127`), and `readRenderTargetPixelsAsync` with the r169 bind-first workaround and an RGBA fallback (`:226-279`);
  - the program warmed with `compileAsync` (`:103-125`).
  
  The override material matters: it bypasses the cutout discard in the tile shader, so a footprint we drop can still be measured and come back. Plan: factor the render-and-readback core into a `TopDownCapture` class shared by both features. The new `HeightCapture` adds chunking and coarse-tile hiding. Renderer: `WebGLRenderer` (`src/render/Renderer.ts:85`), three 0.169, no WebGPU.

## 2. The height field

- **Resolution 1 m.** It matches the stencil texel (`CUTOUT_TEXEL_M`, `src/main.ts:675`), so the fill can read it 1:1.
- **Extent.** The 3600 m stencil square, split into a fixed 4×4 lattice of 900 m chunks starting at x, z = -1800. Only chunks that hold fine tiles get captured. With `STREAM_LOD` (`Tileset.ts:76`), fine tiles sit within about 500 m of the player, so that is 1-4 chunks.
- **Format on the GPU.** R32F world Y. This is the proven readable path.
- **Format in the worker.** One persistent `Uint8Array(3600²)`:
  - bits 0-6 hold the rise above terrain in 0.5 m steps (0-63 m, capped);
  - 127 means unknown;
  - bit 7 holds the hysteresis "kept" flag.
- **Baseline.** Subtracted on the CPU, in the worker, by bilinear sampling of the 10 m tileset terrain (`cutoutTerrain`, `main.ts:699`, the same source `roofInput` uses at `:877`). It is sent once per tileset.
- **Memory added.**
  - GPU: 6.5 MB, the 900² R32F colour target plus its depth.
  - Worker: 13 MB, persistent.
  - Main thread: 3.24 MB per chunk in flight, transferred to the worker rather than copied.

## 3. Readback and threading

- WebGL2 `readRenderTargetPixelsAsync` (PBO plus fence). Measured for the 768² R32F surface capture (`docs/ARCHITECTURE.md:225-229`): 2.6 ms CPU submit p50 (8.5 ms p99), 0.5-1.7 ms GPU, and the readback resolving 70-110 ms later with no stall. A 900² chunk is 1.37× the texels, so the estimate is the same order: about 3 ms submit and about 1 ms to copy the result out of the buffer.
- **When it runs.** Never per frame by default. `refreshColliders` (`main.ts:579`, at most every 1.5 s while `collidersDirty`) marks the chunks under `dirtyRect` dirty. A chunk is captured only once no tile in it has changed for 1 s (settle). After that, `HeightCapture.update(now)` in the frame loop (beside `surfaceCapture.update`, `main.ts:1813`) submits at most one chunk per frame, with one readback in flight, and only while `traits(viewMode).cutsToFootprints`.
- The finished `Float32Array` is posted (transferred) to the existing cutout worker as `{kind:'heights', chunk, data}`. `footprintMaskWorker.ts:30` gains a discriminant. The worker updates its field and replies with `keepChanged`. Only then does main set `cutoutDirty` and call `cutoutRebuild.request()`. The stencil therefore keeps its current coalesced cadence (`CUTOUT_REBUILD_MS = 2000`, `main.ts:696`). The input digest (`footprintMask.ts:650`) gains a `heightVersion` counter rather than 13 MB of bytes.

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

Validating the GPU producer by hand, in a browser, when the owner frees it:

- Add to `__cutoutStats`: `heights: {chunks, renderMs, readbackMs, known, kept, dropped}`.
- Add `window.__cutoutHeightAt(x, z)` returning the rise and state, then compare it with a raycast at x=195, z=-35, where the raycast hits 44 m.
- Add an F8-style preview modelled on `SurfacePreview` (`SurfaceCapture.ts:303`).
- Extend `scripts/cutout-survey.mjs` to print the new fields.

## 6. Cost ledger

| Item | Added | Where | Basis |
|---|---|---|---|
| Chunk render submit | ~3 ms, about 1 per refresh, ≤1 per frame | main | estimated from measured 2.6 ms p50 |
| GPU per chunk | ~1-2 ms | GPU | estimated from measured 0.5-1.7 ms |
| Readback | 70-110 ms latency, 0 stall, ~1 ms copy-out | main | latency measured (surface); copy estimated |
| Field update | 2-4 ms per chunk | worker | estimated |
| Caps scanline | +20-40 ms on the 895 ms build | worker | estimated (about 3M footprint texels) |
| Fill keep test | +<5% of fill | worker | estimated |
| Trace | 525 ms ±10% (smoothed); +30% if unsmoothed | worker | estimated |
| Landing | 15-25 ms, roughly proportional to segments | main | estimated |
| Upload | 26 MB unchanged | GPU | measured baseline |
| Memory | 6.5 MB GPU, 13 MB worker, 3.24 MB transient | — | computed |

## 7. Risks

- Trees and canopy inside a lot read as rise. The opening pass and the 20-texel floor bound this, but cannot remove it.
- Under-footprint terrain error on hills: the 10 m DEM against the mesh ground can be off by 1-2 m, about half the threshold.
- The tile shaders could still compile on the first capture if the warm-up does not cover the shared program.
- Coarse-tile texels stay on the old rule, so far buildings keep the 10 m behaviour.

**Prototype first.** Capture one chunk around Pioneer Square with the shared core, dump rise and keep at x=195, z=-35, and dump them over a known lot polygon. This proves the measurement and the baseline before any change to `footprintMask.ts`.

## Note: rebuilding the classifier from the same field

`topGrid` alone could be derived from the field: a 10×10 max-reduce of known texels, about 2-5 ms in the worker per chunk. Texels in coarse tiles would stay `NO_DATA`, exactly as today. `structureGrid`, `lowRiseGrid` and `deckGrid` cannot be derived. They need the lowest geometry and the 32-bin vertical occupancy that `rasterizeTile` (`tileColliders.ts:223`) collects per triangle, and a top-down depth render sees only the top surface. The classifier also runs in node for the offline rigs (`captureRasters`, `Tileset.ts:998`). Recommendation: let Cutout's caps read the field directly, keep the CPU classifier, and revisit only if a second consumer of `topGrid` disagrees with the field.
