# Road authoring

Roads are a graph in `layers.roads`. Nodes have unique nonnegative IDs and a world-space position.
Edges reference two node IDs, a class name and a sampled axis `pts`. Coordinates are metres with Z up.
The graph is authoritative; road meshes, junction trims, bridge supports and roadside props are derived.

## Classes

Class definitions live in `roads.classes`; missing fields use `CLASS_DEFAULTS` from
`world/roadnet.js`. They are gameplay parameters rather than civil-engineering compliance rules.

| Field | Meaning |
|---|---|
| `lanes` | Lanes per direction, or total lanes for a one-way class |
| `lane_w` | Lane width in metres |
| `shoulder` | Shoulder width on each side |
| `median` | Central separation width for a two-way road |
| `side` | Additional side strip outside the carriageway |
| `oneway` | One-way cross-section |
| `r` | Corner radius used when laying a road |
| `max_grade` | Maximum profile grade as a ratio; 0.1 means 10% |
| `sigma`, `k_min` | Profile smoothing parameters |
| `corner`, `prio` | Junction geometry and class priority parameters |

`hw` and `hwt` are derived half-widths. Change the source parameters and let `syncClassWidths`
recompute them. See `world/profile.js` for profile smoothing and level classification.

## Editing

Draw the axis with the Road tool, choose a class and height offset, then finish with Enter or the
Finish button. The draft shows width and length. Ends connect to nearby nodes or split an existing
road only at a compatible elevation. Crossing a bridge at another height does not create a junction.

Select a road to inspect length, grade, bridge/tunnel samples and control points. Drag controls to
reshape the axis; Alt-drag inserts a control and Alt-click removes an interior control. Shift-drag,
PgUp/PgDn or numeric XYZ fields change point elevation. Moving an endpoint moves the shared node
and the connected road ends. Reprofile follows natural terrain while keeping node constraints.

Escape, pointer cancellation or changing tools cancels an unfinished gesture. A completed gesture
is one undo step. Topology changes use `RoadTx`; direct generic edits cannot replace road IDs or
connections. MCP exposes the same rules through `road_add`, `road_controls`, `road_edit_control`
and `road_reprofile`.

## Derived data

`RoadWorld` rebuilds affected asphalt, markings, junctions, supports and graded terrain.
`terrain.base` stores natural heights; `terrain.h` includes grading. Bridge/tunnel flags follow
road levels. Terrain brushes edit the base and preserve dependent cuts and embankments.

Road furniture has an `owner` that identifies its generated road. Manual transformation or material
assignment removes that ownership so future road rebuilds preserve the hand-placed prop. Geometry,
materials and placement rules are implemented in `world/roadmesh.js` and `world/furniture.js`.

## Checks

```sh
npm run test:roads
npm run test:authoring
npm run test:ui
```

Golden geometry inputs live in `tests/fixtures/legacy/`; compatibility checks use explicit numeric
tolerances. Physics probes and driving diagnostics are in `tools/diagnostics/` and write generated
reports under ignored `city/out/`. GLB exports include road graph metadata; engine-specific collision
and navigation meshes must be prepared by the importing game pipeline.
