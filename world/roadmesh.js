// Road geometry: carriageways, curbs, sidewalks, junction pads, markings, barriers, bents and
// tunnels (port of the Python generator's roadmesh.py, see the first git commit). Output: per owner { material: { v: number[], i: number[] } }.
import { unit, leftNormal, interp, searchsorted, linspace, tangents, lineIntersect, cumLength, resampleN, roundHalfEven } from './geom.js';
import { RoadIndex, tangentAt, URBAN } from './roadnet.js';

const CURB = 0.15, LINE_W = 0.15;

// ---------------------------------------------------------------- mesh buffers
export class Bufs {
  constructor() { this.m = {}; }
  get(mat) { return (this.m[mat] ??= { v: [], i: [] }); }
  /** rows: n rows of m points [x,y,z], ordered left->right; quads (a,b,c,d) split as in the exporter */
  strip(rows, mat) {
    const n = rows.length, m = n ? rows[0].length : 0;
    if (n < 2 || m < 2) return;
    const B = this.get(mat), base = B.v.length / 3;
    for (const r of rows) for (const p of r) B.v.push(p[0], p[1], p[2]);
    for (let i = 0; i + 1 < n; i++) for (let j = 0; j + 1 < m; j++) {
      const a = base + i * m + j, b = a + 1, c = a + m + 1, d = a + m;
      B.i.push(a, b, c, a, c, d);
    }
  }
  /** polygons over V (fan triangulation) */
  add(V, faces, mat) {
    const B = this.get(mat), base = B.v.length / 3;
    for (const p of V) B.v.push(p[0], p[1], p[2]);
    for (const f of faces) for (let k = 1; k + 1 < f.length; k++) B.i.push(base + f[0], base + f[k], base + f[k + 1]);
  }
}

function stripMasked(L, rows, mat, mask) {
  const n = mask.length;
  let i = 0;
  while (i < n) {
    if (!mask[i]) { i++; continue; }
    let j = i;
    while (j < n && mask[j]) j++;
    if (j - i >= 2) L.strip(rows.slice(i, j), mat);
    i = j;
  }
}

function closeSmallGaps(m, k) {
  m = Uint8Array.from(m);
  const n = m.length;
  let i = 0;
  while (i < n) {
    if (m[i]) { i++; continue; }
    let j = i;
    while (j < n && !m[j]) j++;
    if (i > 0 && j < n && j - i <= k) m.fill(1, i, j);
    i = j;
  }
  return m;
}

// ---------------------------------------------------------------- sampling
function sampleRange(e, s0, s1) {
  const ss = [s0];
  for (const s of e.s) if (s > s0 + 0.3 && s < s1 - 0.3) ss.push(s);
  ss.push(s1);
  const xs = e.xs ??= e.P.map((p) => p[0]), ys = e.ys ??= e.P.map((p) => p[1]);
  const P = ss.map((s) => [interp(s, e.s, xs), interp(s, e.s, ys)]);
  const z = ss.map((s) => interp(s, e.s, e.z));
  const Tn = ss.map((s) => tangentAt(e, s));
  const elev = Uint8Array.from(ss, (s) => interp(s, e.s, e.elev) > 0.5);
  const tun = Uint8Array.from(ss, (s) => interp(s, e.s, e.tunnel) > 0.5);
  return { ss, P, z, Tn, elev, tun };
}

