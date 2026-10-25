// Scripts over the world: an async function body run with a small API, for queries across many
// records and bulk edits. Used by the MCP tool `run_script` and by the editor's Script tab.
// All edits of a run go through session.batch(): one undo step, derived data rebuilt once.
import { addRoad, reprofile, deleteEdge, deleteNode } from '../editor/roadedit.js';

export const SCRIPT_API = `The world API:
- world.layers: the raw data (terrain, roads, buildings, furniture, defs, …)
- world.list(kind): the records of a kind (building, surface, furniture, tree, wind, rail, train, edge, node)
- world.find(kind, pred?): [{ index, rec }] where pred(rec, index) is true
- world.get(kind, index | id), world.center(kind, rec): [x, y, z]
- world.edit(kind, rec, fn): fn(rec) mutates the record (undoable); derived geometry follows
- world.create(kind, rec): the new record; world.remove(kind, rec)
- world.move(kind, rec, dx, dy, dz = 0), world.rotate(kind, rec, degrees)
- world.addRoad(points, cls, name?): the new edge; world.reprofile(edgeId)
- world.terrain({ x, y, radius, mode: 'raise' | 'lower' | 'flatten' | 'smooth', amount, height? })
- world.shapeTerrain((base, t) => { … }, box?): edit natural heights base[j * t.nx + i] directly (t.x0, t.y0, t.res, t.nx, t.ny)
- world.setDef(group, name, value | null), world.natural(x, y), world.graded(x, y)
- world.log(...values): collected into the output
Example: grow every downtown tower by 10 %
  const t = world.find('building', (b) => b.type === 'tower' && b.zone === 'downtown');
  for (const { rec } of t) world.edit('building', rec, (b) => b.parts.forEach((p) => { p.h *= 1.1; }));
  return t.length;`;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const clip = (v) => {
  const s = JSON.stringify(v ?? null, (k, x) => (ArrayBuffer.isView(x) ? `${x.constructor.name}(${x.length})` : x));
  return s && s.length > 200000 ? s.slice(0, 200000) + '… (cut at 200 KB)' : s;
};

/** The world API over a session (scripts and generators). counter.edits counts the edits made through it. */
export function makeWorld(s, label, logs = [], counter = { edits: 0 }, terrainEdit = null) {
  const kinds = s.kinds, L = () => s.doc.layers;
  let edits = 0;
  const bump = () => { edits++; counter.edits = edits; };
  const list = (kind) => { const K = kinds[kind]; if (!K) throw new Error(`unknown kind ${kind}`); return K.list(L()) ?? []; };
  const world = {
    get layers() { return L(); },
    list,
    find: (kind, pred = () => true) => list(kind).map((rec, index) => ({ index, rec })).filter(({ rec, index }) => pred(rec, index)),
    get: (kind, key) => (kind === 'edge' || kind === 'node' ? list(kind).find((r) => r.id === key) : list(kind)[key]),
    center: (kind, rec) => kinds[kind].center(rec),
    edit: (kind, rec, fn) => { bump(); s.edit(kind, rec, fn, label); return rec; },
    create: (kind, rec) => { if (kind === 'edge' || kind === 'node') throw new Error('roads: use world.addRoad'); bump(); s.insert(kind, rec, label); return rec; },
    remove: (kind, rec) => {
      bump();
      if (kind === 'edge') s.roadTx(deleteEdge(s.doc, rec), label);
      else if (kind === 'node') s.roadTx(deleteNode(s.doc, rec), label);
      else s.remove(kind, rec, label);
    },
    move: (kind, rec, dx, dy, dz = 0) => world.edit(kind, rec, (r) => kinds[kind].move(r, dx, dy, dz, L())),
    rotate: (kind, rec, deg) => world.edit(kind, rec, (r) => { const [cx, cy] = kinds[kind].center(r); kinds[kind].rotate(r, (deg * Math.PI) / 180, cx, cy); }),
    addRoad: (points, cls, name = '') => {
      const res = addRoad(s.doc, s.natural, points, cls, name);
      if (!res) throw new Error('could not lay the road');
      bump(); s.roadTx(res.tx, label);
      return res.edge;
    },
    reprofile: (id) => world.edit('edge', list('edge').find((e) => e.id === id), (r) => reprofile(s.doc, s.natural, r)),
    terrain: (a) => { if (!terrainEdit) throw new Error('terrain editing is not available here'); bump(); return terrainEdit(s, a); },
    /** Reshape the natural ground directly: fn(base, terrain) mutates base heights in cells box [i0, j0, i1, j1] (default all). */
    shapeTerrain: (fn, box) => {
      const t = L().terrain;
      if (!t) throw new Error('no terrain');
      bump();
      s.terrain(box ?? [0, 0, t.nx - 1, t.ny - 1], (base) => fn(base, t), label);
    },
    setDef: (group, name, value) => { bump(); s.setDef(group, name, value); },
    natural: (x, y) => s.natural(x, y),
    graded: (x, y) => s.graded(x, y),
    log: (...v) => { logs.push(v.map((x) => (typeof x === 'string' ? x : clip(x))).join(' ')); },
  };
  return world;
}

/** Run `code` (an async function body over (world, args)). Returns { result (JSON text), logs, edits, ms }. */
export async function runScript(s, code, args, label = 'script', terrainEdit = null) {
  const logs = [], counter = { edits: 0 };
  const world = makeWorld(s, label, logs, counter, terrainEdit);
  const t0 = Date.now();
  let fn;
  try { fn = new AsyncFunction('world', 'args', code); } catch (e) { throw new Error(`syntax error: ${e.message}`); }
  let result;
  try {
    await s.batch(label, async () => { result = await fn(world, args); });
  } catch (e) {
    const err = new Error(`${e?.stack ?? e}${logs.length ? '\nlog:\n' + logs.join('\n') : ''}${counter.edits ? `\n${counter.edits} edit(s) before the error were applied` : ''}`);
    throw err;
  }
  return { result: clip(result), logs, edits: counter.edits, ms: Date.now() - t0 };
}
