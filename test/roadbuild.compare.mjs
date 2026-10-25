// Compare the JS road builder + terrain grading with the generator's output in the pre-migration world.
//   node test/roadbuild.compare.mjs
import fs from 'node:fs';
import { decode } from '../format/vspb.js';
import { migrate } from '../tools/migrate_src.mjs';
import { buildNet, groundSampler } from '../world/roadnet.js';
import { buildRoadMesh, mergeBufs } from '../world/roadmesh.js';
import { carveRegion } from '../world/carve.js';

const oldDoc = await decode(fs.readFileSync(process.argv[2] ?? 'city/data/legacy/vespera-generator.vspb'));
const oldMesh = oldDoc.layers.roads.mesh, oldH = Float32Array.from(oldDoc.layers.terrain.h);
const doc = migrate((await decode(fs.readFileSync('city/data/legacy/roads_src.vspb'))).layers.roads_src, oldDoc);
const t0 = performance.now();
const net = buildNet(doc.layers.roads);
const ground = groundSampler(doc.layers.terrain);
const built = buildRoadMesh(net, ground);
const mesh = mergeBufs([...built.edges.values(), built.bents, ...built.nodes.values()]);
console.log(`road mesh built in ${(performance.now() - t0).toFixed(0)} ms`);
// per material: triangles and how many new vertices land on an old vertex (5 cm grid)
for (const mat of new Set([...Object.keys(oldMesh), ...Object.keys(mesh)])) {
  const a = oldMesh[mat], b = mesh[mat];
  const ta = a ? a.i.length / 3 : 0, tb = b ? b.i.length / 3 : 0;
  let hit = 0, tot = 0;
  if (a && b) {
    const H = new Set();
    for (let k = 0; k < a.v.length; k += 3) for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1])
      H.add(`${Math.round(a.v[k] * 10) + dx},${Math.round(a.v[k + 1] * 10) + dy}`);
    for (let k = 0; k < b.v.length; k += 3) { tot++; if (H.has(`${Math.round(b.v[k] * 10)},${Math.round(b.v[k + 1] * 10)}`)) hit++; }
  }
  console.log(mat.padEnd(13), 'tris py', String(ta).padStart(7), 'js', String(tb).padStart(7), `(${((tb / Math.max(ta, 1) - 1) * 100).toFixed(1)}%)`,
    ' xy match', tot ? (hit / tot * 100).toFixed(1) + '%' : '-');
}
// terrain grading
const T = doc.layers.terrain;
T.h = new Float32Array(T.h.length);
const t1 = performance.now();
const bore = carveRegion(T, net);
console.log(`terrain graded in ${(performance.now() - t1).toFixed(0)} ms, bore ${bore.length} (py ${oldDoc.layers.terrain.bore?.length ?? '?'})`);
const diffs = [];
for (let k = 0; k < oldH.length; k++) diffs.push(Math.abs(T.h[k] - oldH[k]));
diffs.sort((x, y) => x - y);
const q = (f) => diffs[Math.floor(f * (diffs.length - 1))].toFixed(3);
console.log('terrain |dh| p50', q(0.5), 'p99', q(0.99), 'p999', q(0.999), 'max', q(1), ' cells >0.5m', diffs.filter((d) => d > 0.5).length);
if (process.env.WHERE) {
  for (let k = 0; k < oldH.length; k++) if (Math.abs(T.h[k] - oldH[k]) > 0.5) {
    const i = k % T.nx, j = (k / T.nx) | 0;
    console.log('cell', (T.x0 + i * T.res).toFixed(0), (T.y0 + j * T.res).toFixed(0), 'py', oldH[k].toFixed(2), 'js', T.h[k].toFixed(2), 'base', T.base[k].toFixed(2));
  }
}
