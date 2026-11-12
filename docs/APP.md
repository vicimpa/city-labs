# Desktop and MCP

The world editor runs in two ways:

- in a browser (`npm run edit`), where the working copy lives in IndexedDB;
- as a desktop app (`npm run app`), where it works on a `.vspb` file on disk.

An MCP server lets an AI agent read and edit the world.

## Desktop app (Tauri v2)

Desktop macOS packages require macOS 13.5+ because the bundled Node 24 runtime does.

Install Node 24+ and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS
(Rust, platform compiler, and WebKitGTK development packages on Linux). Then run:

```
npm ci
npm run app
npm run app -- /absolute/path/to/world.vspb
npm run build:app       # static web assets, bundled MCP JS, verified portable Node
npm run check:desktop
npm run dist            # complete installer for the current platform
```

The Rust host owns the selected document. It opens native file dialogs and saves via a sibling
exclusive temporary file, fsync and rename. Cancelling a dialog or failing full world validation does not replace the current save destination.
Closing dirty work asks Save / Don't Save / Cancel; a cancelled Save As keeps the window open.
A polling watcher checks file metadata every 700 ms, including replacement by external tools. The
editor reloads clean documents and offers a choice for dirty documents. Files above 128 MiB are
refused by the native host.

`src-tauri/src/main.rs` owns native files, menus, window lifecycle and child process supervision.
`editor/desktop.js` implements the `window.vspbHost` contract before editor startup; the
browser does not execute native imports. Browser file input, downloads and IndexedDB remain usable.
`desktop/bridge.mjs` is an independent Node MCP sidecar with the same tools used by headless stdio.

Production packages include an official portable Node binary pinned in `desktop/node-runtime.json`.
`tools/prepare-node.mjs` downloads it from nodejs.org, checks SHA-256 against the release manifest,
and includes its licence. macOS signing preserves the minimum V8 `allow-jit` entitlement for that runtime. Downloads
are cached in `build/node-runtime/`; end users do not need Node installed. Development uses the Node
that launches `npm run app`; its first launch also prepares cached native resources for compilation. Every target architecture needs its own runtime binary.

Production assets come from `dist-web/`; desktop development uses a dedicated Vite configuration on
localhost:5199 that does not expose the browser dev endpoint for overwriting the source sample.
The editor receives a writable sample copy in the Tauri app-data `worlds` directory. The source
`city/data/vespera.vspb` is never saved by the desktop host unless explicitly selected as a document.

The main window has a native title bar. Menus follow the editor's Russian/English switch. OS-open
requests are queued until the editor is ready, and the editor confirms before replacing dirty work.
Install complete releases to update. Automatic updates are disabled.

### Native authority

Only the `main` window receives the application's `host_action` permission and event-listen access.
Custom commands are registered with an explicit AppManifest. The frontend has no filesystem plugin
permissions, no shell-spawn permission and no remote-origin capability. File paths come from native
pickers/OS-open requests, and `openPath` is checked against those selected paths. The host saves only
the current document or a path selected in Save As/Export. Native command permissions do not sandbox
the trusted Node tool implementations; MCP scripts must still be trusted.

## MCP

The tools are defined once in `mcp/ops.js`, against an abstract session, and are served two ways.

**stdio**: `node mcp/stdio.mjs [world.vspb]`, registered for this project in `.mcp.json`.

- If the app is running with the same file open, every call is forwarded to the app. The edits
  appear live in the editor and you can undo them with Cmd+Z.
- Otherwise the server edits the file headless (`mcp/file-session.js`) and writes it on `save`.

**HTTP in the app**: `http://127.0.0.1:7357/mcp` (Streamable HTTP, stateless).

- Change the port with `VSPB_MCP_PORT`.
- Configure a compatible MCP client with this HTTP endpoint, or use the stdio command above.

- The server listens on 127.0.0.1 only. It validates Host and exact Origin (including port), validates
  `/tool` arguments, caps request bodies at 2 MiB and limits pending requests. Tool calls are serialized.
- Optional `VSPB_MCP_TOKEN` requires `Authorization: Bearer …` on all endpoints, including health.
  Set the same variable for the stdio proxy. Without it, any local process can call the server;
  browser pages from other origins are rejected. Keep scripts and local MCP clients trusted.
- Rust starts and stops the sidecar with the window lifecycle. Closing the host kills the child;
  the sidecar also exits when its stdin closes. A port conflict is logged and does not silently
  connect to a different editor. `screenshot` captures the rendered Three.js canvas and restores UI
  panels even when capture fails.

