# VSPB — City Labs world binary format (v2.0)

One file holds the whole world (`city/data/vespera.vspb`): terrain, roads, furniture, buildings and
the type registry. The file is the source of truth, and it is edited in the editor (`npm run edit`).
Legacy generator outputs are preserved in `tests/fixtures/legacy/` for road compatibility checks;
`tests/helpers/legacy-world.mjs` reconstructs their source graph for `npm run test:roads`.

Code: `format/vspb.js` (generic codec), `format/world.js` (Vespera layers, column types, default
registry). Works in browsers and Node 24+ (uses `CompressionStream` with raw DEFLATE).

The v2 writer uses the same self-describing container layout and reads all v1 files.
Its major version protects the new local-object and compact-heightfield semantics:
v1 readers refuse v2 files instead of misinterpreting local vertices as world positions.
`meta.documentVersion = 2` separately identifies the city model; `units = 'metres'`
and `upAxis = 'Z'`. Unknown columns, nested fields, layers and ancillary chunks survive
read/write. Readers reject malformed bounds, duplicate tables/columns/map keys,
invalid parent indices, missing END and oversized payloads (512 MiB file/decompressed
budget, one million rows per table). Edited numeric columns widen when necessary.

## Local objects and compact heightfields

A building has `transform: {p:[x,y,z], r:[rx,ry,rz], s:[sx,sy,sz]}`. Rotation uses
Euler XYZ radians; scale components are positive, 0.001–1000. `parts[].p`, holes and
`z` are local coordinates. `format/transforms.js` migrates v1 vertices once around a
local pivot without rounding or changing world positions. Geometry and facade UV
remain local while an instance moves/rotates/scales. Furniture uses authoritative
`p`, yaw `h`, optional `tilt:[rx,ry]`, `scale:[sx,sy,sz]` and `material` override;
prefab geometry is already local. There is no redundant saved matrix.

At runtime, terrain exposes complete `base` and graded `h` arrays. On disk,
Float32 terrain with at most half its cells changed uses
`heightEncoding:'sparse-grade-v1'`, `gradeIndex:u32[]!`, `gradeHeight:f32[]!` in place
of `h`. Indices are strictly increasing; overrides hold absolute heights, so even
signed-zero bits are preserved. Decode copies `base` then applies overrides and
removes the storage-only fields. Dense differences and Float64 source schemas
retain dense `h`, preserving precision. `decodeWorld`, not raw `decode`, expands
the city model. Raw `decode/encode` remains a lossless generic container API.

Derived mesh buffers are not saved. Use `encodeWorld`/`encodeWorldLayer` for compact saving and `decodeWorld`
for loading. Browser working copies use the same encoded layers.

## Compatibility rules

| change | old reader | new reader |
| --- | --- | --- |
| new field (column) on a record | ignores it on read, **keeps it** on re-save | reads it |
| new collection / layer (table) | keeps it as data | reads it |
| new building type, material, zone, prefab… | just data in `defs` | — |
| field missing in an old file | — | field is absent → use a default |
| new ancillary chunk type | skipped and written back unchanged | reads it |
| new critical chunk type | refuses the file | reads it |
| minor version bump | reads | reads |
| major version bump | refuses the file | reads |

A writer may add fields, tables, layers and ancillary chunks freely (minor bump at most). Changing
the meaning of an existing field, or adding a critical chunk, needs a major bump.

Readers access columns **by name**, never by position. A column's type travels with it. When an
edited value no longer fits the stored type (a vec3 that grew a 4th number, a number that became
text), the writer infers a new type, so data is never truncated.

## Layout

All integers are little-endian.

```
header   16 B   "VSPB" · u16 major · u16 minor · u32 flags (0) · u32 reserved (0)
chunk*          4 B tag · u32 flags · u32 raw length · u32 stored length · payload · pad to 8
```

Chunk flags: bit 0 = critical. Bits 8–15 = codec (0 = none, 1 = raw DEFLATE). `raw length` is the
size after inflating.

| tag | content |
| --- | --- |
| `META` | UTF-8 JSON: `{ layers: [...], generator, created, ... }`, free-form |
| `TABL` | one table (below) |
| `END ` | end of file (empty) |

## Tables

A layer object is split into tables:

- `<layer>`: a single row holding the layer's plain properties (mode 2, *props*), e.g. `terrain`
  with `x0, y0, res, nx, ny, h`.
- `<layer>.<field>`: an array of records (mode 0, *rows*), e.g. `buildings.items`.
- `<layer>.<field>`: an object of records (mode 1, *map*), with the key in column `$key`, e.g.
  `roads.classes` or `defs.materials`.
- `<table>.<field>`: a child table for a record field that holds an array of records. Column
  `$parent` holds the parent's row index, e.g. `buildings.items.parts`.

A parent table always comes before its children.

```
TABL payload   str name · str parent · u8 mode · u32 rows · u16 columns · column*
column         str name · u8 base · u8 arity · u8 depth · u8 flags
               [presence bitmap, ceil(rows/8) B, if flags&2]
               depth × ( align 4 · u32 offsets[n+1] )        // list levels
               [str dictionary: u32 count · str*, for str/json]
               u32 value count · align 8 · values             // byte-plane shuffled if flags&4
str            u32 byte length · UTF-8
```

Alignment is relative to the start of the payload. Values are in place for zero-copy typed views.

