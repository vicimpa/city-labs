# Vespera Editor: desktop app and MCP

The world editor runs in two ways:

- in a browser (`npm run edit`), where the working copy lives in IndexedDB;
- as a desktop app (`npm run app`), where it works on a `.vspb` file on disk.

An MCP server lets an AI agent read and edit the world.

## Desktop app

```
npm run app                           # opens the last file, or city/data/vespera.vspb
npm run app -- path/to/other.vspb
```

- **Файл → Открыть / Сохранить / Сохранить как / Перечитать с диска** (Cmd+O / Cmd+S / Shift+Cmd+S).
  The app saves only when you ask. It writes atomically: a temp file, then a rename. Closing with
  unsaved edits asks whether to save.
- **Changes from outside**, for example by the MCP server or git, are picked up. A clean world
  reloads silently. If you have unsaved edits, the app asks first.
- **Dev server.** The app starts the Vite dev server in-process, so it needs the repo and
  `node_modules`. It is not packaged as a standalone `.app`.
- **`ELECTRON_RUN_AS_NODE`** is set for programs started from VS Code. `app/run.mjs` drops it,
  otherwise Electron would start as plain Node.

Code: `app/main.mjs` (window, menu, files, MCP HTTP server), `app/preload.cjs` (bridge),
host mode in `editor/main.js` (`window.vspbHost`).

## MCP

The tools are defined once in `mcp/ops.js`, against an abstract session, and are served two ways.

**stdio**: `node mcp/stdio.mjs [world.vspb]`, registered for this project in `.mcp.json`.

- If the app is running with the same file open, every call is forwarded to the app. The edits
  appear live in the editor and you can undo them with Cmd+Z.
- Otherwise the server edits the file headless (`mcp/file-session.js`) and writes it on `save`.

**HTTP in the app**: `http://127.0.0.1:7357/mcp` (Streamable HTTP, stateless).

- Change the port with `VSPB_MCP_PORT`.
- To register it in Claude Code: `claude mcp add --transport http vespera-editor http://127.0.0.1:7357/mcp`.
  The app's MCP menu copies this command.
- The server listens on loopback only and refuses requests whose `Origin` is a non-local site.
  There is no other authentication: any program on this machine can call it while the app runs.

| tool | what it does |
| --- | --- |
| `world_info` | file, unsaved state, counts per kind, extent, registry sizes, plus the record shapes |
| `list_types` | type registry entries (materials, building types, zones, surfaces, prefabs, road classes) |
| `find` | records of a kind filtered by fields (`=`, `contains`, `in`, `min/max`), `near`, `bbox` |
| `get` / `update` / `create` / `delete` | one record by kind + index (or id for roads and nodes); kinds include `rail` and `powerline` |
| `transform` | move / rotate, optionally onto the ground |
| `road_add` | lays a road through points; its ends attach to nodes or split the road they land on |
| `road_reprofile` | re-levels a road over the natural ground |
| `terrain_sample` / `terrain_edit` | heights, and raise / lower / flatten / smooth of the natural ground |
| `map` | a top-down map image of an area (or the whole city), with numbered roads in the legend; works without the app |
| `run_script` | JavaScript over the world for queries and bulk edits: one undo step, derived data rebuilt once |
| `generate` | a standard generator with parameters (`terrain`, `streets`, `buildings`, `trees`): one undo step |
| `new_world` | a new empty map, `width_m` × `depth_m` (or `size_m`), grid step `res_m` or automatic; refused while there are unsaved changes unless `force` |
| `def_set` | creates, replaces or deletes a registry entry |
| `save` | writes the file |
| `screenshot` (app) | the 3D view as a PNG, optionally after aiming the camera or focusing a record |
| `select`, `undo`, `redo` (app) | drive the editor UI and its history |

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

All edits of one run are one undo step. Derived geometry is rebuilt once, at the end. A script runs
in the app's or the server's process, so only run code you trust.

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

- **Control points.** Roads, railways and train routes are dense (a point every 4–8 m). With
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

`tools/migrate_structures.mjs` converted the sample city's stored rail piers, pylons, poles and
their cables into this derived form.

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

- **No system title bar.** The editor's top bar is the title bar. On macOS the traffic lights sit
  at its left. On Windows and Linux the system buttons sit at its right, and a ☰ button opens the
  app menu. Drag the bar to move the window; double-click it to maximize.
- **Languages: Russian and English.** Use the switch at the top right; the first launch follows the
  system language. The choice also applies to the menu, the dialogs and the splash. The strings live
  in `editor/locales/{ru,en}.js` under keys such as `save.dirty`, and `npm test` checks that every
  key the UI uses exists in both locales.

## Files and the web version

- **Start-up.** Both the app and the web editor start with a new empty map. The browser continues
  its IndexedDB working copy if there is one. The sample city opens with the **Sample** button.
- **File association.** The installers register `.vspb`. On macOS a double-click reaches the app as
  `open-file`. On Windows and Linux the path arrives on the command line, or through the running
  instance (single-instance lock). If the open map has unsaved changes, the editor asks first.
- **Web version.** <https://vicimpa.github.io/city-labs/> is built by `npm run build:web` and
  published by `.github/workflows/pages.yml` on every push to `main`. Files are opened from disk
  and saved by downloading; the working copy stays in IndexedDB.

## Tests

```
npm test            # localization keys, format, MCP headless (incl. map and scripts), road builder
npm run test:mcp    # stdio server headless on a scratch copy: every tool, then re-read the saved file
npm run test:app    # desktop app end to end (Playwright Electron) on a scratch copy and port 7399
```
