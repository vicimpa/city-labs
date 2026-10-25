import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'fs';
import { buildWorld } from '../viewer/sim.js';
import { loadNodeWorld } from './load.mjs';
await RAPIER.init();
const { roads, terrain } = await loadNodeWorld();
const world = buildWorld(RAPIER, roads, terrain); world.step();
const names = new Map([...world.names].map(([h, n]) => [h, n[0]]));
const a = process.argv.slice(2).map(Number);
for (let q = 0; q < a.length; q += 2) {
  const P = [a[q], a[q + 1]];
  let best = null;
  for (const e of roads.edges) e.pts.forEach((p, i) => { const d = Math.hypot(p[0] - P[0], p[1] - P[1]); if (!best || d < best.d) best = { d, e, i }; });
  const { e, i } = best, p = e.pts[i], n = e.pts[Math.min(i + 1, e.pts.length - 1)], m = e.pts[Math.max(i - 1, 0)];
  let tx = n[0] - m[0], ty = n[1] - m[1]; const L = Math.hypot(tx, ty); tx /= L; ty /= L;
  console.log(`${P} -> ${e.id} ${e.name} [${e.cls}] z=${p[2]}`);
  for (const along of [-2, 0, 2]) {
    let row = '';
    for (let o = -4; o <= 4; o += 0.25) {
      const x = p[0] + tx * along - ty * o, y = p[1] + ty * along + tx * o;
      const h = world.castRay(new RAPIER.Ray({ x, y, z: p[2] + 3 }, { x: 0, y: 0, z: -1 }), 60, false);
      row += h ? `${names.get(h.collider.handle)}${(3 - h.timeOfImpact).toFixed(1).padStart(5)} ` : '  ---- ';
    }
    console.log(String(along).padStart(4), row);
  }
}
