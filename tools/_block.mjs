import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'fs';
import { buildWorld } from '../viewer/sim.js';
import { loadNodeWorld } from './load.mjs';
await RAPIER.init();
const { roads, terrain } = await loadNodeWorld();
const world = buildWorld(RAPIER, roads, terrain); world.step();
const names = new Map([...world.names].map(([h, n]) => [h, n]));
const a = process.argv.slice(2).map(Number);
for (let q = 0; q < a.length; q += 2) {
  const [x, y] = [a[q], a[q + 1]];
  const g = world.castRay(new RAPIER.Ray({ x, y, z: 300 }, { x: 0, y: 0, z: -1 }), 600, false);
  const z = 300 - g.timeOfImpact;
  let near = [];
  for (const e of roads.edges) e.pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < 12) near.push(`${e.id}:${e.name}[${e.cls}] d${d.toFixed(1)} z${p[2]}`); });
  near = [...new Set(near.map(s => s.replace(/ d.*/, '')))].map(k => near.find(s => s.startsWith(k)));
  const hits = [];
  for (let k = 0; k < 16; k++) {
    const t = k / 16 * 2 * Math.PI;
    const h = world.castRay(new RAPIER.Ray({ x, y, z: z + 0.45 }, { x: Math.cos(t), y: Math.sin(t), z: 0 }), 5, false);
    if (h) hits.push(`${(t * 180 / Math.PI) | 0}°:${names.get(h.collider.handle)}@${h.timeOfImpact.toFixed(1)}`);
  }
  console.log(`(${x},${y}) ground=${names.get(g.collider.handle)} z=${z.toFixed(1)}\n   roads: ${near.join(' | ')}\n   bumper hits: ${hits.join(' ')}`);
}