// ---------------------------------------------------------------- edges
export function buildEdge(e, L, idx, ground) {
  const c = e.c, s0 = e.trim[0], s1 = e.L - e.trim[1];
  if (s1 - s0 < 0.5) return;
  const S = sampleRange(e, s0, s1), { ss, P, Tn, elev, tun } = S;
  let z = S.z;
  const Nn = Tn.map(leftNormal), W = e.hw, side = c.side, n = ss.length;
  if (e.cls === 'ramp') {                 // z-fighting guard: a ramp sinks under its host where they overlap
    z = z.slice();
    for (let i = 0; i < n; i++) if (idx.covering(P[i], z[i], e, 0, 1.0)) z[i] -= 0.04;
  }
  const row = (u, dz, zz = z) => P.map((p, i) => [p[0] + Nn[i][0] * u, p[1] + Nn[i][1] * u, zz[i] + dz]);
  const rowA = (U, DZ) => P.map((p, i) => [p[0] + Nn[i][0] * U[i], p[1] + Nn[i][1] * U[i], z[i] + DZ[i]]);
  const zip = (...cols) => cols[0].map((_, i) => cols.map((col) => col[i]));

  L.strip(zip(row(W, 0), row(-W, 0)), 'asphalt');
  const depth = Array.from(elev, (v) => (v ? -1.7 : -1.3));
  if (side > 0) {
    const W2 = W + side;
    for (const sg of [1, -1]) {
      const pts = [row(sg * W, 0), row(sg * W, CURB)];
      L.strip(zip(...(sg < 0 ? pts : pts.reverse())), 'curb');
      L.strip(sg > 0 ? zip(row(W2, CURB), row(W, CURB)) : zip(row(-W, CURB), row(-W2, CURB)), 'sidewalk');
      const outer = rowA(new Array(n).fill(sg * W2), depth);
      L.strip(sg > 0 ? zip(outer, row(sg * W2, CURB)) : zip(row(sg * W2, CURB), outer), 'concrete');
    }
  } else {
    for (const sg of [1, -1]) {
      const outer = rowA(new Array(n).fill(sg * W), depth);
      L.strip(sg > 0 ? zip(outer, row(sg * W, 0)) : zip(row(sg * W, 0), outer), 'concrete');
    }
  }
  if (elev.some(Boolean)) {               // deck underside on elevated parts
    const Wd = W + side, m = Uint8Array.from(elev);
    for (let i = 0; i + 1 < n; i++) m[i] |= elev[i + 1];
    stripMasked(L, zip(row(-Wd, -1.7), row(Wd, -1.7)), 'concrete', m);
  }
  if (e.cls === 'boulevard') {            // planted median
    const mh = c.median / 2;
    for (const sg of [1, -1]) {
      const pts = [row(sg * mh, 0), row(sg * mh, CURB)];
      L.strip(zip(...(sg > 0 ? pts : pts.reverse())), 'curb');
    }
    L.strip(zip(row(mh, CURB + 0.01), row(-mh, CURB + 0.01)), 'grass');
  }
  const ctx = { e, L, ss, P, z, Nn, cut: null, mask: markingMask(e, idx, ss, P, z, Nn) };
  markings(ctx, s0, s1);
  ctx.mask = null;
  barriers(e, L, idx, ss, P, z, Nn, Tn, elev, tun, ground);
  if (tun.some(Boolean)) tunnel(e, L, P, z, Nn, tun);
}

// ---------------------------------------------------------------- markings
function markingMask(e, idx, ss, P, z, Nn) {
  const cache = new Map();
  return (u) => {
    const key = Math.round(u * 10);
    let m = cache.get(key);
    if (!m) {
      m = new Uint8Array(ss.length);
      for (let i = 0; i < ss.length; i++) m[i] = idx.covering([P[i][0] + Nn[i][0] * u, P[i][1] + Nn[i][1] * u], z[i], e, -0.3, 1.2) ? 0 : 1;
      cache.set(key, m);
    }
    return m;
  };
}

