# Architecture

City Labs stores an editable city document and derives its render geometry from that document.
The browser editor, desktop editor and MCP tools share the same data model and authoring rules.
See [VSPB](VSPB.md) for the file format and [Desktop and MCP](APP.md) for integration details.

## Module boundaries

| Directory | Responsibility |
| --- | --- |
| `format/` | Binary codec, world schema, migration, transforms and validation |
| `world/` | Road graph geometry, profiles, grading and generated roadside objects |
| `editor/` | Authoring UI, history, gestures, shared commands and exports |
| `viewer/` | Shared Three.js renderer, resource ownership, terrain and building geometry |
| `mcp/` | Tool definitions, generators, scripts and headless file sessions |
| `desktop/` | Node MCP bridge, runtime pin and desktop development launcher |
| `src-tauri/` | Native document access, dialogs, menus and sidecar lifecycle |
| `tests/` | Unit, integration, browser, benchmark and compatibility fixtures |
| `tools/` | Build, release, conversion and physics diagnostic utilities |

Keep document operations independent of Three.js and native APIs. Put shared validation and
mutation rules below UI and transport adapters so manual edits and MCP produce the same result.

## Authoring model

VSPB major 2 is the write format; readers accept major 1 and 2. `meta.documentVersion = 2`
identifies the city model independently of the container. Unknown extension fields survive
round trips. Version 1 migration adds missing defaults; version 2 registries are authoritative,
so deleting an unused built-in resource persists across saves.

Coordinates use metres and Z up. Buildings store local part outlines, holes and base heights,
plus `transform: { p, r, s }`. Rotation is Euler XYZ in radians; scale must be positive.
Furniture stores position `p`, yaw `h`, optional `tilt`, `scale` and a material override.
Manual furniture transforms remove road-generated ownership.

Terrain keeps complete natural and graded heightfields in memory. Sparse Float32 grading can
be stored as absolute height overrides and indices, preserving bits without storing mesh buffers.
Road meshes are derived from the graph; modifying a road updates its affected neighbors,
terrain and generated objects.

## Transactions and validation

`editor/commands.js` and `format/validate.js` provide shared operations and contextual checks.
Validate references and numeric ranges before rebuilding geometry. Topology operations own
road IDs and connections; generic field edits cannot replace them.

`History` preserves record identity and supports begin/commit/cancel, undo/redo and no-op
suppression. `RoadTx` groups topology and related road changes. A failed script or batch rolls
back the whole operation. Headless `FileSession` provides the same undoable semantics.
Stdio commands are serialized, and revision-aware saves leave newer changes dirty.

A pointer gesture commits once or rolls back completely. Escape, pointer cancellation, loss of
window focus and tool changes must also release temporary render state. Scalar material edits
update existing controls so native keyboard and pointer focus can continue through a commit.

## Shared resources and rendering

The material registry uses metallic/roughness PBR, with legacy material conversion. Building
parts have wall, roof and trim slots; furniture can override its prefab material. Dependency
checks prevent deleting referenced resources. The material panel owns its preview renderer,
environment and facade textures; it never disposes the world's shared cache.

Building walls use local distance-based UVs. Scaling an instance scales its texture pattern;
changing architectural dimensions without stretching windows is a separate operation.
Opaque building geometry is batched in 600 m cells; road batches use 1200 m cells. Repeated
objects use spatial instancing. Transparent objects use separate object sorting, not
order-independent transparency.

Terrain chunks cover 256 cells and use adaptive steps of 1/2/4/8. Roads, tunnel corridors,
coasts and ground-surface polygons preserve dense samples. Shared boundaries retain original
samples to avoid LOD cracks. Building details use distance thresholds with hysteresis, while
shells remain available for picking. There is no building-shell simplification, streaming or
occlusion culling.

Geometry, materials and textures require explicit ownership and disposal. Removing a batch
must preserve shared resources; disposing a world releases them. See [Performance](PERFORMANCE.md)
for measurement and regression checks.

## Platform and export boundaries

The browser uses file input/download and an IndexedDB working copy. `editor/desktop.js` loads
native APIs only inside Tauri. The Rust host owns selected-file access and supervises a Node
MCP sidecar. Neither the renderer nor the world model depends on that host.

GLB exports use metres and Y up, mapping source coordinates as `[x, z, -y]`. `extras.cityLabs`
contains export-local entity IDs, triangle/instance ownership ranges and a road graph in the
same coordinate system. These IDs are not stable across independent exports. Temporary export
resources are disposed without destroying the working scene.

VSPB remains the authoring source. GLB export does not generate colliders, navigation meshes
or baked tunnel shader clipping. Signed installers, native dialogs and OS file associations
require platform-specific testing; browser tests do not cover them.
