# Baked Facades (experimental)

Status: **experimental, not recommended for play.** The simple, stable
alternative is **Map + Objects** (satellite ground and roofs, lit masonry
walls). This document hands off the photographic-facade attempt.

## Situation

The goal is authentic photographed wall imagery on the game's collision
buildings, stable while driving and rotating the camera, without the
screen-space projection used by Best 3D (which copies whatever tile pixel the
gameplay camera happened to see, so features slide with the camera and land on
the wrong surfaces).

Implemented in this branch:

- `src/render/FacadeBaker.ts` bakes actual tile wall detail into a bounded
  2048² RGBA8 atlas (64 slots of 256px, 2px gutters, no mipmaps), rendering the
  original tile geometry with its own UVs through clean unlit bake proxies.
  Windows, brick, and signs are preserved because the source UVs do the work.
- Fixed world-space orthographic face cameras (+X/-X/+Z/-Z) so placement does
  not depend on the gameplay camera. Geometric-normal rejection drops roofs,
  back faces, and off-orientation geometry; a depth shader ranks the source
  surface nearest the destination wall.
- A merged alpha-tested overlay mesh shows covered texels and discards the rest,
  so the opaque collision box remains as fallback. Covered RGB is divided by
  filtered coverage to avoid dark edges.
- Stable bounds-based keys survive collider reordering; relocation clears
  sources, atlas, and overlays; renderer state is restored through `finally`.
- Unit coverage: `tests/facade-baker.test.ts` (19 tests) plus an opt-in real
  WebGL pixel test (`FACADE_GPU=1`) that proves texture dependence, UV-channel
  selection, nearest-surface ranking, roof/back-face rejection, uncovered
  fallback, fringe-free edges, and camera-stable detail.

## Measured blocker

Live run at the reported location (`37.79068, -122.40404`, body
`[-232, 54.2, -109]`), 203 loaded tiles, 290 source meshes, 64 completed
captures, 623,319 atlas pixels with photographic detail:

- Screen pixels changed by baked facades at the exact reported camera:
  **88 / 1,024,000 (0.0086%)**.
- A nearby street control changed 86,614 pixels but had only 46 interior edge
  pixels, i.e. mostly plain.
- Raising the camera to sampled ground placed it **inside a collision box**;
  back-face culling contributes to the missing display.
- No JavaScript, shader, capture, or WebGL errors. One main render; captures
  ran separately at a ~83 ms minimum interval.

The atlas content is real photography, so the transfer mechanism works. The
remaining problem is correspondence and visibility, not the texture source.

## Recommended next steps

1. **Diagonal-wall correspondence.** Collision boxes are axis-aligned
   reconstructions of diagonal SF facades. Widen the admissible capture slab
   from `min(cell, thickness/2)` to the full box interior while still rejecting
   opposite-facing and unrelated nearby geometry, and prove it with an oblique
   source-wall test before changing tolerances.
2. **Overlay visibility.** Handle street-level cameras and spawn-inside-box
   cases, including back faces and the case where the destination wall is being
   viewed from behind. Do not solve this by disabling culling globally.
3. **Coverage honesty.** Keep the solid fallback for faces with no matching
   wall; never stretch a photo to a height it never had.
4. **Acceptance thresholds.** Extend `scripts/verify-baked-facades.mjs` to gate
   on minimum visible photographic coverage at a street-level camera, not just
   nonempty atlas slots. Current run is retained as the failing baseline.
5. **Budget revisit.** If coverage improves, re-check the 2048 atlas, 64-slot
   cap, and 24-draw / 120k-triangle per-capture budget against downtown load.

## Key files

- `src/render/FacadeBaker.ts` — atlas, capture, overlays, lifecycle
- `tests/facade-baker.test.ts` — unit + opt-in GPU pixel tests
- `scripts/verify-baked-facades.mjs` — live SF acceptance (currently failing)
- `.playwright-mcp/baked-facades/report.json` — full measurements and shots