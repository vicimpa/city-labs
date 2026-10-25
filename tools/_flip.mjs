import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'fs';
import { buildWorld, Fleet } from '../viewer/sim.js';
import { loadNodeWorld } from './load.mjs';
await RAPIER.init();
const { roads, terrain } = await loadNodeWorld();
const world = buildWorld(RAPIER, roads, terrain); world.timestep = 1 / 30;
const names = new Map([...world.names].map(([h, n]) => [h, n]));
const fleet = new Fleet(RAPIER, world, roads, { count: +(process.argv[2] ?? 300) });
// remember each car's state 1.5 s before the event
const hist = new Map(), out = [];
const rep = fleet.report.bind(fleet);
fleet.report = (car, kind, p, note) => {
  const h = hist.get(car) ?? [];
  const o = h[0] ?? {};
  let off = 1e9; for (const q of car.route) off = Math.min(off, Math.hypot(q[0] - p.x, q[1] - p.y));
  out.push({ kind, p: [p.x|0, p.y|0], dbg: car.dbg, wheels: [0,1,2,3].map(w => car.ctl.wheelIsInContact(w) ? 1 : 0).join(''), susp: [0,1,2,3].map(w => (car.ctl.wheelSuspensionLength?.(w) ?? -1).toFixed(2)).join(' '), rot: (() => { const r = car.body.rotation(); return [r.x, r.y, r.z, r.w].map(v => v.toFixed(2)).join(','); })(), from: h.slice(-4).map(o => [o.x, o.y, o.z, o.under, o.off]), backs: car.backN ?? 0, road: car.route[car.wp][3], v0: o.v, under0: o.under, off0: o.off, off: off.toFixed(1), vk: car.vk[car.wp].toFixed(1) });
  rep(car, kind, p, note);
};
for (let s = 0; s < 120 * 30; s++) {
  fleet.step(1 / 30);
  if (s % 5) continue;
  for (const car of fleet.cars) {
    const p = car.body.translation(), v = car.body.linvel();
    const h = world.castRay(new RAPIER.Ray({ x: p.x, y: p.y, z: p.z }, { x: 0, y: 0, z: -1 }), 5, false);
    let off = 1e9; for (let k = Math.max(0, car.wp - 3); k < Math.min(car.route.length, car.wp + 3); k++) off = Math.min(off, Math.hypot(car.route[k][0] - p.x, car.route[k][1] - p.y));
    const arr = hist.get(car) ?? []; arr.push({ x: p.x|0, y: p.y|0, z: +p.z.toFixed(1), v: Math.hypot(v.x, v.y).toFixed(1), under: h ? names.get(h.collider.handle) : '-', off: off.toFixed(1) });
    if (arr.length > 9) arr.shift(); hist.set(car, arr);
  }
}
const c = {}; for (const o of out) { const k = `${o.kind} under=${o.under0} off>3=${o.off0 > 3}`; c[k] = (c[k] ?? 0) + 1; }
console.log(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 12));
for (const o of out.filter(o => o.kind === (process.argv[3] ?? 'flip')).slice(0, 25)) console.log(JSON.stringify(o));
