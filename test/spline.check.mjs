// Control-point editing of dense lines (world/spline.js) on the sample city's railways and roads.
//   node test/spline.check.mjs
import fs from 'node:fs';
import { decodeWorld } from '../format/world.js';
import { controlIndices, reshape } from '../world/spline.js';
import { projectToPolyline } from '../world/geom.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) fails++; };
const w = await decodeWorld(fs.readFileSync('city/data/vespera.vspb'));
const lines = [...w.layers.buildings.rails, ...w.layers.roads.edges.map((e) => e.pts)];
const len = (P) => P.reduce((s, p, i) => s + (i ? Math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1]) : 0), 0);
const dev = (A, B) => A.reduce((m, q) => Math.max(m, projectToPolyline(B, q).d), 0);

let nC = 0, L = 0, loops = true;
for (const P of lines) {
  const C = controlIndices(P, 1.5, 120);
  nC += C.length; L += len(P);
  if (Math.hypot(P[0][0] - P.at(-1)[0], P[0][1] - P.at(-1)[1]) < 1 && len(P) > 300 && C.length < 4) loops = false;
}
ok(L / nC > 40, `${nC} control points for ${(L / 1000).toFixed(0)} km: one per ${(L / nC).toFixed(0)} m`);
ok(loops, 'closed loops get control points along them');

const P = w.layers.buildings.rails[0], C = controlIndices(P, 1.5, 120), k = 40;
const same = reshape(P, C, { move: k, to: P[C[k]] }, 8);
ok(dev(same.pts, P) < 0.01, `moving a point onto itself keeps the line (max ${dev(same.pts, P).toFixed(3)} m)`);
// 20 m sideways
const a = P[C[k] - 1], b = P[C[k] + 1], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
const to = [P[C[k]][0] - ((b[1] - a[1]) / d) * 20, P[C[k]][1] + ((b[0] - a[0]) / d) * 20, P[C[k]][2]], m = reshape(P, C, { move: k, to }, 8);
ok(Math.hypot(m.pts[m.C[k]][0] - to[0], m.pts[m.C[k]][1] - to[1]) < 0.01, 'the moved control point lands where it was dropped');
const lo = m.C[k - 2], hi = m.C[k + 2];
ok(m.pts.slice(0, lo + 1).every((q, i) => q[0] === P[i][0] && q[1] === P[i][1]) &&
  m.pts.slice(hi).every((q, i) => q[0] === P[C[k + 2] + i][0] && q[1] === P[C[k + 2] + i][1]), 'outside the two neighbours on each side nothing moves');
const gaps = m.pts.slice(lo, hi).map((q, i) => Math.hypot(m.pts[lo + i + 1][0] - q[0], m.pts[lo + i + 1][1] - q[1]));
ok(Math.max(...gaps) < 12 && Math.min(...gaps) > 4, `the bent stretch is evenly sampled (${Math.min(...gaps).toFixed(1)}–${Math.max(...gaps).toFixed(1)} m)`);
const turn = (i) => {
  const a = m.pts[i - 1], b = m.pts[i], c = m.pts[i + 1], t = Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]);
  return Math.abs(Math.atan2(Math.sin(t), Math.cos(t)));
};
const worst = Math.max(...Array.from({ length: hi - lo + 1 }, (_, j) => turn(lo + j)));
ok(worst < 0.15 && turn(lo) < 0.03 && turn(hi) < 0.03, `the bend is smooth and joins the line without kinks (max turn ${(worst * 180 / Math.PI).toFixed(1)}° per point)`);
const back = reshape(m.pts, m.C, { move: k, to: P[C[k]] }, 8);
ok(dev(back.pts, P) < 0.5, `dragging it back gives the line back (max ${dev(back.pts, P).toFixed(2)} m)`);
const r = reshape(P, C, { remove: k }, 8);
ok(r.C.length === C.length - 1 && r.from.every((v, i) => !i || v >= r.from[i - 1]) && r.from.length === r.pts.length, 'removing a control point keeps the indices in order');
ok(reshape(P, C, { move: 0, to: [0, 0, 0] }, 8).pts[0].join() === '0,0,0', 'the ends move too');
if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
console.log('all spline checks passed');
