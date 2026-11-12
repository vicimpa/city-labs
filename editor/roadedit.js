// Road graph edits that change topology (new roads, splits, deletions) or levels (profiles).
// A RoadTx snapshots the edge / node arrays and every record it touches, so the whole edit is
// one undo step; derived geometry is rebuilt afterwards from the records.
import { buildNet, computeTrims, classOf, hwt } from '../world/roadnet.js';
import { filletPath, resample, edgeProfile, levelFlags, SPACING } from '../world/profile.js';
import { projectToPolyline, smoothstep, cumLength } from '../world/geom.js';
import { clone, restore } from './history.js';

const r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;

export class RoadTx {
  constructor(roads) { this.R = roads; this.edges0 = [...roads.edges]; this.nodes0 = [...roads.nodes]; this.before = new Map(); }
  touch(rec) { if (!this.before.has(rec)) this.before.set(rec, clone(rec)); return rec; }
  rollback() {
    this.R.edges.length = 0; for (const edge of this.edges0) this.R.edges.push(edge);
    this.R.nodes.length = 0; for (const node of this.nodes0) this.R.nodes.push(node);
    for (const [rec, snap] of this.before) restore(rec, snap);
  }
  /** Freeze the result: { undo, redo, edges: changed ids, nodes: changed ids, recs: touched + added + removed } */
  finish() {
    const R = this.R, edges1 = [...R.edges], nodes1 = [...R.nodes];
    const after = new Map([...this.before.keys()].map((rec) => [rec, clone(rec)]));
    const diff = (a, b) => [...a.filter((x) => !b.includes(x)), ...b.filter((x) => !a.includes(x))];
    const recs = new Set([...this.before.keys(), ...diff(this.edges0, edges1), ...diff(this.nodes0, nodes1)]);
    const set = (E, N, snaps) => { R.edges.length = 0; for (const e of E) R.edges.push(e); R.nodes.length = 0; for (const n of N) R.nodes.push(n); for (const [rec, s] of snaps) restore(rec, s); };
    return {
      recs,
      edges: [...recs].filter((r) => r.pts).map((r) => r.id), nodes: [...recs].filter((r) => r.p && !r.pts).map((r) => r.id),
      undo: () => set(this.edges0, this.nodes0, this.before), redo: () => set(edges1, nodes1, after),
    };
  }
}

const nextId = (arr) => arr.reduce((m, r) => Math.max(m, r.id ?? -1), -1) + 1;
export const edgesAt = (R, nodeId) => R.edges.filter((e) => e.n?.[0] === nodeId || e.n?.[1] === nodeId);

/** Move the end k of an edge by d, fading the shift out over the first `reach` metres. */
export function followEnd(e, k, d, reach = 40) {
  const pts = e.pts, s = cumLength(pts), L = s[s.length - 1], F = Math.min(reach, L * 0.5);
  pts.forEach((p, i) => {
    const w = 1 - smoothstep(0, F, k === 0 ? s[i] : L - s[i]);
    if (w <= 0) return;
    p[0] = r3(p[0] + d[0] * w); p[1] = r3(p[1] + d[1] * w); p[2] = r3(p[2] + (d[2] ?? 0) * w);
  });
}

/** Split edge rec at sample i: it keeps [0..i], a new edge takes [i..]; returns the new node. */
export function splitEdge(R, tx, E, i) {
  if (!R.edges.includes(E) || !Number.isInteger(i) || i <= 0 || i >= E.pts.length - 1) throw new Error('split point must be inside an existing road');
  tx.touch(E);
  const node = { id: nextId(R.nodes), p: E.pts[i].map(r3), kind: 'junction', grad: [0, 0] };
  const E2 = { id: nextId(R.edges), name: E.name, cls: E.cls, n: [node.id, E.n[1]], trim: [0, E.trim?.[1] ?? 0],
    pts: E.pts.slice(i).map((p) => [...p]), elev: (E.elev ?? []).slice(i), tunnel: (E.tunnel ?? []).slice(i) };
  if (E.merge) E2.merge = ['', E.merge[1]];
  E.pts = E.pts.slice(0, i + 1); E.elev = (E.elev ?? []).slice(0, i + 1); E.tunnel = (E.tunnel ?? []).slice(0, i + 1);
  E.n = [E.n[0], node.id]; E.trim = [E.trim?.[0] ?? 0, 0];
  if (E.merge) E.merge = [E.merge[0], ''];
  R.nodes.push(node); R.edges.push(E2);
  return node;
}

/** Where a road end at point q attaches: an existing node, a point on an edge (split), or nothing. */
export function snapEnd(R, q, c, { verticalTolerance = 3, snapDistance = Math.max(15, hwt(c) * 1.5) } = {}) {
  let best = null, bd = snapDistance;
  const sameLevel = (z) => q[2] === undefined || Math.abs(z - q[2]) <= verticalTolerance;
  for (const n of R.nodes) { const d = Math.hypot(n.p[0] - q[0], n.p[1] - q[1]); if (d < bd && sameLevel(n.p[2])) { bd = d; best = { node: n }; } }
  if (best) return best;
  for (const e of R.edges) {
    if (!(e.pts?.length >= 3)) continue;
    const pr = projectToPolyline(e.pts, q), lim = hwt(classOf(R.classes, e.cls)) + 4;
    const a = e.pts[pr.i], b = e.pts[Math.min(pr.i + 1, e.pts.length - 1)], z = a[2] + (b[2] - a[2]) * pr.t;
    if (pr.d < Math.min(lim, snapDistance) && sameLevel(z) && (!best || pr.d < best.d)) {
      const i = Math.min(Math.max(pr.t < 0.5 ? pr.i : pr.i + 1, 0), e.pts.length - 1);
      best = { d: pr.d, edge: e, i };
    }
  }
  if (best?.edge && (best.i < 2 || best.i > best.edge.pts.length - 3)) {     // near an end: take that end's node
    const id = best.edge.n[best.i < 2 ? 0 : 1], n = R.nodes.find((x) => x.id === id);
    return n && sameLevel(n.p[2]) ? { node: n } : null;
  }
  return best;
}

