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
| `get` / `update` / `create` / `delete` | one record by kind + index (or id for roads and nodes) |
| `transform` | move / rotate, optionally onto the ground |
| `road_add` | lays a road through points; its ends attach to nodes or split the road they land on |
| `road_reprofile` | re-levels a road over the natural ground |
| `terrain_sample` / `terrain_edit` | heights, and raise / lower / flatten / smooth of the natural ground |
| `def_set` | creates, replaces or deletes a registry entry |
| `save` | writes the file |
| `screenshot` (app) | the 3D view as a PNG, optionally after aiming the camera or focusing a record |
| `select`, `undo`, `redo` (app) | drive the editor UI and its history |

Derived data (asphalt, junctions, bents, graded terrain, road furniture) is rebuilt after every
call, as it is for edits made by hand.

## Tests

```
npm run test:mcp    # stdio server headless on a scratch copy: every tool, then re-read the saved file
npm run test:app    # desktop app end to end (Playwright Electron) on a scratch copy and port 7399
```