function line(ctx, u, mat, { dash = null, width = LINE_W } = {}) {
  const { L, ss, P, z, Nn } = ctx, n = ss.length;
  const lo = ctx.cut?.lo, hi = ctx.cut?.hi;
  if (dash) {
    // resample dashes exactly so they have crisp ends
    const [on, off] = dash, per = on + off, start = ss[0];
    const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]), nx = Nn.map((q) => q[0]), ny = Nn.map((q) => q[1]);
    const vis = ctx.mask?.(u);
    for (let k = 0; start + k * per < ss[n - 1]; k++) {
      const t0 = start + k * per, t1 = Math.min(t0 + on, ss[n - 1]);
      if (lo !== undefined && (t0 < lo || t1 > hi)) continue;
      if (vis) {
        const i0 = searchsorted(ss, t0), i1 = Math.min(searchsorted(ss, t1), n - 1);
        let ok = true; for (let i = i0; i <= i1; i++) if (!vis[i]) { ok = false; break; }
        if (!ok) continue;
      }
      const r = linspace(t0, t1, 3).map((t) => {
        const px = interp(t, ss, xs), py = interp(t, ss, ys), q = unit([interp(t, ss, nx), interp(t, ss, ny)]), zz = interp(t, ss, z) + 0.025;
        return [[px + q[0] * (u + width / 2), py + q[1] * (u + width / 2), zz], [px + q[0] * (u - width / 2), py + q[1] * (u - width / 2), zz]];
      });
      L.strip(r, mat);
    }
    return;
  }
  const ph = new Uint8Array(n).fill(1);
  if (lo !== undefined) for (let i = 0; i < n; i++) if (ss[i] < lo || ss[i] > hi) ph[i] = 0;
  if (ctx.mask) { const v = ctx.mask(u); for (let i = 0; i < n; i++) ph[i] &= v[i]; }
  const rows = P.map((p, i) => [[p[0] + Nn[i][0] * (u + width / 2), p[1] + Nn[i][1] * (u + width / 2), z[i] + 0.025],
    [p[0] + Nn[i][0] * (u - width / 2), p[1] + Nn[i][1] * (u - width / 2), z[i] + 0.025]]);
  stripMasked(L, rows, mat, ph);
}

function markings(ctx, s0, s1) {
  const { e, L, ss, P, z, Nn } = ctx, c = e.c, cls = e.cls;
  ctx.cut = null;
  if (URBAN.has(cls)) {
    const lo = s0 + (e.n[0]?.kind === 'junction' ? 6.5 : 0), hi = s1 - (e.n[1]?.kind === 'junction' ? 6.5 : 0);
    if (hi > lo) ctx.cut = { lo, hi };
  }
  const lanes = c.lanes, lw = c.lane_w;
  if (c.oneway) {
    const half = (lanes * lw) / 2;
    for (let k = 1; k < lanes; k++) line(ctx, -half + k * lw, 'paint_white', { dash: [3, 9] });
    line(ctx, half - 0.1, cls.startsWith('fw1') || cls.startsWith('av1') ? 'paint_yellow' : 'paint_white');
    line(ctx, -half + 0.1, 'paint_white');
    return;
  }
  const m = c.median / 2;
  for (const sg of [1, -1]) {
    for (let k = 1; k < lanes; k++) line(ctx, sg * (m + k * lw), 'paint_white', { dash: cls === 'freeway' ? [3, 9] : [3, 6] });
    if (['freeway', 'boulevard', 'mountain', 'rural', 'industrial', 'avenue'].includes(cls)) line(ctx, sg * (m + lanes * lw + 0.1), 'paint_white');
  }
  if (cls === 'freeway') for (const sg of [1, -1]) line(ctx, sg * (m + 0.2), 'paint_yellow');
  else if (['avenue', 'street', 'mountain'].includes(cls)) for (const sg of [1, -1]) line(ctx, sg * 0.14, 'paint_yellow', { width: 0.12 });
  else if (cls === 'rural' || cls === 'industrial' || cls.startsWith('raceway')) line(ctx, 0, 'paint_yellow', { dash: [3, 6] });
  // crosswalks + stop lines at junction approaches
  if (!URBAN.has(cls)) return;
  const Wc = e.hw - 0.3, n = ss.length;
  for (const k of [0, 1]) {
    const nd = e.n[k];
    if (nd?.kind !== 'junction' || nd.edges.length < 3) continue;
    const base = k === 0 ? s0 : s1, sgn = k === 0 ? 1 : -1;
    zebra(L, ss, P, z, Nn, base + sgn * 1, base + sgn * 4, Wc);
    const i = Math.min(Math.max(searchsorted(ss, base + sgn * 5), 0), n - 1);
    const p = P[i], nrm = Nn[i], zz = z[i] + 0.025, t = [nrm[1] * -sgn, -nrm[0] * -sgn];
    const [u0, u1] = k === 0 ? [-Wc, -0.2] : [0.2, Wc];
    const at = (u, dt) => [p[0] + nrm[0] * u + t[0] * dt, p[1] + nrm[1] * u + t[1] * dt, zz];
    L.add([at(u0, -0.2), at(u1, -0.2), at(u1, 0.2), at(u0, 0.2)], [k === 0 ? [0, 3, 2, 1] : [0, 1, 2, 3]], 'paint_white');
  }
}

