// Headless drive test: node tools/drive.mjs [cars=100] [seconds=120]
import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'fs';
import { buildWorld, Fleet, clusterIssues } from '../viewer/sim.js';
import { loadNodeWorld } from './load.mjs';
const [cars = 100, secs = 120] = process.argv.slice(2).map(Number);
await RAPIER.init();
const { roads, terrain } = await loadNodeWorld();
let t0 = Date.now();
const world = buildWorld(RAPIER, roads, terrain);
world.timestep = 1 / 30;
const fleet = new Fleet(RAPIER, world, roads, { count: cars });
console.log('world ready', (Date.now() - t0) / 1000, 's');
const steps = secs * 30;
let driven = 0;
for (let s = 0; s < steps; s++) {
  fleet.step(1 / 30);
  if (s % 300 === 0) console.log(`t=${s / 30}s issues=${fleet.issues.length} (${((Date.now() - t0) / 1000).toFixed(0)}s wall)`);
}
const items = clusterIssues(fleet.issues).filter(it => it.count >= 2);   // confirmed by 2+ cars
fs.writeFileSync('city/data/drive_issues.json', JSON.stringify({ layer: 'drive_issues', items }));
const by = {};
for (const it of items) by[it.rule] = (by[it.rule] ?? 0) + 1;
console.log('drive issues (places):', by);
for (const it of items.slice(0, 15)) console.log(' ', it.count, it.rule, it.p, it.msg);
