// MCP tools over a Vespera world, written against an abstract session so the same code runs in
// the editor (edits go through its undo history and show live) and headless on a file (Node).
// Session interface:
//   doc, kinds, natural(x,y), graded(x,y), info()
//   edit(kind, rec, fn, label)   insert(kind, rec, label)   remove(kind, rec, label)
//   roadTx(tx, label)            terrain(box, fn(base), label)   setDef(group, name, value|null)
//   save() -> { file }
//   app only: view(args), select(kind, rec), undo(), redo()
// Tool schemas are functions of zod so this module itself needs no dependency.
import { addRoad, reprofile, deleteEdge, deleteNode } from '../editor/roadedit.js';
import { renderMap, encodePng, MAP_LAYERS } from './map.js';
import { t } from '../editor/i18n.js';
import { runScript, SCRIPT_API } from './script.js';
import { runGenerator, describeGenerators } from './generators.js';

const KIND_DOC = `Record kinds and their shape:
- building: {type, zone, parts:[{p:[[x,y],...] outline, holes?, z base height, h height, m material}]} (no id, addressed by index)
- surface: ground patch {p:[[x,y],...], holes?, m surface material}
- furniture: {t prefab, p:[x,y,z], h heading rad, owner?} — owner 'e<id>'/'n<id>' marks items the road rules place (regenerated when that road changes)
- tree: [x,y,z]; wind: wind turbine [x,y,z,0]; train: {pts, closed}
- rail: railway track polyline [[x,y,z],...] (z = track level; where it runs >2.5 m above the ground, piers and a viaduct girder are derived)
- powerline: {type: 'tower' | 'pole', pts: [[x,y],...]} — one point per post (towers ~320 m apart, poles ~50 m); posts stand on the ground, wires are derived
- edge: road {id, name, cls, n:[node,node], pts:[[x,y,z],...] 4 m apart, elev[], tunnel[], trim (derived)}
- node: road junction {id, p:[x,y,z], kind (derived), grad}
Coordinates are metres, Z up, the map spans about ±4600 m. Asphalt, markings, junction pads, pier bents, rail
piers, power line posts and wires, the graded terrain and owned furniture are derived and rebuilt automatically after every change.`;

const KINDS_ENUM = ['building', 'surface', 'furniture', 'tree', 'wind', 'rail', 'train', 'powerline', 'edge', 'node'];

// ---------------------------------------------------------------- helpers
function list(s, kind) {
  const K = s.kinds[kind];
  if (!K) throw new Error(`unknown kind '${kind}', expected one of ${KINDS_ENUM.join(', ')}`);
  return K.list(s.doc.layers) ?? [];
}
function resolve(s, ref) {
  const arr = list(s, ref.kind);
  let rec;
  if (ref.id !== undefined) rec = arr.find((r) => r.id === ref.id);
  else if (ref.index !== undefined) rec = arr[ref.index];
  if (!rec) throw new Error(`${ref.kind} ${ref.id !== undefined ? 'id ' + ref.id : 'index ' + ref.index} not found`);
  return rec;
}
const round = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
function summary(s, kind, rec, index) {
  const K = s.kinds[kind], c = K.center(rec);
  const out = { kind, index, title: K.title(rec), center: c.map(round) };
  if (rec.id !== undefined) out.id = rec.id;
  return out;
}
const matches = (v, cond) => {
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    if ('contains' in cond) return String(v ?? '').toLowerCase().includes(String(cond.contains).toLowerCase());
    if ('in' in cond) return cond.in.includes(v);
    if ('min' in cond || 'max' in cond) return typeof v === 'number' && v >= (cond.min ?? -Infinity) && v <= (cond.max ?? Infinity);
  }
  return v === cond;
};

// ---------------------------------------------------------------- tools
const ref = (z) => ({
  kind: z.enum(KINDS_ENUM).describe('record kind'),
  index: z.number().int().optional().describe('position in its list (buildings, surfaces, furniture, trees…)'),
  id: z.number().int().optional().describe('id for edge / node'),
});