function zebra(L, ss, P, z, Nn, a, b, Wc) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  if (lo < ss[0] || hi > ss[ss.length - 1]) return;
  const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]), nx = Nn.map((q) => q[0]), ny = Nn.map((q) => q[1]);
  const at = [lo, hi].map((t) => ({ p: [interp(t, ss, xs), interp(t, ss, ys)], q: unit([interp(t, ss, nx), interp(t, ss, ny)]), z: interp(t, ss, z) + 0.026 }));
  for (let u = -Wc + 0.25; u + 0.5 < Wc; u += 1.1) {
    L.strip(at.map(({ p, q, z: zz }) => [[p[0] + q[0] * (u + 0.5), p[1] + q[1] * (u + 0.5), zz], [p[0] + q[0] * u, p[1] + q[1] * u, zz]]), 'paint_white');
  }
}

// ---------------------------------------------------------------- barriers
const JERSEY = [[0.12, 0.0], [0.12, 0.85], [-0.04, 0.85], [-0.12, 0.35], [-0.30, 0.1], [-0.30, 0.0]];

function profileSweep(L, P, z, Nn, u0, sg, prof, mat, mask) {
  const cols = prof.map(([du, h]) => P.map((p, i) => [p[0] + Nn[i][0] * sg * (u0 + du), p[1] + Nn[i][1] * sg * (u0 + du), z[i] + h]));
  const ordered = sg < 0 ? cols : cols.slice().reverse();
  stripMasked(L, P.map((_, i) => ordered.map((col) => col[i])), mat, mask);
}

function barriers(e, L, idx, ss, P, z, Nn, Tn, elev, tun, ground) {
  const W = e.hw, side = e.c.side, n = ss.length, cls = e.cls;
  for (const sg of [1, -1]) {
    const edgeU = W + side;
    let need, kind;
    if (cls === 'freeway' || cls === 'ramp' || cls.startsWith('fw1') || cls.startsWith('ramp')) { need = new Uint8Array(n).fill(1); kind = 'jersey'; }
    else if (['mountain', 'rural', 'industrial'].includes(cls)) {
      need = Uint8Array.from(P, (p, i) => (z[i] - ground(p[0] + Nn[i][0] * sg * (W + 6), p[1] + Nn[i][1] * sg * (W + 6)) > 2.5) || elev[i]);
      kind = 'rail';
    } else { need = Uint8Array.from(elev); kind = 'parapet'; }
    for (let i = 0; i < n; i++) if (tun[i]) need[i] = 0;
    if (!need.some(Boolean)) continue;
    // gaps where another road joins (merges, junction pads)
    for (let i = 0; i < n; i++) {
      if (need[i] && idx.covering([P[i][0] + Nn[i][0] * sg * (edgeU - 0.2), P[i][1] + Nn[i][1] * sg * (edgeU - 0.2)], z[i], e, -0.5, 0.4)) need[i] = 0;
    }
    need = closeSmallGaps(need, 3);
    if (kind === 'jersey') profileSweep(L, P, z, Nn, edgeU, sg, JERSEY, 'barrier', need);
    else if (kind === 'parapet') profileSweep(L, P, z.map((v) => v + CURB), Nn, edgeU, sg, [[0.1, -0.05], [0.1, 1.05], [-0.15, 1.05], [-0.15, 0.0]], 'barrier', need);
    else {
      profileSweep(L, P, z, Nn, edgeU, sg, [[0.35, 0.45], [0.35, 0.78], [0.25, 0.80], [0.25, 0.43]], 'guardrail', need);
      for (let i = 0; i < n; i++) {                // posts every 4 m
        if (need[i] && Math.floor(ss[i] / 4) !== Math.floor(ss[Math.max(i - 1, 0)] / 4)) {
          post(L, [P[i][0] + Nn[i][0] * sg * (edgeU + 0.4), P[i][1] + Nn[i][1] * sg * (edgeU + 0.4)], z[i], [Nn[i][1], -Nn[i][0]]);
        }
      }
    }
  }
  if (cls === 'freeway') {
    const mask = Uint8Array.from(tun, (t, i) => !t && !idx.covering(P[i], z[i], e, 0, 1.0));
    const prof = [[-0.30, 0.0], [-0.30, 0.1], [-0.12, 0.35], [-0.04, 0.85], [0.04, 0.85], [0.12, 0.35], [0.30, 0.1], [0.30, 0.0]].reverse();
    stripMasked(L, P.map((p, i) => prof.map(([du, h]) => [p[0] + Nn[i][0] * du, p[1] + Nn[i][1] * du, z[i] + h])), 'barrier', mask);
  }
}