| tool | what it does |
| --- | --- |
| `world_info` | file, unsaved state, counts per kind, extent, registry sizes, plus the record shapes |
| `list_types` | type registry entries (materials, building types, zones, surfaces, prefabs, road classes) |
| `find` | records of a kind filtered by fields (`=`, `contains`, `in`, `min/max`), `near`, `bbox` |
| `get` / `update` / `create` / `delete` | one record by kind + index (or id for roads and nodes); kinds include `rail` and `powerline` |
| `transform` | move / rotate / nonuniform scale, optionally onto the ground; local building buffers stay unchanged |
| `material_assign` | assign shared material to a building part/slot or a furniture override |
| `road_add` | lays a road through points with optional elevation; level-aware ends attach to nodes or split the road they land on |
| `road_controls` / `road_edit_control` | inspect/move/insert/remove sparse controls; linked nodes and roads follow |
| `road_reprofile` | re-levels a road over the natural ground |
| `terrain_sample` / `terrain_edit` | heights, and raise / lower / flatten / smooth of the natural ground |
| `map` | a top-down map image of an area (or the whole city), with numbered roads in the legend; works without the app |
| `run_script` | JavaScript over the world for queries and bulk edits: one undo step, derived data rebuilt once |
| `generate` | a standard generator with parameters (`terrain`, `streets`, `buildings`, `trees`): one undo step |
| `new_world` | a new empty map, `width_m` × `depth_m` (or `size_m`), grid step `res_m` or automatic; refused while there are unsaved changes unless `force` |
| `def_set` | creates, replaces or deletes a registry entry |
| `save` | writes the file |
| `screenshot` (app) | the 3D view as a PNG, optionally after aiming the camera or focusing a record |
| `select` (app), `undo`, `redo` | select in the live UI; undo/redo also work in a headless file session |

Derived data (asphalt, junctions, bents, graded terrain, road furniture) is rebuilt after every
call, as it is for edits made by hand.

### Maps

`map` draws the area from the data: shaded terrain, water, ground patches, roads (a dark edge marks a
bridge, a dashed line a tunnel), buildings coloured by material, rails, power lines, trees and a grid
labelled in metres. Markers on the longest visible roads are explained in the text part of the result
(number → road id and name), along with the scale. Give `center` + `size_m` or a `bbox`; with
neither, it draws the whole map. `highlight` outlines records in magenta.

### Scripts

`run_script` runs `code` as the body of `async function (world, args)`. The API is described in
the tool description and in the editor's **Script** tab, which runs the same code with the same
API. Example:

```js
const t = world.find('building', (b) => b.type === 'tower' && b.zone === 'downtown');
for (const { rec } of t) world.edit('building', rec, (b) => b.parts.forEach((p) => { p.h *= 1.1; }));
return t.length;
```

All edits of one successful run are one undo step. A failed run rolls back commands, history and dirty state.
Derived geometry is rebuilt once, at the end. The same validation and transformations are shared
with manual editing; a live MCP mutation is refused during an active gesture or file operation. A script runs
in the app's or the server's process, so only run code you trust.

Building contours are local in document version 2. Use `world.center`, `world.move`,
`world.rotate`, `world.scale` or the `transform` tool for world placement. Furniture retains
`p/h` and adds `tilt/scale`; changing it manually removes its road-generated owner.
Generic edits cannot replace road IDs/connections; topology belongs to road tools.

Game export writes glTF 2 binary in metres/Y-up. `extras.cityLabs` carries export-local entity
IDs, triangle/instance ownership ranges and road-graph metadata. VSPB remains the authoring
source. Export does not create engine-specific collision or navigation meshes or bake tunnel
shader clipping; consult the metadata/terrain settings when importing into a game engine.

### Generators

Generators live in `mcp/generators.js`, on the same world API as scripts. Each one is a list of
typed parameters plus a `run(world, params)`. The editor's **Generators** tab builds its form from
that list, and its centre fields default to the point the camera looks at. MCP `generate` takes
`{ id, params }`, and omitted parameters take their defaults. A whole run is one undo step.

| id | parameters |
| --- | --- |
| `terrain` | amplitude, wavelength, octaves, base height, island, mode (replace / add), seed |
| `streets` | centre, width × depth, block size, rotation, bend, street class, avenue every N, avenue class, seed |
| `buildings` | centre, radius, zone preset, floors from / to, density, setback, seed |
| `trees` | centre, radius, trees per hectare, patchiness, seed |

To add a generator, give it an entry in `GENERATORS`, plus `gen.<id>`, `gen.<id>.help` and
`gen.p.<param>` in both locales.