export const TOOLS = [
  {
    name: 'world_info', title: 'World overview',
    description: 'Overview of the open world: file, unsaved state, record counts per kind, map extent, registry sizes. Start here.\n\n' + KIND_DOC,
    schema: () => ({}),
    run(s) {
      const L = s.doc.layers, ter = L.terrain;
      return { ...s.info(), counts: Object.fromEntries(KINDS_ENUM.map((k) => [k, list(s, k).length])),
        terrain: ter && { x0: ter.x0, y0: ter.y0, x1: ter.x0 + (ter.nx - 1) * ter.res, y1: ter.y0 + (ter.ny - 1) * ter.res, res: ter.res },
        registry: Object.fromEntries(Object.entries(L.defs ?? {}).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, Object.keys(v).length])),
        roadClasses: Object.keys(L.roads?.classes ?? {}) };
    },
  },
  {
    name: 'list_types', title: 'Type registry',
    description: 'Entries of the type registry: materials (building part `m`), buildingTypes (`type`), zones, surfaces (surface `m`), furniture prefabs (`t`), roadMaterials, roadClasses, and road classes with their lane/width parameters (group "roads.classes"). Without a group: the names in every group.',
    schema: (z) => ({ group: z.string().optional().describe('materials | buildingTypes | zones | surfaces | furniture | roadMaterials | roadClasses | roads.classes') }),
    run(s, { group }) {
      const L = s.doc.layers;
      if (group === 'roads.classes') return L.roads?.classes ?? {};
      if (group) { const g = L.defs?.[group]; if (!g) throw new Error(`no registry group '${group}'`); return g; }
      const out = Object.fromEntries(Object.entries(L.defs ?? {}).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, Object.keys(v)]));
      out['roads.classes'] = Object.keys(L.roads?.classes ?? {});
      return out;
    },
  },
  {
    name: 'find', title: 'Find records',
    description: 'Search records of one kind. `where` matches top-level fields: a value for equality, {contains:"txt"}, {in:[...]}, or {min,max}. `near` keeps records whose centre is within r metres of (x,y); `bbox` = [x0,y0,x1,y1]. Returns summaries (kind, index/id, title, centre) — use get for the full record.',
    schema: (z) => ({
      kind: z.enum(KINDS_ENUM),
      where: z.record(z.string(), z.any()).optional(),
      near: z.object({ x: z.number(), y: z.number(), r: z.number() }).optional(),
      bbox: z.array(z.number()).length(4).optional(),
      limit: z.number().int().optional().describe('default 50'), offset: z.number().int().optional(),
    }),
    run(s, { kind, where, near, bbox, limit = 50, offset = 0 }) {
      const K = s.kinds[kind], out = [];
      list(s, kind).forEach((rec, i) => {
        if (where && (Array.isArray(rec) || !Object.entries(where).every(([k, c]) => matches(rec[k], c)))) return;
        if (near || bbox) {
          const [x, y] = K.center(rec);
          if (near && Math.hypot(x - near.x, y - near.y) > near.r) return;
          if (bbox && (x < bbox[0] || y < bbox[1] || x > bbox[2] || y > bbox[3])) return;
        }
        out.push(i);
      });
      return { total: out.length, items: out.slice(offset, offset + limit).map((i) => summary(s, kind, list(s, kind)[i], i)) };
    },
  },
  {
    name: 'get', title: 'Get a record',
    description: 'Full record of one kind by index (or id for edge/node).',
    schema: (z) => ref(z),
    run(s, a) { const rec = resolve(s, a); return { ...summary(s, a.kind, rec, list(s, a.kind).indexOf(rec)), record: rec }; },
  },
  {
    name: 'update', title: 'Update a record',
    description: 'Change fields of a record: `set` merges top-level fields (give whole arrays, e.g. a building\'s `parts`), `unset` removes fields, `value` replaces an array record (tree, wind, rail) entirely. Unknown fields are kept in the file. For roads, change pts / cls / name here; derived geometry follows.',
    schema: (z) => ({ ...ref(z), set: z.record(z.string(), z.any()).optional(), unset: z.array(z.string()).optional(), value: z.any().optional() }),
    run(s, a) {
      const rec = resolve(s, a);
      s.edit(a.kind, rec, (r) => {
        if (a.value !== undefined) { if (!Array.isArray(r)) throw new Error('value replaces array records only; use set'); r.length = 0; r.push(...a.value); }
        if (a.set) { if (Array.isArray(r)) throw new Error('this kind is an array record; use value'); Object.assign(r, structuredClone(a.set)); }
        for (const k of a.unset ?? []) delete r[k];
      }, t('mcp.edit', { what: s.kinds[a.kind].label }));
      return summary(s, a.kind, rec, list(s, a.kind).indexOf(rec));
    },
  },
  {
    name: 'create', title: 'Create a record',
    description: 'Add a record of a kind (see world_info for shapes). Roads are created with road_add, not here. Heights: use terrain_sample to put things on the ground.',
    schema: (z) => ({ kind: z.enum(KINDS_ENUM.filter((k) => k !== 'edge' && k !== 'node')), record: z.any() }),
    run(s, { kind, record }) {
      if (kind === 'building' && !(record?.parts?.length)) throw new Error('a building needs parts: [{p, z, h, m}]');
      if ((kind === 'surface') && !(record?.p?.length >= 3)) throw new Error('a surface needs an outline p of 3+ points');
      if (kind === 'powerline' && !(record?.pts?.length >= 2)) throw new Error("a power line needs pts: [[x,y],...] with 2+ posts and type 'tower' or 'pole'");
      const rec = structuredClone(record);
      s.insert(kind, rec, t('mcp.create', { what: s.kinds[kind].label }));
      return summary(s, kind, rec, list(s, kind).indexOf(rec));
    },
  },
  {
    name: 'delete', title: 'Delete a record',
    description: 'Remove a record. Deleting a node removes the roads attached to it; nodes left without roads go too.',
    schema: (z) => ref(z),
    run(s, a) {
      const rec = resolve(s, a);
      if (a.kind === 'edge') s.roadTx(deleteEdge(s.doc, rec), t('mcp.deleteRoad'));
      else if (a.kind === 'node') s.roadTx(deleteNode(s.doc, rec), t('mcp.deleteNode'));
      else s.remove(a.kind, rec, t('mcp.delete', { what: s.kinds[a.kind].label }));
      return { deleted: true };
    },
  },
  {
    name: 'transform', title: 'Move / rotate a record',
    description: 'Move a record by (dx, dy, dz) metres and/or rotate it about its centre (buildings, surfaces, furniture). ground:true sets buildings / furniture / trees / turbines onto the graded terrain afterwards. Moving a node bends the roads that end at it; moving a road moves its nodes.',
    schema: (z) => ({ ...ref(z), dx: z.number().optional(), dy: z.number().optional(), dz: z.number().optional(), rotate_deg: z.number().optional(), ground: z.boolean().optional() }),
    run(s, a) {
      const rec = resolve(s, a), K = s.kinds[a.kind];
      s.edit(a.kind, rec, (r) => {
        if (a.dx || a.dy || a.dz) K.move(r, a.dx ?? 0, a.dy ?? 0, a.dz ?? 0, s.doc.layers);
        if (a.rotate_deg) { if (!K.rotate) throw new Error(`${a.kind} cannot rotate`); const [cx, cy] = K.center(r); K.rotate(r, (a.rotate_deg * Math.PI) / 180, cx, cy); }
        if (a.ground && ['building', 'furniture', 'tree', 'wind'].includes(a.kind)) { const [x, y, z] = K.center(r); K.move(r, 0, 0, Math.max(s.graded(x, y), 0) - z, s.doc.layers); }
      }, t('mcp.move', { what: K.label }));
      return summary(s, a.kind, rec, list(s, a.kind).indexOf(rec));
    },
  },
  {
    name: 'road_add', title: 'Lay a new road',
    description: 'Lay a road through control points [[x,y],...] (corners rounded with the class radius, resampled every 4 m). Each end attaches to a node within ~15 m, or splits a road it lands on into a T-junction, or gets a new end node. The road gets a vertical profile over the natural ground; asphalt, junction pads, lamps and terrain grading follow. cls: a key of roads.classes (street, avenue, boulevard, lane, rural, mountain, industrial, fw12, fw13, ramp1…).',
    schema: (z) => ({ points: z.array(z.array(z.number()).min(2)).min(2), cls: z.string(), name: z.string().optional() }),
    run(s, { points, cls, name }) {
      if (!s.doc.layers.roads?.classes?.[cls]) throw new Error(`unknown road class '${cls}'`);
      const res = addRoad(s.doc, s.natural, points, cls, name ?? '');
      if (!res) throw new Error('could not lay the road (too short, or both ends on one node)');
      s.roadTx(res.tx, t('mcp.newRoad'));
      const e = res.edge;
      return { id: e.id, name: e.name, nodes: e.n, points: e.pts.length, length_m: Math.round((e.pts.length - 1) * 4) };
    },
  },
  {
    name: 'road_reprofile', title: 'Re-level a road',
    description: 'Recompute a road\'s heights over the natural ground, pinned to its end nodes; bridges (elev) where it runs >3 m above ground, tunnels where >7.5 m below for 80+ m.',
    schema: (z) => ({ id: z.number().int() }),
    run(s, { id }) {
      const rec = resolve(s, { kind: 'edge', id });
      s.edit('edge', rec, (r) => reprofile(s.doc, s.natural, r), t('mcp.profile'));
      return { id, z: [rec.pts[0][2], rec.pts[rec.pts.length - 1][2]], bridges: rec.elev.filter(Boolean).length, tunnel: rec.tunnel.filter(Boolean).length };
    },
  },
  {
    name: 'terrain_sample', title: 'Sample terrain heights',
    description: 'Heights at points: natural ground and the ground graded to the roads (what you see). Water level is 0.',
    schema: (z) => ({ points: z.array(z.array(z.number()).min(2)).min(1).max(2000) }),
    run(s, { points }) {
      return points.map(([x, y]) => ({ x, y, natural: round(s.natural(x, y)), graded: round(s.graded(x, y)) }));
    },
  },
  {
    name: 'terrain_edit', title: 'Shape the terrain',
    description: 'Shape the natural ground in a circle (smooth falloff): raise / lower by `amount` metres at the centre, flatten towards `height` (default: the centre\'s height) with strength amount 0..1, or smooth with `amount` passes. Roads keep their cuts and embankments.',
    schema: (z) => ({ x: z.number(), y: z.number(), radius: z.number().positive(), mode: z.enum(['raise', 'lower', 'flatten', 'smooth']), amount: z.number(), height: z.number().optional() }),
    run(s, { x, y, radius, mode, amount, height }) {
      const ter = s.doc.layers.terrain;
      if (!ter) throw new Error('no terrain');
      const rc = radius / ter.res, ci = (x - ter.x0) / ter.res, cj = (y - ter.y0) / ter.res;
      const box = [Math.max(1, Math.floor(ci - rc)), Math.max(1, Math.floor(cj - rc)), Math.min(ter.nx - 2, Math.ceil(ci + rc)), Math.min(ter.ny - 2, Math.ceil(cj + rc))];
      const target = height ?? s.natural(x, y);
      s.terrain(box, (h) => {
        const passes = mode === 'smooth' ? Math.max(1, Math.round(amount)) : 1;
        for (let p = 0; p < passes; p++) for (let j = box[1]; j <= box[3]; j++) for (let i = box[0]; i <= box[2]; i++) {
          const d = Math.hypot(i - ci, j - cj) / rc;
          if (d >= 1) continue;
          const w = (1 - d * d) ** 2, k = j * ter.nx + i;
          if (mode === 'raise') h[k] += amount * w;
          else if (mode === 'lower') h[k] -= amount * w;
          else if (mode === 'flatten') h[k] += (target - h[k]) * Math.min(1, amount) * w;
          else h[k] += ((h[k - 1] + h[k + 1] + h[k - ter.nx] + h[k + ter.nx]) / 4 - h[k]) * w;
        }
      }, t('mcp.terrain', { mode }));
      return { box, natural_at_centre: round(s.natural(x, y)), graded_at_centre: round(s.graded(x, y)) };
    },
  },
  {
    name: 'def_set', title: 'Set a registry entry',
    description: 'Create or replace a type registry entry (value object), or delete it (value null). Groups: materials {color "#rrggbb", shininess, specular, glow, nightGlow, facade wall|curtain|brick|ribs|""}, buildingTypes {wall office|house|""}, zones {color}, surfaces {color, lift}, furniture {parts:[{k box|cyl|ico|cone, s:[w,d,h] | r, h, at:[x,y,z], c "#rrggbb"}]}, roadMaterials {color}, roadClasses {color}, roads.classes {lanes, lane_w, shoulder, median, side, corner, prio, r, sigma, max_grade, k_min, oneway}.',
    schema: (z) => ({ group: z.string(), name: z.string(), value: z.any().nullable() }),
    run(s, { group, name, value }) { s.setDef(group, name, value === null ? null : structuredClone(value)); return { group, name, deleted: value === null }; },
  },
  {
    name: 'new_world', title: 'Start a new empty map',
    description: 'Replace the open world with a new empty map: flat land of width_m × depth_m metres (250–64000; `size_m` sets both) at `ground` metres, no roads or buildings, the default type registry. The grid step is res_m, or chosen automatically to keep the heightfield within ~4 M cells. Refused while there are unsaved changes unless force is true. Follow with generate (terrain, streets, buildings, trees) to fill it.',
    schema: (z) => ({ size_m: z.number().min(250).max(64000).optional(), width_m: z.number().min(250).max(64000).optional(), depth_m: z.number().min(250).max(64000).optional(),
      res_m: z.number().positive().optional(), ground: z.number().optional(), force: z.boolean().optional() }),
    run(s, a) {
      const width = a.width_m ?? a.size_m ?? 4000, depth = a.depth_m ?? a.size_m ?? width;
      s.newWorld({ width, depth, res: a.res_m ?? 'auto', ground: a.ground ?? 10 }, !!a.force);
      const t0 = s.doc.layers.terrain;
      return { width_m: width, depth_m: depth, res_m: t0.res, cells: t0.nx * t0.ny, ...s.info() };
    },
  },
  {
    name: 'map', title: 'Map of an area',
    description: 'Top-down map image of an area, rendered from the data (no app needed): shaded terrain, water, ground patches, roads (dark edge = bridge, dashed = tunnel), junctions, buildings coloured by material, rails, trees, a coordinate grid labelled in metres and numbered markers on the longest visible roads. Give center [x,y] + size_m (default 2000) or bbox [x0,y0,x1,y1]; with neither, the whole map. The text part maps marker numbers to road ids/names and gives the scale. Use it to look around, find places and check edits.',
    schema: (z) => ({
      center: z.array(z.number()).length(2).optional(), size_m: z.number().positive().optional(),
      bbox: z.array(z.number()).length(4).optional(), width: z.number().int().min(128).max(2048).optional().describe('pixels, default 1024'),
      layers: z.array(z.enum(MAP_LAYERS)).optional().describe('default: all but furniture'),
      highlight: z.array(z.object(ref(z))).optional().describe('records to outline in magenta'),
    }),
    async run(s, a) {
      let bbox = a.bbox;
      const ter = s.doc.layers.terrain;
      if (!bbox && !a.center && ter) bbox = [ter.x0, ter.y0, ter.x0 + (ter.nx - 1) * ter.res, ter.y0 + (ter.ny - 1) * ter.res];   // the whole map
      if (!bbox) { const c = a.center ?? [0, 0], half = (a.size_m ?? 2000) / 2; bbox = [c[0] - half, c[1] - half, c[0] + half, c[1] + half]; }
      if (!(bbox[2] > bbox[0] && bbox[3] > bbox[1])) throw new Error('bbox must be [x0, y0, x1, y1] with x1 > x0, y1 > y0');
      const highlight = (a.highlight ?? []).map((r) => ({ kind: r.kind, rec: resolve(s, r) }));
      const m = renderMap(s.doc, { bbox, width: a.width ?? 1024, layers: a.layers, highlight, graded: s.graded, kinds: s.kinds });
      return { image: await encodePng(m.rgba, m.width, m.height), text: JSON.stringify(m.legend) };
    },
  },
  {
    name: 'run_script', title: 'Run a script on the world',
    description: 'Run JavaScript against the world for queries over many records and bulk edits. `code` is the body of an async function (world, args); return a JSON-serialisable value. All edits of one run are one undo step, and derived geometry is rebuilt once at the end.\n\n' + SCRIPT_API,
    schema: (z) => ({ code: z.string(), args: z.any().optional(), label: z.string().optional().describe('undo label') }),
    async run(s, a) {
      const r = await runScript(s, a.code, a.args, a.label ?? t('mcp.script'), (ss, t) => TOOL_BY_NAME.terrain_edit.run(ss, t));
      return { ...r, result: r.result === undefined ? null : JSON.parse(r.result.endsWith('(cut at 200 KB)') ? JSON.stringify(r.result) : r.result) };
    },
  },
  {
    name: 'generate', title: 'Run a generator',
    description: 'Run a standard generator with parameters; the whole result is one undo step. Omitted parameters take their defaults; cx/cy are the centre of the area in metres. Generators:\n' + describeGenerators(),
    schema: (z) => ({ id: z.enum(['terrain', 'streets', 'buildings', 'trees']), params: z.record(z.string(), z.any()).optional() }),
    async run(s, a) { return runGenerator(s, a.id, a.params ?? {}, t('gen.undo', { name: t(`gen.${a.id}`) })); },
  },
  {
    name: 'save', title: 'Save the world file',
    description: 'Write the world to its .vspb file.',
    schema: () => ({}),
    async run(s) { return await s.save(); },
  },
  // ---- editor app only
  {
    name: 'screenshot', title: 'Screenshot the editor view', app: true,
    description: 'Render the editor\'s 3D view and return it as an image. Optionally aim the camera first: camera [x,y,z] + target [x,y,z], or focus on a record (ref). Requires the Vespera Editor app (npm run app).',
    schema: (z) => ({ camera: z.array(z.number()).length(3).optional(), target: z.array(z.number()).length(3).optional(),
      focus: z.object(ref(z)).optional(), width: z.number().int().optional().describe('downscale to this width') }),
    run(s, a) { return s.view(a); },
  },
  {
    name: 'select', title: 'Select in the editor', app: true,
    description: 'Select a record in the editor UI (shows its outline and properties) and focus the camera on it.',
    schema: (z) => ref(z),
    run(s, a) { const rec = resolve(s, a); s.select(a.kind, rec); return summary(s, a.kind, rec, list(s, a.kind).indexOf(rec)); },
  },
  {
    name: 'undo', title: 'Undo', app: true, description: 'Undo the last edit in the editor (MCP edits are in the same history).',
    schema: () => ({}), run(s) { return s.undo(); },
  },
  {
    name: 'redo', title: 'Redo', app: true, description: 'Redo the last undone edit in the editor.',
    schema: () => ({}), run(s) { return s.redo(); },
  },
];

export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** Run a tool and shape the MCP result content. */
export async function runTool(session, name, args = {}) {
  const tool = TOOL_BY_NAME[name];
  if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  try {
    const r = await tool.run(session, args);
    if (r?.image) return { content: [{ type: 'image', data: r.image, mimeType: 'image/png' }, ...(r.text ? [{ type: 'text', text: r.text }] : [])] };
    return { content: [{ type: 'text', text: JSON.stringify(r ?? { ok: true }, null, 1) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] };
  }
}
