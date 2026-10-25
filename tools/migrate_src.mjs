// One-off migration to the source-only world: the road graph at full resolution plus the natural
// terrain replace the baked road mesh. Heights come from the current world file (the generator's
// level solver is not deterministic, and buildings/furniture were placed on the current levels).
//   node tools/migrate_src.mjs [roads_src.vspb] [world.vspb] [out.vspb]
import fs from 'node:fs';
import { decode } from '../format/vspb.js';
import { encodeWorld, withDefaults } from '../format/world.js';
import { syncClassWidths, buildNet, computeTrims } from '../world/roadnet.js';
import { allFurniture } from '../world/furniture.js';
import { carveRegion } from '../world/carve.js';
import { cumLength, interp } from '../world/geom.js';

export function migrate(src, doc) {
  const old = doc.layers.roads, oldById = new Map(old.edges.map((e) => [e.id, e]));
  const classes = structuredClone(src.classes);
  syncClassWidths(classes);
  const nodes = src.nodes.map((n) => ({ id: n.id, p: n.p, kind: n.kind, grad: n.grad, ...(n.free ? { free: true } : {}) }));
  const edges = src.edges.map((e) => {
    const o = oldById.get(e.id), m = e.pts.length;
    const pts = e.pts.map((p) => [p[0], p[1], p[2]]);
    let elev = e.elev.slice(), tunnel = e.tunnel.slice();
    if (o && o.cls === e.cls) {
      // old samples sit on every 2nd source sample (plus the last one): carry their levels across
      const s = cumLength(pts), at = o.pts.map((_, i) => Math.min(2 * i, m - 1));
      const so = at.map((j) => s[j]), zo = o.pts.map((p) => p[2]);
      for (let j = 0; j < m; j++) pts[j][2] = Math.round(interp(s[j], so, zo) * 1000) / 1000;
      const flag = (src, oldf) => src.map((v, j) => {
        const a = Math.floor(j / 2), b = Math.min(Math.ceil(j / 2), oldf.length - 1);
        return oldf[a] === oldf[b] ? oldf[a] : v;
      });
      elev = flag(elev, o.elev); tunnel = flag(tunnel, o.tunnel);
    }
    return { id: e.id, name: e.name, cls: e.cls, n: e.n, trim: e.trim, pts, elev, tunnel, ...(e.merge.some(Boolean) ? { merge: e.merge } : {}) };
  });
  doc.layers.roads = { layer: 'roads', classes, nodes, edges };
  doc.layers.terrain.base = Float32Array.from(src.terrain_base);
  // roadside furniture: the generated set, owned by its road, replaces the identical exported items;
  // whatever the rules no longer produce stays as hand-placed
  // junction trims as the JS builder computes them (the generator's included roads it never exported)
  const net = buildNet(doc.layers.roads);
  computeTrims(net);
  const gen = allFurniture(net), H = new Map();
  for (const g of gen) { const k = g.t + '|' + Math.round(g.p[0]) + '|' + Math.round(g.p[1]); (H.get(k) ?? H.set(k, []).get(k)).push(g); }
  const manual = [];
  for (const o of doc.layers.furniture.items) {
    let best = null, bd = 0.5;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const g of H.get(o.t + '|' + (Math.round(o.p[0]) + dx) + '|' + (Math.round(o.p[1]) + dy)) ?? []) {
      const d = Math.hypot(g.p[0] - o.p[0], g.p[1] - o.p[1]);
      if (d < bd && !g.taken) { bd = d; best = g; }
    }
    if (best) best.taken = true; else manual.push(o);
  }
  for (const g of gen) delete g.taken;
  doc.layers.furniture.items = [...gen, ...manual];
  // terrain graded by the JS builder from the natural ground, so later edits regrade consistently
  const t = doc.layers.terrain;
  t.h = new Float32Array(t.h.length);
  t.bore = Uint32Array.from(carveRegion(t, net));
  console.log(`furniture: ${gen.length} owned by roads, ${manual.length} hand-placed`);
  if (doc.schema) {
    for (const k of Object.keys(doc.schema.hints)) if (k.startsWith('roads.')) delete doc.schema.hints[k];
    delete doc.schema.kinds['roads.mesh'];
  }
  return doc;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [srcPath = 'city/data/legacy/roads_src.vspb', inPath = 'city/data/legacy/vespera-generator.vspb', outPath = 'city/data/vespera.vspb'] = process.argv.slice(2);
  const src = (await decode(fs.readFileSync(srcPath))).layers.roads_src;
  const doc = migrate(src, withDefaults(await decode(fs.readFileSync(inPath))));
  const buf = await encodeWorld(doc);
  fs.writeFileSync(outPath, buf);
  console.log(`${outPath} ${(buf.length / 1e6).toFixed(1)} MB`);
}