Base types: 1 u8 · 2 i8 · 3 u16 · 4 i16 · 5 u32 · 6 i32 · 7 f32 · 8 f64 · 9 bool · 10 str
(dictionary-coded) · 11 json (dictionary-coded JSON text).

A type is written like `f32x3[]`: base `f32`, arity 3 (a vec3), depth 1 (a list of vec3). `[][]` is
a list of lists. A trailing `!` (column flag 1) means "decode as a typed array view". It is used for
bulk numeric data such as terrain heights and road mesh buffers.

Column flags: 1 typed, 2 presence bitmap (a row without the bit has no such field), 4 shuffled.

`f32` values decode rounded to 7 significant digits, so `1336.2` reads back as `1336.2`.

## Vespera layers

| layer | contents |
| --- | --- |
| `terrain` | `x0 y0 res nx ny sea_level`, `base: f32[]!` (natural ground, row-major), runtime `h` / sparse graded overrides (above), `bore: u32[]!` (cells inside tunnels) |
| `roads` | `classes` (map: `lanes lane_w shoulder median side corner prio r sigma max_grade k_min oneway`, plus derived `hw hwt`), `nodes {id, p [x,y,z], kind, grad [gx,gy], free?}`, `edges {id, name, cls, n [node, node], trim, pts f32x3[] (4 m apart), elev, tunnel, merge?}` |
| `furniture` | `items {t, p f32x3, h (heading, rad), tilt?, scale?, material?, …per-type extras, owner?}`. `owner` is `e<id>` or `n<id>` for items placed by the road rules. |
| `buildings` | `items {type, zone, transform, detail?, parts[{p f32x2[], holes?, z, h, m, roofMaterial?, trimMaterial?}]}` (local parts); world-space `surfaces {p, holes?, m}`, `trees f32x3[]`, `rails f32x3[][]`, `cables`, `wind f32x4[]`, preserved legacy `trains` (not rendered), `core` |
| `defs` | type registry, below |
| `issues` | generator QA notes (not rendered) |

### Source and derived data

The world builder in `world/` (pure JS, used by the viewer, the editor and Node tools) derives the
following from the road graph and `terrain.base`:

| derived | from | code |
| --- | --- | --- |
| asphalt, curbs, sidewalks, markings, barriers, tunnels, junction pads, transitions | edges, nodes, classes | `world/roadmesh.js` |
| pier bents | elevated edges | `world/roadmesh.js` |
| junction trims (`edges[].trim`) and node kinds (`nodes[].kind`) | arms at each node | `world/roadnet.js` |
| graded terrain `h` and `bore` | `base` and edges | `world/carve.js` |
| roadside furniture with an `owner` | edges, junctions | `world/furniture.js` |
| levels of new or re-profiled roads (`pts[].z`, `elev`, `tunnel`) | natural ground, node levels | `world/profile.js` |

The road mesh is never stored. It is built when the file is loaded, which takes about 0.3 s for the
whole city. Trims, kinds, `h`, `bore` and owned furniture are stored, but `world/roadworld.js`
recomputes them around every edit. If you edit the file by hand, re-save it from the editor
afterwards. Furniture without an `owner` was placed by hand and is never regenerated.

### Type registry (`defs`)

Everything a renderer used to hard-code lives here, so a new type is just a new entry.

| map | entry fields | used for |
| --- | --- | --- |
| `materials` | PBR `color, roughness, metalness, opacity, emissive, emissiveIntensity, facade`; legacy `shininess, specular, glow, nightGlow` preserved | building `m/roofMaterial/trimMaterial`, furniture `material`, prefab parts' `m` |
| `buildingTypes` | `wall` (`office` / `house` / '' = no facade texture) | `items[].type` |
| `zones` | `color` | `items[].zone` |
| `surfaces` | `color, lift` | `surfaces[].m` |
| `furniture` | `parts[{k: box/cyl/ico/cone, s / r / h / seg, at, c}]` | `furniture.items[].t` |
| `roadMaterials` | `color, paint?, unlit?` | `roads.mesh` keys |
| `roadClasses` | `color` | road graph overlay |

An explicit facade style applies independently of building type. The special
`facade:'wall'` resolves the type's wall style. Facades use local wall-distance UVs;
texture caches hold colour, relief and window-emission maps. Prop overrides use
PBR without metre-based facade mapping. Missing references are rejected at command
boundaries. In v1 migration, missing defaults are added; in v2, existing registries
are authoritative and a deliberately deleted unused entry is not resurrected.
Used resources cannot be deleted without first assigning replacements.

## Tools

```
npm run edit        # editor at http://localhost:5199/editor/
npm run view        # viewer
npm run unpack      # vespera.vspb → city/data/unpacked/<layer>.json, for diffing or reading
npm run test:vspb   # format compatibility rules + decode/encode round-trip of the real world
npm run test:roads  # JS road builder vs the generator's last output (tests/fixtures/legacy)
```

In the editor, roads are edited as a graph:

- **Road tool:** click control points. Corners get the class radius. Each end attaches to a nearby
  node, or splits the road it lands on into a T-junction. The new road gets a vertical profile.
- **Vertex drag:** drags the road axis with a soft falloff (the select tool's «мягкость оси»). Moving
  a node bends the roads that end at it.
- **«Профиль по рельефу»:** re-levels a road over the natural ground, pinned to its nodes.
- **Terrain brush:** shapes `base`. The graded `h` follows, so the roads keep their cuts and
  embankments.
