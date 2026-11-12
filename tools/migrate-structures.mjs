// One-off migration: rail piers and power lines become derived. The baked `rail_pier` buildings go
// (world/rail.js puts piers under raised track), and pylons / poles strung together by cables become
// `powerline` records, one per run of posts between line ends and branch posts (world/power.js
// builds the posts and wires back). Cables that end away from any post stay as they are.
//   node tools/migrate-structures.mjs [in.vspb] [out.vspb]
// Defaults to a new *.structures.vspb file. Existing files are never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeWorld, encodeWorld } from '../format/world.js';
import { buildingCenter } from '../format/transforms.js';

const POST = { pylon: 'tower', pole: 'pole' };
const centre = (b) => buildingCenter(b).slice(0, 2);
const r2 = (v) => Math.round(v * 100) / 100;

export function migrateStructures(doc, reach = 30) {
  if (!Number.isFinite(reach) || reach <= 0) throw new Error('post matching reach must be positive and finite');
  const B = doc.layers.buildings;
  if (!B || !Array.isArray(B.items)) throw new Error('buildings.items is required');
  const posts = B.items.flatMap((b) => (POST[b.type] && b.parts?.length ? [{ b, c: centre(b) }] : [])).map((post, id) => ({ ...post, id }));
  const nearest = (q) => {
    let best = null, bd = reach;
    for (const o of posts) { const d = Math.hypot(o.c[0] - q[0], o.c[1] - q[1]); if (d < bd) { bd = d; best = o; } }
    return best;
  };
  // spans between posts, from the cables strung along them
  const adj = new Map(), used = new Set(), spanCables = new Set();
  for (const cab of B.cables ?? []) {
    if (!Array.isArray(cab) || cab.length < 2) continue;
    const a = nearest(cab[0]), b = nearest(cab[cab.length - 1]);
    if (!a || !b || a === b || a.b.type !== b.b.type) continue;
    spanCables.add(cab);
    for (const [x, y] of [[a, b], [b, a]]) { if (!adj.has(x)) adj.set(x, new Set()); adj.get(x).add(y); }
  }
  // runs of posts: from each end or branch post along posts with two spans
  const lines = [], seen = new Set(), key = (a, b) => a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
  const walk = (start, next) => {
    const run = [start];
    let prev = start, cur = next;
    seen.add(key(start, next));
    for (;;) {
      run.push(cur);
      if (adj.get(cur).size !== 2) break;
      const nx = [...adj.get(cur)].find((o) => o !== prev);
      if (seen.has(key(cur, nx))) break;
      seen.add(key(cur, nx)); prev = cur; cur = nx;
    }
    return run;
  };
  for (const [p, ns] of adj) if (ns.size !== 2) for (const n of ns) if (!seen.has(key(p, n))) lines.push(walk(p, n));
  for (const [p, ns] of adj) for (const n of ns) if (!seen.has(key(p, n))) lines.push(walk(p, n));   // closed rings
  const powerlines = lines.map((run) => {
    for (const o of run) used.add(o.b);
    return { type: POST[run[0].b.type], pts: run.map((o) => [r2(o.c[0]), r2(o.c[1])]) };
  });
  const piers = B.items.filter((b) => b.type === 'rail_pier').length;
  B.items = B.items.filter((b) => b.type !== 'rail_pier' && !used.has(b));
  B.cables = (B.cables ?? []).filter((c) => !spanCables.has(c));
  B.powerlines = [...(B.powerlines ?? []), ...powerlines];
  return { piers, posts: used.size, cables: spanCables.size, powerlines: powerlines.length, keptCables: B.cables.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const src = process.argv[2] ?? 'city/data/vespera.vspb';
  const out = process.argv[3] ?? src.replace(/\.vspb$/i, '') + '.structures.vspb';
  if (path.resolve(src) === path.resolve(out)) throw new Error('migration output must differ from the source file');
  const doc = await decodeWorld(fs.readFileSync(src));
  console.log(migrateStructures(doc));
  fs.writeFileSync(out, await encodeWorld(doc), { flag: 'wx' });
  console.log('wrote', out);
}