function post(L, p, z, Tn) {
  const s = 0.08, nrm = [-Tn[1], Tn[0]];
  const c = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, b]) => [p[0] + Tn[0] * s * a + nrm[0] * s * b, p[1] + Tn[1] * s * a + nrm[1] * s * b]);
  L.add([...c.map((q) => [q[0], q[1], z - 0.3]), ...c.map((q) => [q[0], q[1], z + 0.8])],
    [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]], 'metal');
}

function box(L, c, t, nrm, ht, hn, z0, z1, mat) {
  const pts = [[ht, hn], [-ht, hn], [-ht, -hn], [ht, -hn]].map(([a, b]) => [c[0] + t[0] * a + nrm[0] * b, c[1] + t[1] * a + nrm[1] * b]);
  L.add([...pts.map((q) => [q[0], q[1], z0]), ...pts.map((q) => [q[0], q[1], z1])],
    [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7], [3, 2, 1, 0]], mat);
}

// ---------------------------------------------------------------- bents
/** Shared pier bents: at each station one cap beam spanning every elevated deck at that level,
 *  columns every ~11 m under it. Returns one Bufs for the whole network. */
export function buildBents(edges, idx, ground, spacing = 32) {
  const L = new Bufs();
  const decks = edges.filter((e) => e.elev.some(Boolean));
  const arr = [], cell = 25, H = new Map();
  for (const e of decks) for (let i = 0; i < e.P.length; i += 2) {
    if (e.elev[i] && !e.tunnel[i]) arr.push([e.P[i][0], e.P[i][1], e.z[i], e.hw + e.c.side]);
  }
  if (!arr.length) return L;
  arr.forEach(([x, y], k) => { const key = Math.floor(x / cell) + ',' + Math.floor(y / cell); let b = H.get(key); if (!b) H.set(key, b = []); b.push(k); });
  const placed = [];
  const order = decks.map((e, i) => [e, i]).sort((a, b) => b[0].hw - a[0].hw || a[1] - b[1]).map(([e]) => e);
  for (const e of order) {
    let s = e.trim[0] + spacing / 2;
    while (s < e.L - e.trim[1]) {
      const i = Math.min(Math.max(searchsorted(e.s, s), 0), e.P.length - 1);
      s += spacing;
      if (!e.elev[i] || e.tunnel[i]) continue;
      const p = e.P[i], zz = e.z[i];
      let near = false;
      for (let k = Math.max(0, placed.length - 400); k < placed.length; k++) {
        const q = placed[k]; if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 < (spacing * 0.6) ** 2) { near = true; break; }
      }
      if (near) continue;
      const a = e.P[Math.min(i + 2, e.P.length - 1)], b = e.P[Math.max(i - 2, 0)];
      const t = unit([a[0] - b[0], a[1] - b[1]]), n = [-t[1], t[0]];
      const W0 = e.hw + e.c.side, ivs = [[-W0, W0]];
      const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
        for (const k of H.get((gx + dx) + ',' + (gy + dy)) ?? []) {
          const [x, y, z, w] = arr[k];
          if (Math.abs(z - zz) > 2.5) continue;
          const vx = x - p[0], vy = y - p[1];
          if (Math.abs(vx * t[0] + vy * t[1]) > 4) continue;
          const u = vx * n[0] + vy * n[1];
          if (Math.abs(u) > 45) continue;
          ivs.push([u - w, u + w]);
        }
      }
      // only decks that touch the one we stand on form a single structure
      ivs.sort((A, B) => A[0] - B[0] || A[1] - B[1]);
      let [lo, hi] = ivs[0];
      const merged = [];
      for (const [a_, b_] of ivs.slice(1)) { if (a_ <= hi + 0.5) hi = Math.max(hi, b_); else { merged.push([lo, hi]); lo = a_; hi = b_; } }
      merged.push([lo, hi]);
      [lo, hi] = merged.find((m) => m[0] <= 0 && 0 <= m[1]) ?? merged[0];
      const g = ground(p[0], p[1]), top = zz - 1.7;
      if (top - Math.max(g, 0) < 2.5) continue;
      const bot = (g > 0 ? g : g - 1) - 1.5;
      const mid = [p[0] + n[0] * (lo + hi) / 2, p[1] + n[1] * (lo + hi) / 2], half = (hi - lo) / 2 - 0.8;
      if (hi - lo >= 12) box(L, mid, t, n, 1.1, half, top - 1.4, top, 'concrete');     // cap beam
      const ncol = hi - lo < 12 ? 1 : Math.max(2, roundHalfEven((hi - lo) / 11));
      for (let c = 0; c < ncol; c++) {
        const u = lo + ((hi - lo) * (c + 0.5)) / ncol;
        const q = ncol > 1 ? [p[0] + n[0] * u, p[1] + n[1] * u] : mid;
        if (idx.groundRoadNear(q, zz, 1.0)) continue;
        box(L, q, t, n, 0.9, 0.9, bot, ncol > 1 ? top - 1.4 : top, 'concrete');
      }
      placed.push(p);
    }
  }
  return L;
}

