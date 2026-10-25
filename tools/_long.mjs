import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'fs';
import { buildWorld } from '../viewer/sim.js';
import { loadNodeWorld } from './load.mjs';
await RAPIER.init();
const { roads, terrain } = await loadNodeWorld();
const world = buildWorld(RAPIER, roads, terrain); world.step();
const [id, end, ...lats] = process.argv.slice(2).map(Number);
const e = roads.edges.find(e => e.id === id), pts = end ? [...e.pts].reverse() : e.pts;
for (const lat of lats) {
  let prev = null, s = 0, out = [];
  for (let i = 1; i < pts.length && s < 80; i++) {
    const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L;
    for (let u = 0; u < L; u += 0.25, s += 0.25) {
      const x = a[0] + tx * u - ty * lat, y = a[1] + ty * u + tx * lat, z = a[2] + (b[2] - a[2]) * u / L;
      const h = world.castRay(new RAPIER.Ray({ x, y, z: z + 1.2 }, { x: 0, y: 0, z: -1 }), 5, false);
      const hz = h ? z + 1.2 - h.timeOfImpact : null;
      if (prev != null && hz != null && Math.abs(hz - prev) > 0.08) out.push(`s=${s.toFixed(1)} step ${(hz - prev).toFixed(2)} ${world.names.get(h.collider.handle)} z${hz.toFixed(2)}`);
      prev = hz;
    }
  }
  console.log('edge', id, 'lat', lat, out.length ? out.join(' | ') : 'smooth');
}
