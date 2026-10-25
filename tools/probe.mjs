// Physical road probe: node tools/probe.mjs — raycasts down along every lane, reports what the wheels would hit.
import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'fs';
import { buildWorld } from '../viewer/sim.js';
import { loadNodeWorld } from './load.mjs';
await RAPIER.init();
const { roads, terrain } = await loadNodeWorld();
const world = buildWorld(RAPIER, roads, terrain);
world.step();
const names = new Map([...world.names].map(([h, n]) => [h, n]));
const hitName = h => names.get(h.collider.handle) ?? '?';
const stats = {}, bad = [];
for (const e of roads.edges) {
  const c = roads.classes[e.cls];
  const offs = c.oneway ? [-c.hw * 0.5, 0, c.hw * 0.5] : [-c.hw * 0.45, c.hw * 0.45];
  let s = 0;
  for (let i = 1; i < e.pts.length; i++) {
    const a = e.pts[i - 1], b = e.pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L;
    for (let u = 0; u < L; u += 2, s += 2) {
      const f = u / L, x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f, z = a[2] + (b[2] - a[2]) * f;
      for (const o of offs) {
        const px = x - ty * o, py = y + tx * o;
        const ray = new RAPIER.Ray({ x: px, y: py, z: z + 1.2 }, { x: 0, y: 0, z: -1 });
        const h = world.castRay(ray, 10, false);
        const hz = h ? z + 1.2 - h.timeOfImpact : null, nm = h ? hitName(h) : 'none';
        const dz = hz == null ? -99 : hz - z;
        let k = null;
        if (!h) k = 'hole';
        else if (!['asphalt', 'concrete', 'metal'].includes(nm)) k = 'on-' + nm;
        else if (Math.abs(dz) > 0.3) k = dz > 0 ? 'above' : 'below';
        if (k) { stats[k] = (stats[k] ?? 0) + 1; bad.push({ k, e: e.name, id: e.id, cls: e.cls, s: Math.round(s), p: [Math.round(px), Math.round(py)], z, dz: +dz.toFixed(2), nm }); }
      }
    }
  }
}
console.log(stats);
const byEdge = {};
for (const b of bad) { const key = `${b.id} ${b.e} [${b.cls}] ${b.k}`; (byEdge[key] ??= []).push(b); }
const rows = Object.entries(byEdge).sort((a, b) => b[1].length - a[1].length);
for (const [k, v] of rows.slice(0, +(process.argv[2] ?? 40))) console.log(v.length, k, 'e.g.', v[0].p, 's=' + v[0].s, 'dz=' + v[0].dz, v[0].nm);
fs.mkdirSync('city/out', { recursive: true });
fs.writeFileSync('city/out/probe.json', JSON.stringify(bad));
