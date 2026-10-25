// Terrain graded to the road network like a civil engineer would (port of ground.carve_engineered):
// a flat verge along every road, then a cut face or embankment at a constant slope until it meets
// the natural ground (terrain.base). Works on any window of the grid, so an edit re-grades only
// the area around the changed roads.
import { interp, smoothstep, cumLength } from './geom.js';

export const CUT_SLOPE = 1.25, FILL_SLOPE = 0.6, TUNNEL_COVER = 8.0, VERGE = 1.2;
export const REACH = 120;                 // how far a road's slopes can reach beyond its verge

/** Window of grid cells (inclusive) a road edge can influence. */
export function edgeWindow(t, e) {
  const reach = e.hwt + VERGE + REACH;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of e.P) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return cellBox(t, x0 - reach, y0 - reach, x1 + reach, y1 + reach);
}
export function cellBox(t, xa, ya, xb, yb) {
  return [Math.max(0, Math.floor((xa - t.x0) / t.res)), Math.max(0, Math.floor((ya - t.y0) / t.res)),
    Math.min(t.nx - 1, Math.ceil((xb - t.x0) / t.res)), Math.min(t.ny - 1, Math.ceil((yb - t.y0) / t.res))];
}
const overlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/**
 * Re-grade cells [i0..i1] x [j0..j1] (i = column/x, j = row/y) of terrain.h from terrain.base.
 * Returns the bored cells (global indices) inside the window.
 */
