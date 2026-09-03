# Contributing

## Before you push

```bash
npm run typecheck && npm test && npm run build
```

All three should pass. The build runs the typechecker again, so a green
build means the bundle is real.

## The one rule that matters

`core/` never imports from `app/`, `render/`, `ui/`, or `services/`. Its only
dependency is three.js math types. That's what keeps the whole simulation
testable in plain node with no browser, and it's easy to break by accident —
if you find yourself reaching for the renderer from inside a physics file,
the answer is an event or a return value, not an import.

The rest of the layering is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Tests

Anything with a branch, a loop, or a rule gets a test. Physics and gameplay
changes especially: several bugs in this codebase's history were caught only
because a test pinned the old behavior.

Tests live in `tests/`, run in node, and take under a second. There's no
browser harness — if something can only be verified by looking at it, say so
in the pull request and include a screenshot.

## Comments

Comment the *why*, not the *what*. This codebase has a few places where the
obvious implementation is wrong for a non-obvious reason: Google's tiles sit
on a different datum than the elevation API, glTF is Y-up where 3D Tiles are
Z-up, a fixed physics timestep aliases against a 120 Hz display. Those
comments earn their keep. `// increment the counter` does not.

If you fix a bug that came from a framework gotcha, leave two lines above the
fix explaining the constraint. Write it while you still remember.

## Performance

The game targets modest hardware. Before adding per-frame work, check what
it costs: draw calls, texture uploads, and allocations in the frame loop are
the usual suspects. Reuse scratch vectors instead of allocating in `sync()`
or `step()`. There's a performance section in the architecture doc with the
current budget and the known hitches.

## Commits

Conventional prefixes (`feat:`, `fix:`, `docs:`, `refactor:`). Say what
changed and why in the body; if you fixed something subtle, explain the root
cause rather than the symptom. Keep unrelated changes in separate commits.