/**
 * Lay a new road through control points (corners filleted with the class radius), attach its ends
 * to nearby nodes or split the roads they land on, and give it a vertical profile.
 */
export function addRoad(doc, ground, ctrl, cls, name, options = {}) {
  const R = doc.layers.roads, tx = new RoadTx(R), c = classOf(R.classes, cls);
  if (!Object.hasOwn(R.classes, cls)) throw new Error(`unknown road class '${cls}'`);
  if (!Array.isArray(ctrl) || ctrl.length < 2 || ctrl.length > 10000 || ctrl.some((p) => !Array.isArray(p) || p.length < 2 || !p.every(Number.isFinite))) throw new Error('a road needs 2–10000 finite control points');
  const elevation = options.elevation ?? 0;
  if (!Number.isFinite(elevation) || Math.abs(elevation) > 10000) throw new Error('road elevation must be finite and within ±10000 metres');
  ctrl = ctrl.map((p) => [p[0], p[1], (p[2] ?? Math.max(ground(p[0], p[1]), 0)) + elevation]);
  const fail = () => { tx.rollback(); return null; };
  try {
  const endNodes = [null, null], freeEnds = [false, false];
  for (const [k, i] of [[0, 0], [1, ctrl.length - 1]]) {
    const sn = options.snap === false ? null : snapEnd(R, ctrl[i], c, options);
    if (sn?.node) endNodes[k] = sn.node;
    else if (sn?.edge) endNodes[k] = splitEdge(R, tx, sn.edge, sn.i);
    if (endNodes[k]) ctrl[i] = [endNodes[k].p[0], endNodes[k].p[1]];
  }
  if (endNodes[0] && endNodes[0] === endNodes[1]) return fail();
  const radii = ctrl.map((_, i) => (i === 0 || i === ctrl.length - 1 ? 0 : c.r));
  const P = resample(filletPath(ctrl, radii), SPACING);
  if (P.length < 3 || cumLength(P).at(-1) < 6) return fail();
  for (const k of [0, 1]) {
    if (endNodes[k]) continue;
    const q = P[k === 0 ? 0 : P.length - 1];
    endNodes[k] = { id: nextId(R.nodes), p: [r2(q[0]), r2(q[1]), r2(Math.max(ground(q[0], q[1]), 0) + elevation)], kind: 'end', grad: [0, 0] };
    freeEnds[k] = true;
    R.nodes.push(endNodes[k]);
  }
  const e = { id: nextId(R.edges), name: name || `${cls} ${nextId(R.edges)}`, cls, n: [endNodes[0].id, endNodes[1].id], trim: [0, 0],
    pts: P.map((q) => [r3(q[0]), r3(q[1]), 0]), elev: P.map(() => 0), tunnel: P.map(() => 0) };
  R.edges.push(e);
  reprofile(doc, ground, e, { newEnds: freeEnds, elevation });
  return { tx, edge: e };
  } catch (error) { tx.rollback(); throw error; }
}

/**
 * Recompute an edge's levels over the natural ground, pinned to its end nodes (new ends take the
 * profile's own level). Updates trims of the touched nodes first, since the profile pins the pads.
 */
export function reprofile(doc, ground, rec, { newEnds = [false, false], elevation = 0 } = {}) {
  const R = doc.layers.roads, net = buildNet(R), e = net.edgeById.get(rec.id);
  if (!e) return;
  computeTrims(net, e.n.filter(Boolean));
  const ends = e.n.map((nd, k) => (nd && !newEnds[k] ? nd.z - elevation : null));
  const prof = edgeProfile(e, ground, ends, e.n.map((nd) => nd?.grad ?? [0, 0]), e.n.map((nd) => nd?.pos ?? null));
  rec.pts.forEach((p, i) => { p[2] = r3(prof.z[i] + elevation); });
  const flags = elevation ? levelFlags(e, rec.pts.map((p) => p[2]), rec.pts.map((p) => ground(p[0], p[1]))) : prof;
  rec.elev = flags.elev; rec.tunnel = flags.tunnel;
  e.n.forEach((nd, k) => { if (nd && newEnds[k]) nd.rec.p[2] = rec.pts[k === 0 ? 0 : rec.pts.length - 1][2]; });
}

/** Remove an edge; nodes left without roads go too. */
export function deleteEdge(doc, rec) {
  const R = doc.layers.roads, tx = new RoadTx(R);
  if (!R.edges.includes(rec)) throw new Error('road is not in this document');
  R.edges.splice(R.edges.indexOf(rec), 1);
  for (const id of rec.n ?? []) if (!edgesAt(R, id).length) { const i = R.nodes.findIndex((n) => n.id === id); if (i >= 0) R.nodes.splice(i, 1); }
  return tx;
}
/** Remove a node with every road attached to it. */
export function deleteNode(doc, rec) {
  const R = doc.layers.roads, tx = new RoadTx(R), ends = new Set();
  if (!R.nodes.includes(rec)) throw new Error('node is not in this document');
  for (const e of edgesAt(R, rec.id)) { R.edges.splice(R.edges.indexOf(e), 1); for (const id of e.n) ends.add(id); }
  ends.add(rec.id);
  for (const id of ends) if (!edgesAt(R, id).length) { const i = R.nodes.findIndex((n) => n.id === id); if (i >= 0) R.nodes.splice(i, 1); }
  return tx;
}
