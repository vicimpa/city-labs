# Rendering performance

Use repeatable scenes and cameras when changing batching, material sharing or level of detail.
Keep viewport size, device pixel ratio, graphics quality and shadow settings fixed. A visual
improvement that adds geometry is not directly comparable to a geometry-only optimization.

## What to measure

- Actual draw calls and triangles from `renderer.info.render`, including shadow passes.
- CPU build and edit latency, separately from GPU completion and frame intervals.
- Median and p95 frame intervals after warm-up, across repeated runs.
- Resource counts after repeated edits, undo/redo and document replacement.
- Screenshots of near and distant views, transparent objects, roads, coastlines and ground patches.

`World3D.stats()` reports structural counts, not the workload of a particular visible frame.
`renderer.info.memory` counts objects, not VRAM bytes. Frame intervals near the display refresh
period do not establish a GPU speedup; use GPU timers where supported for GPU elapsed time.
Record the renderer/backend, resolution and quality with results.

## Design constraints

Building batches use 600 m cells and road batches use 1200 m cells. Larger cells reduce calls
but increase rebuild cost and make culling less precise. Benchmark both rendering and local
edits before changing those defaults.

Terrain chunks use adaptive LOD while preserving dense road, tunnel, coast and ground-surface
regions. Test shared boundaries and edits that change shoreline topology. Architectural details
have distance hysteresis, so the camera path can affect a boundary frame's triangle count.
Transparent-object sorting is a fallback; inspect overlapping transparent geometry from
multiple directions.

Resource tests should finish each cycle in the same state. Look for a stable plateau after
warm-up, and verify disposal events independently for shared resources. Browser context closure
can hide leaks that occur during a long editing session.

## Checks

Run the geometry and terrain checks before browser benchmarks. Browser checks must run
headlessly and use disposable documents. The benchmark compares two running editor builds
with the same read-only `editor.metrics()` interface; it must not save the source city.

```sh
npm run test:render
npm run test:ui
BASELINE_URL=http://localhost:5200/editor/ CURRENT_URL=http://localhost:5199/editor/ npm run benchmark:render
CURRENT_URL=http://localhost:5199/editor/ npm run benchmark:roads
```

Start the two editor servers explicitly before running an A/B comparison. Both versions must
expose `editor.metrics()`. Pass an output directory after `--` to keep JSON results and screenshots;
otherwise benchmarks use the system temporary directory. URLs are required, so a benchmark cannot
silently attach to an unrelated local server.

CI browser checks use `CITY_LABS_SOFTWARE_WEBGL=1` for an explicit software renderer.
Set the same variable to reproduce that backend locally. `CITY_LABS_TEST_OUTPUT` selects an
artifact directory; CI retains screenshots and failure details. Mechanics tests use bounded
maps, while the deployment and tunnel checks exercise the full bundled city.
