// Road network model over the `roads` layer records (port of the parts of network.py the builders
// need): class widths, per-edge arrays, node arms, junction trims, a spatial index.
import { unit, leftNormal, lineIntersect, interp, searchsorted, cumLength } from './geom.js';

export const URBAN = new Set(['boulevard', 'avenue', 'street', 'lane']);

// class parameters live in roads.classes; these fill gaps for classes created in the editor
export const CLASS_DEFAULTS = { lanes: 1, lane_w: 3.5, shoulder: 1.0, median: 0.0, side: 0.0, sigma: 40, r: 40, prio: 2,
  corner: 8, oneway: false, max_grade: 0.1, k_min: 12 };

export function classOf(classes, cls) { return { ...CLASS_DEFAULTS, ...(classes?.[cls] ?? {}) }; }
export function hw(c) { return c.oneway ? (c.lanes * c.lane_w) / 2 + c.shoulder : c.lanes * c.lane_w + c.shoulder + c.median / 2; }
export const hwt = (c) => hw(c) + c.side;

/** Keep the derived hw / hwt fields of roads.classes in step with the parameters (sim.js reads them). */
export function syncClassWidths(classes) {
  for (const c of Object.values(classes ?? {})) {
    const k = { ...CLASS_DEFAULTS, ...c };
    c.hw = Math.round(hw(k) * 100) / 100; c.hwt = Math.round(hwt(k) * 100) / 100;
  }
}