function tunnel(e, L, P, z, Nn, tun) {
  const W = e.hw + 0.8, H = 7.0;
  const m = Uint8Array.from(tun);
  for (let i = 1; i < m.length; i++) m[i] |= tun[i - 1];
  const left = [[W, 0], [W, H - 1], [W - 2, H], [0, H + 0.3]];
  const prof = [...left, ...left.slice().reverse().slice(1).map(([u, h]) => [-u, h])].reverse();
  stripMasked(L, P.map((p, i) => prof.map(([u, h]) => [p[0] + Nn[i][0] * u, p[1] + Nn[i][1] * u, z[i] + h])), 'tunnel', m);
  stripMasked(L, P.map((p, i) => [[p[0] - Nn[i][0] * 0.4, p[1] - Nn[i][1] * 0.4, z[i] + H + 0.25], [p[0] + Nn[i][0] * 0.4, p[1] + Nn[i][1] * 0.4, z[i] + H + 0.25]]), 'tunnel_light', m);
}

// ---------------------------------------------------------------- junction pads / transitions
function bez(a, c, b, k = 8) {
  return linspace(0, 1, k).map((t) => [(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]]);
}
function fillet(A, dA, B, dB) {
  const r = lineIntersect(A, dA, B, dB);
  if (r && r[0] < -0.5 && r[1] < -0.5 && Math.abs(r[0]) < 120 && Math.abs(r[1]) < 120) return bez(A, [A[0] + dA[0] * r[0], A[1] + dA[1] * r[0]], B);
  return [A, B];
}
function armEnds(nd) {
  const out = [];
  for (const [e, k] of nd.edges) {
    if (e.L < 0.5) continue;
    const s = k === 0 ? e.trim[k] : e.L - e.trim[k];
    const xs = e.xs ??= e.P.map((p) => p[0]), ys = e.ys ??= e.P.map((p) => p[1]);
    const p = [interp(s, e.s, xs), interp(s, e.s, ys)], d0 = tangentAt(e, s), d = k === 0 ? d0 : [-d0[0], -d0[1]];
    out.push({ e, p, d, z: interp(s, e.s, e.z), W: e.hw, S: e.c.side });
  }
  return out;
}