export function carveRegion(t, net, box = [0, 0, t.nx - 1, t.ny - 1]) {
  const [i0, j0, i1, j1] = box, W = i1 - i0 + 1, Hh = j1 - j0 + 1, n = W * Hh, res = t.res;
  const upper = new Float64Array(n).fill(Infinity), lower = new Float64Array(n).fill(-Infinity);
  const under = new Float64Array(n).fill(Infinity), roof = new Float64Array(n).fill(-Infinity);
  const nearest = new Float64Array(n).fill(Infinity), nearZ = new Float64Array(n), bored = new Uint8Array(n);
  for (const e of net.edges) {
    if (e.L < 1) continue;
    const m = e.P.length, ground = new Uint8Array(m), deck = new Uint8Array(m);
    let anyTun = false, anyDeck = false;
    for (let k = 0; k < m; k++) { ground[k] = !(e.elev[k] || e.tunnel[k]); deck[k] = !e.tunnel[k]; anyTun ||= !!e.tunnel[k]; anyDeck ||= !!deck[k]; }
    if (anyTun && anyDeck) {
      // set the portal face back into the hill, past the grid cell straddling the mouth
      const so = []; for (let k = 0; k < m; k++) if (deck[k]) so.push(e.s[k]);
      const lim = Math.max(10, res * 1.6);
      for (let k = 0; k < m; k++) if (!deck[k]) { for (const v of so) if (Math.abs(e.s[k] - v) <= lim) { deck[k] = 1; break; } }
    }
    if (!anyDeck) continue;
    const w = e.hwt + VERGE, reach = w + REACH;
    const win = edgeWindow(t, e);
    if (!overlap(win, box)) continue;
    const a0 = Math.max(win[0], i0), b0 = Math.max(win[1], j0), a1 = Math.min(win[2], i1), b1 = Math.min(win[3], j1);
    const ww = a1 - a0 + 1, wh = b1 - b0 + 1;
    // nearest point on the coarse centreline (every 3rd sample) for every cell within reach
    const Pc = []; for (let k = 0; k < m; k += 3) Pc.push(e.P[k]);
    const last = e.P[m - 1], pl = Pc[Pc.length - 1];
    if (Math.abs(pl[0] - last[0]) > 1e-8 || Math.abs(pl[1] - last[1]) > 1e-8) Pc.push(last);
    if (Pc.length < 2) continue;
    const sc = cumLength(Pc), scale = e.L / Math.max(sc[sc.length - 1], 1e-6);
    const D = new Float64Array(ww * wh).fill(Infinity), S = new Float64Array(ww * wh);
    for (let k = 0; k + 1 < Pc.length; k++) {
      const ax = Pc[k][0], ay = Pc[k][1], abx = Pc[k + 1][0] - ax, aby = Pc[k + 1][1] - ay;
      const L2 = Math.max(abx * abx + aby * aby, 1e-12), Lseg = Math.sqrt(L2);
      const ca = Math.max(a0, Math.floor((Math.min(ax, ax + abx) - reach - t.x0) / res)), cb = Math.min(a1, Math.ceil((Math.max(ax, ax + abx) + reach - t.x0) / res));
      const ra = Math.max(b0, Math.floor((Math.min(ay, ay + aby) - reach - t.y0) / res)), rb = Math.min(b1, Math.ceil((Math.max(ay, ay + aby) + reach - t.y0) / res));
      for (let j = ra; j <= rb; j++) {
        const y = t.y0 + j * res;
        for (let i = ca; i <= cb; i++) {
          const x = t.x0 + i * res;
          let u = ((x - ax) * abx + (y - ay) * aby) / L2; u = u < 0 ? 0 : u > 1 ? 1 : u;
          const d = Math.hypot(x - ax - abx * u, y - ay - aby * u), q = (j - b0) * ww + (i - a0);
          if (d < D[q]) { D[q] = d; S[q] = sc[k] + u * Lseg; }
        }
      }
    }
    // inside a transition loft the paved width is that of the wider road it blends into
    const wide = new Float64Array(m);
    for (const k of [0, 1]) {
      const nd = e.n[k];
      if (nd?.kind !== 'transition' || !(e.trim[k] > 0)) continue;
      const other = Math.max(...nd.edges.map(([x]) => x.hwt));
      for (let q = 0; q < m; q++) {
        const ss = k === 0 ? e.s[q] : e.L - e.s[q];
        wide[q] = Math.max(wide[q], (other - e.hwt) * (1 - Math.min(Math.max(ss / e.trim[k], 0), 1)));
      }
    }
    const wb = e.hw + 0.8 + res, insR = e.hwt + Math.max(2.5, res * 1.5);
    for (let j = b0; j <= b1; j++) for (let i = a0; i <= a1; i++) {
      const q = (j - b0) * ww + (i - a0), d = D[q];
      if (!(d < reach)) continue;
      const s = S[q] * scale, zr = interp(s, e.s, e.z), xw = interp(s, e.s, wide);
      const gr = interp(s, e.s, ground) > 0.5, dk = interp(s, e.s, deck) > 0.5;
      const c = (j - j0) * W + (i - i0);
      if (!dk && d <= wb) bored[c] = 1;
      // bury the tube: full cover over the bore, then an embankment slope down to the hillside
      if (!dk) roof[c] = Math.max(roof[c], zr + TUNNEL_COVER - FILL_SLOPE * Math.max(d - wb, 0));
      if (gr) {
        // beyond the ends of the edge the junction pads take over: no slope constraints there
        const endish = s <= 0.5 || s >= e.L - 0.5, dd = Math.max(d - w - xw, 0);
        upper[c] = Math.min(upper[c], zr + 0.12 + CUT_SLOPE * dd);
        if (!endish) lower[c] = Math.max(lower[c], zr - 0.05 - FILL_SLOPE * dd);
        else if (d < w + xw) lower[c] = Math.max(lower[c], zr - 0.05);
        if (d < nearest[c]) { nearest[c] = d; nearZ[c] = zr; }
      }
      // 0.6 m below the carriageway, rising to a verge flush with the asphalt edge
      if (dk && d <= insR + xw) under[c] = Math.min(under[c], zr - 0.6 + 0.52 * smoothstep(e.hw + xw - 1, e.hwt + xw, d));
    }
  }
  const base = t.base, h = t.h, bore = [];
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const c = (j - j0) * W + (i - i0), k = j * t.nx + i;
    let H = Math.min(Math.max(base[k], lower[c]), upper[c]);
    if (lower[c] > upper[c]) H = nearZ[c] - 0.05;
    const rf = bored[c] ? roof[c] : Math.min(roof[c], upper[c]);
    h[k] = Math.min(Math.max(H, rf), under[c]);
    if (bored[c]) bore.push(k);
  }
  return bore;
}

/** Re-grade a window and splice its bored cells into terrain.bore. */
export function regrade(t, net, box) {
  const bore = carveRegion(t, net, box), [i0, j0, i1, j1] = box;
  const keep = [];
  for (const k of t.bore ?? []) { const i = k % t.nx, j = (k / t.nx) | 0; if (i < i0 || i > i1 || j < j0 || j > j1) keep.push(k); }
  t.bore = Uint32Array.from([...keep, ...bore].sort((a, b) => a - b));
}