/** Natural ground sampler over terrain.base (falls back to the carved h). */
export function groundSampler(t) {
  if (!t) return () => 0;
  const { nx, ny, x0, y0, res } = t, h = t.base ?? t.h;
  return (x, y) => {
    const fx = Math.min(Math.max((x - x0) / res, 0), nx - 1.001), fy = Math.min(Math.max((y - y0) / res, 0), ny - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, k = j * nx + i;
    return h[k] * (1 - u) * (1 - v) + h[k + 1] * u * (1 - v) + h[k + nx] * (1 - u) * v + h[k + nx + 1] * u * v;
  };
}

/** Edge view: P [[x,y]], z, s, L, elev/tunnel (bool arrays) + class params. */
export function edgeView(rec, classes) {
  const pts = rec.pts ?? [];
  const P = pts.map((p) => [p[0], p[1]]), z = Float64Array.from(pts, (p) => p[2] ?? 0);
  const s = cumLength(P), n = pts.length;
  const flag = (a) => Uint8Array.from({ length: n }, (_, i) => (a?.[i] ? 1 : 0));
  const c = classOf(classes, rec.cls);
  return { rec, id: rec.id, cls: rec.cls, c, hw: hw(c), hwt: hwt(c), P, z, s, L: n ? s[n - 1] : 0,
    elev: flag(rec.elev), tunnel: flag(rec.tunnel), trim: [rec.trim?.[0] ?? 0, rec.trim?.[1] ?? 0], n: [null, null] };
}

/** Build the network view: { edges, nodes, edgeById, nodeById }. Records stay the source of truth. */
export function buildNet(roads) {
  const nodes = (roads.nodes ?? []).map((r) => ({ rec: r, id: r.id, pos: [r.p[0], r.p[1]], z: r.p[2] ?? 0, kind: r.kind ?? '',
    grad: r.grad ?? [0, 0], free: !!r.free, edges: [] }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  for (const rec of roads.edges ?? []) {
    if (!(rec.pts?.length >= 2)) continue;
    const e = edgeView(rec, roads.classes);
    e.n = [nodeById.get(rec.n?.[0]) ?? null, nodeById.get(rec.n?.[1]) ?? null];
    e.n.forEach((nd, k) => nd?.edges.push([e, k]));
    edges.push(e);
  }
  return { edges, nodes, edgeById: new Map(edges.map((e) => [e.id, e])), nodeById, classes: roads.classes };
}

export function pointAt(e, s) { return [interp(s, e.s, e.P.map((p) => p[0])), interp(s, e.s, e.P.map((p) => p[1]))]; }
export function tangentAt(e, s) {
  const xs = e.xs ??= e.P.map((p) => p[0]), ys = e.ys ??= e.P.map((p) => p[1]);
  return unit([interp(s + 2, e.s, xs) - interp(s - 2, e.s, xs), interp(s + 2, e.s, ys) - interp(s - 2, e.s, ys)]);
}

/** Junction trims and node kinds (network.compute_trims) for the given nodes (default: all).
 *  Writes rec.trim of the arms and node.rec.kind. */
export function computeTrims(net, nodes = net.nodes) {
  for (const n of nodes) for (const [e, k] of n.edges) e.trim[k] = 0;
  for (const n of nodes) {
    const arms = [];
    for (const [e, k] of n.edges) {
      if (e.L < 1) continue;
      const look = Math.min(16, e.L * 0.4);
      const q = k === 0 ? e.P[Math.min(searchsorted(e.s, look), e.P.length - 1)] : e.P[Math.min(searchsorted(e.s, e.L - look), e.P.length - 1)];
      const d = unit([q[0] - n.pos[0], q[1] - n.pos[1]]);
      arms.push({ e, k, d, ang: Math.atan2(d[1], d[0]), hw: e.hw, hwt: e.hwt, corner: e.c.corner });
    }
    arms.sort((a, b) => a.ang - b.ang);
    if (arms.length <= 1) { n.kind = 'end'; continue; }
    if (arms.length === 2) {
      const [a, b] = arms, dt = a.d[0] * b.d[0] + a.d[1] * b.d[1];
      if (dt < -0.94 && Math.abs(a.hwt - b.hwt) < 0.01 && Math.abs(a.hw - b.hw) < 0.01) { n.kind = 'joint'; continue; }
      n.kind = 'transition';
      const bend = Math.acos(Math.max(-1, Math.min(1, -dt)));
      const t = Math.min(45, 6 + 1.5 * Math.abs(a.hwt - b.hwt) + Math.max(a.hwt, b.hwt) * Math.tan(bend / 2) * 1.5);
      for (const arm of arms) arm.e.trim[arm.k] = Math.min(t, arm.e.L * 0.35);
      continue;
    }
    n.kind = 'junction';
    const m = arms.length, req = new Array(m).fill(0);
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m, A = arms[i], B = arms[j];
      const nA = leftNormal(A.d), nB = leftNormal(B.d);
      const pA = [n.pos[0] + nA[0] * A.hwt, n.pos[1] + nA[1] * A.hwt], pB = [n.pos[0] - nB[0] * B.hwt, n.pos[1] - nB[1] * B.hwt];
      const gap = (((B.ang - A.ang) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (gap > (165 * Math.PI) / 180 || gap < 1e-3) continue;
      const r = lineIntersect(pA, A.d, pB, B.d);
      if (!r) continue;
      req[i] = Math.max(req[i], r[0]); req[j] = Math.max(req[j], r[1]);
    }
    arms.forEach((A, i) => {
      const base = Math.max(req[i], Math.max(...arms.filter((o) => o !== A).map((o) => o.hw)) * 0.6);
      A.e.trim[A.k] = Math.max(Math.min(base + A.corner, A.e.L * 0.45, 90), 0);
    });
  }
  // stored to the millimetre; the views use the stored values so a reload builds the same mesh
  const mm = (v) => Math.round(v * 1000) / 1000;
  for (const n of nodes) {
    n.rec.kind = n.kind;
    for (const [e] of n.edges) { e.trim = [mm(e.trim[0]), mm(e.trim[1])]; e.rec.trim = [...e.trim]; }
  }
}

/** Spatial lookup over carriageway samples: is a point on some other road? (roadmesh.RoadIndex) */
export class RoadIndex {
  constructor(edges, cell = 30) {
    this.cell = cell; this.H = new Map();
    for (const e of edges) for (let i = 0; i + 1 < e.P.length; i++) {
      const key = Math.floor(e.P[i][0] / cell) + ',' + Math.floor(e.P[i][1] / cell);
      let b = this.H.get(key); if (!b) this.H.set(key, b = []); b.push(e, i);
    }
  }
  *near(p) {
    const gx = Math.floor(p[0] / this.cell), gy = Math.floor(p[1] / this.cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const b = this.H.get((gx + dx) + ',' + (gy + dy));
      if (b) for (let k = 0; k < b.length; k += 2) yield [b[k], b[k + 1]];
    }
  }
  static dist(e, i, p) {
    const a = e.P[i], b = e.P[i + 1], abx = b[0] - a[0], aby = b[1] - a[1];
    const t = Math.min(Math.max(((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / Math.max(abx * abx + aby * aby, 1e-9), 0), 1);
    return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t);
  }
  covering(p, z, exclude, margin = 0.3, dz = 1.6, shrink = 0) {
    for (const [e, i] of this.near(p)) {
      if (e === exclude) continue;
      if (Math.abs(e.z[i] - z) < dz && RoadIndex.dist(e, i, p) < e.hw - margin - shrink) return e;
    }
    return null;
  }
  groundRoadNear(p, zTop, extra = 1) {
    for (const [e, i] of this.near(p)) {
      if (e.z[i] > zTop - 4) continue;
      if (RoadIndex.dist(e, i, p) < e.hwt + extra) return true;
    }
    return false;
  }
}