/** Two roads meeting end to end (class change or bend): loft between their end sections. */
export function buildTransition(nd, L) {
  const ends = armEnds(nd);
  if (ends.length !== 2) return;
  const [A, B] = ends;
  const Ln = Math.max(Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]), 1);
  const t = linspace(0, 1, Math.max(6, Math.floor(Ln / 3)));
  const m0 = [-A.d[0] * Ln, -A.d[1] * Ln], m1 = [B.d[0] * Ln, B.d[1] * Ln];
  const P = t.map((x) => {
    const h00 = 2 * x ** 3 - 3 * x ** 2 + 1, h10 = x ** 3 - 2 * x ** 2 + x, h01 = -2 * x ** 3 + 3 * x ** 2, h11 = x ** 3 - x ** 2;
    return [h00 * A.p[0] + h10 * m0[0] + h01 * B.p[0] + h11 * m1[0], h00 * A.p[1] + h10 * m0[1] + h01 * B.p[1] + h11 * m1[1]];
  });
  const Nn = tangents(P).map(leftNormal);
  // end sections must be exactly the arms' own sections, or slivers open along the seams
  for (const [i, dd] of [[0, [-A.d[0], -A.d[1]]], [P.length - 1, B.d]]) {
    const n_ = leftNormal(dd);
    Nn[i] = n_[0] * Nn[i][0] + n_[1] * Nn[i][1] >= 0 ? n_ : [-n_[0], -n_[1]];
  }
  const ts = t.map((x) => x * x * (3 - 2 * x));
  const W = ts.map((s) => A.W + (B.W - A.W) * s), S = ts.map((s) => A.S + (B.S - A.S) * s), z = ts.map((s) => A.z + (B.z - A.z) * s);
  const row = (U, dz) => P.map((p, i) => [p[0] + Nn[i][0] * U[i], p[1] + Nn[i][1] * U[i], z[i] + (typeof dz === 'number' ? dz : dz[i])]);
  const zip = (a, b) => a.map((x, i) => [x, b[i]]);
  const neg = (U) => U.map((v) => -v), add = (a, b) => a.map((v, i) => v + b[i]);
  L.strip(zip(row(W, 0), row(neg(W), 0)), 'asphalt');
  const hasSide = Math.max(...S) > 0.05;
  for (const sg of [1, -1]) {
    const Wsg = sg > 0 ? W : neg(W), Osg = sg > 0 ? add(W, S) : neg(add(W, S));
    if (hasSide) {
      L.strip(sg > 0 ? zip(row(Osg, CURB), row(Wsg, CURB)) : zip(row(Wsg, CURB), row(Osg, CURB)), 'sidewalk');
      L.strip(sg > 0 ? zip(row(Wsg, CURB), row(Wsg, 0)) : zip(row(Wsg, 0), row(Wsg, CURB)), 'curb');
    }
    const out = row(Osg, -1.3), top = row(Osg, S.map((v) => (v > 0.05 ? CURB : 0)));
    L.strip(sg > 0 ? zip(out, top) : zip(top, out), 'concrete');
  }
}