## Lines: control points, heights, railways and power lines

- **Control points.** Roads and railways are dense (a point every 4–8 m). With
  **control points** on (Select tool options), only the points that carry the shape get handles,
  about one per 50 m. They are found by simplifying the line within the **control tolerance**.
  - **Drag** one and the line bends smoothly up to the second control point on each side; the rest
    of the line stays exactly where it was.
  - **Alt+click** the line to add a control point there.
  - **Alt+click** a control point (or **Del** while hovering it) to remove it. The stretch between
    its neighbours becomes a smooth curve through them.
  - Turn the option off to edit every point. Neighbours then follow with the **axis falloff**.

  The code is in `world/spline.js`.
- **Heights.** **Shift+drag** a point to move it up or down; **PgUp / PgDn** raise or lower the
  grabbed point by 1 m (with Shift, 10 m). The Properties tab shows that point's X, Y, Z and its
  height above the ground, all editable, plus **To ground**.
  - On a road, the bridge and tunnel flags are recomputed from the new levels, so raising a road
    turns it into a bridge with piers.
  - Moving the end of a road moves its junction too, and the other roads there bend over their
    first 40 m.
- **Railways.** The Railway tool rounds the corners you click with a **radius** (default 300 m)
  and lays the track on the ground every 4 m. Where the track runs more than 2.5 m above the
  ground, a viaduct is derived: a girder under the bed, with piers every 36 m (`world/rail.js`).
- **Power lines** (tool **Power line**, key 0) are records `{type: 'tower' | 'pole', pts}`, one
  point per post.
  - Click the corners of the route. Posts in between are spaced evenly, no further apart than the
    **span** (towers 320 m, poles 50 m).
  - The posts stand on the ground, face along the line, and carry wires that sag between them
    (`world/power.js`).
  - Moving a post re-strings the line. MCP creates and edits them as kind `powerline`.

`tools/migrate-structures.mjs` converts stored structural props into derived rail and power-line records, writing a separate output file.

## Export and facades

- **Export** (File → Export…, Cmd+E in the app) writes one of three things:
  - `.glb`: glTF 2.0, Y up, metres. The terrain can be thinned to ½ or ¼ of its grid, or left out.
    Objects and trees are exported as instances (`EXT_mesh_gpu_instancing`).
  - `.png`: the top-down plan of the whole map, as the `map` tool draws it, up to 8192 px wide.
  - `.json`: every layer.

  The browser downloads the file; the app asks where to save it. The code is in `editor/export.js`.
- **Facades** live in the registry (`defs.facades`), and `viewer/facades.js` paints them on a canvas
  from their parameters. A material picks a facade by name in `facade`, or uses `wall` to take the
  facade of the building type (`buildingTypes.wall`). The facade colours are multiplied by the
  material colour.

## Window and language

The desktop uses the OS title bar and window controls. The native File menu exposes New / Open /
Save / Save As / Reload / Sample / Export; the Edit menu supports text clipboard operations. Scene
undo stays in the editor's history. The editor's language switch updates native menus and close
dialogs.

## Files and the web version

- **Start-up.** Both the app and the web editor start with a new empty map. The browser continues
  its IndexedDB working copy if there is one. The sample city opens with the **Sample** button.
- **File association.** The installers register `.vspb`. On macOS a double-click reaches the app as
  Tauri `RunEvent::Opened`. On Windows and Linux the path arrives on the command line, or through the running
  instance (single-instance lock). If the open map has unsaved changes, the editor asks first.
- **Web version.** <https://vicimpa.github.io/city-labs/> is built by `npm run build:web` and
  published by `.github/workflows/pages.yml` on every push to `main`. Files are opened from disk
  and saved by downloading; the working copy stays in IndexedDB.

## Tests

```
npm test                # unit and integration suites
npm run test:ui         # isolated headless browser workflows
npm run test:web        # production browser deployment
npm run build:app       # prepare runtime/resources before native compilation
npm run test:app        # source + bundled sidecar MCP process/HTTP integration
npm run test:update     # package/capability and release metadata contract
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
npm run dist
```

The sidecar test uses a deterministic editor RPC fixture; it does not claim to drive the native
WebView. Rust tests cover atomic file replacement, preservation on failure, invalid documents and
size limits. CI compiles and tests the native host on macOS, Windows and Linux. The web build and
browser tests remain independent. Real installed-app checks still need native UI/WebDriver access:
open/save/cancel, dirty close, file association, second instance, external edits, live MCP undo and
screenshots. Packaging and automated unit checks do not substitute for those checks.