export function buildPad(nd, L) {
  const arms = armEnds(nd).map((a) => {
    const dx = a.p[0] - nd.pos[0], dy = a.p[1] - nd.pos[1];
    return { ...a, ang: Math.hypot(dx, dy) > 0.5 ? Math.atan2(dy, dx) : Math.atan2(a.d[1], a.d[0]) };
  });
  if (arms.length < 2) return;
  arms.sort((a, b) => a.ang - b.ang);
  const poly = [], corners = [];
  arms.forEach((A, i) => {
    const B = arms[(i + 1) % arms.length], nA = leftNormal(A.d), nB = leftNormal(B.d);
    const RA = [A.p[0] - nA[0] * A.W, A.p[1] - nA[1] * A.W], LA = [A.p[0] + nA[0] * A.W, A.p[1] + nA[1] * A.W];
    const RB = [B.p[0] - nB[0] * B.W, B.p[1] - nB[1] * B.W];
    const curve = fillet(LA, A.d, RB, B.d);
    poly.push(RA, ...curve);
    if (A.S > 0 || B.S > 0) {
      const LAo = [A.p[0] + nA[0] * (A.W + A.S), A.p[1] + nA[1] * (A.W + A.S)], RBo = [B.p[0] - nB[0] * (B.W + B.S), B.p[1] - nB[1] * (B.W + B.S)];
      corners.push([curve, fillet(LAo, A.d, RBo, B.d)]);
    }
  });
  const G = nd.grad ?? [0, 0], zp = (q) => nd.z + (q[0] - nd.pos[0]) * G[0] + (q[1] - nd.pos[1]) * G[1];
  L.add([[nd.pos[0], nd.pos[1], nd.z], ...poly.map((q) => [q[0], q[1], zp(q)])], poly.map((_, i) => [0, i + 1, ((i + 1) % poly.length) + 1]), 'asphalt');
  for (const [inner0, outer0] of corners) {
    const k = Math.max(inner0.length, outer0.length), inner = resampleN(inner0, k), outer = resampleN(outer0, k);
    const topI = inner.map((q) => [q[0], q[1], zp(q) + CURB]), topO = outer.map((q) => [q[0], q[1], zp(q) + CURB]);
    L.strip(topI.map((a, i) => [a, topO[i]]), 'sidewalk');
    L.strip(inner.map((q, i) => [[q[0], q[1], zp(q)], topI[i]]), 'curb');
    L.strip(topO.map((a, i) => [a, [outer[i][0], outer[i][1], zp(outer[i]) - 1.3]]), 'concrete');
  }
}

// ---------------------------------------------------------------- whole network
/** Build every owner's mesh. Returns { edges: Map(id -> Bufs), nodes: Map(id -> Bufs), bents: Bufs, idx }. */
export function buildRoadMesh(net, ground) {
  const idx = new RoadIndex(net.edges);
  const out = { edges: new Map(), nodes: new Map(), idx };
  for (const e of net.edges) { const L = new Bufs(); buildEdge(e, L, idx, ground); out.edges.set(e.id, L); }
  out.bents = buildBents(net.edges, idx, ground);
  for (const nd of net.nodes) out.nodes.set(nd.id, buildNode(nd));
  return out;
}
export function buildNode(nd) {
  const L = new Bufs();
  if (nd.kind === 'junction') buildPad(nd, L);
  else if (nd.kind === 'transition') buildTransition(nd, L);
  return L;
}

/** Merge Bufs into { material: { v: Float32Array, i: Uint32Array } } (the old roads.mesh shape). */
export function mergeBufs(list) {
  const out = {};
  for (const L of list) for (const [mat, B] of Object.entries(L.m)) (out[mat] ??= []).push(B);
  for (const [mat, parts] of Object.entries(out)) {
    let nv = 0, ni = 0;
    for (const B of parts) { nv += B.v.length; ni += B.i.length; }
    const v = new Float32Array(nv), i = new Uint32Array(ni);
    let ov = 0, oi = 0;
    for (const B of parts) { v.set(B.v, ov); for (let k = 0; k < B.i.length; k++) i[oi + k] = B.i[k] + ov / 3; ov += B.v.length; oi += B.i.length; }
    out[mat] = { v, i };
  }
  return out;
}
export { cumLength };
