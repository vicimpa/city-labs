// Road alignment and vertical profile (ports of geom.fillet_path / resample and network.profile,
// grade_limit, vertical_fair, the per-edge part of compute_node_z and finalize's elev/tunnel rule).
import { cumLength, interp, gaussianSmooth, smoothstep, searchsorted } from './geom.js';

export const SPACING = 4.0, BANK_LEVEL = 3.0;

/** Polyline through control points with corners rounded by circular arcs of radius r[i]. */
export function filletPath(C, radii, arcStep = 2.0) {
  const n = C.length, info = new Array(n).fill(null), T = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const a = C[i - 1], p = C[i], b = C[i + 1];
    let d1 = [p[0] - a[0], p[1] - a[1]], d2 = [b[0] - p[0], b[1] - p[1]];
    const l1 = Math.hypot(...d1), l2 = Math.hypot(...d2);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    d1 = [d1[0] / l1, d1[1] / l1]; d2 = [d2[0] / l2, d2[1] / l2];
    const phi = Math.acos(Math.min(1, Math.max(-1, d1[0] * d2[0] + d1[1] * d2[1])));
    if (phi < 1e-3 || radii[i] <= 0) continue;
    info[i] = [d1, d2, phi]; T[i] = radii[i] * Math.tan(phi / 2);
  }
  for (let it = 0; it < 3; it++) for (let i = 0; i < n - 1; i++) {
    const l = Math.hypot(C[i + 1][0] - C[i][0], C[i + 1][1] - C[i][1]) * 0.98;
    if (T[i] + T[i + 1] > l) { const k = l / (T[i] + T[i + 1]); T[i] *= k; T[i + 1] *= k; }
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!info[i] || T[i] < 1e-3) { out.push([C[i][0], C[i][1]]); continue; }
    const [d1, d2, phi] = info[i], p = C[i], r = T[i] / Math.tan(phi / 2);
    const p0 = [p[0] - d1[0] * T[i], p[1] - d1[1] * T[i]], p1 = [p[0] + d2[0] * T[i], p[1] + d2[1] * T[i]];
    const sgn = d1[0] * d2[1] - d1[1] * d2[0] > 0 ? 1 : -1;
    const ctr = [p0[0] - d1[1] * sgn * r, p0[1] + d1[0] * sgn * r];
    const a0 = Math.atan2(p0[1] - ctr[1], p0[0] - ctr[0]), a1 = Math.atan2(p1[1] - ctr[1], p1[0] - ctr[0]);
    let da = a1 - a0;
    if (sgn > 0 && da < 0) da += 2 * Math.PI;
    if (sgn < 0 && da > 0) da -= 2 * Math.PI;
    const k = Math.max(2, Math.floor((Math.abs(da) * r) / arcStep) + 1);
    for (let j = 0; j < k; j++) { const a = a0 + (da * j) / (k - 1); out.push([ctr[0] + r * Math.cos(a), ctr[1] + r * Math.sin(a)]); }
  }
  return out.filter((q, i) => i === 0 || Math.hypot(q[0] - out[i - 1][0], q[1] - out[i - 1][1]) > 1e-6);
}

/** Uniform arc-length resampling (geom.resample). */
export function resample(P, spacing = SPACING) {
  const s = cumLength(P), L = s[s.length - 1], n = Math.max(2, Math.round(L / spacing) + 1);
  const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
  return Array.from({ length: n }, (_, i) => { const t = (L * i) / (n - 1); return [interp(t, s, xs), interp(t, s, ys)]; });
}

/** Limit slope to g while staying as close as possible to z. */
export function gradeLimit(z, ds, g) {
  const step = g * ds;
  const sweep = (a, rev) => {
    a = Float64Array.from(a);
    if (rev) for (let i = a.length - 2; i >= 0; i--) a[i] = Math.min(Math.max(a[i], a[i + 1] - step), a[i + 1] + step);
    else for (let i = 1; i < a.length; i++) a[i] = Math.min(Math.max(a[i], a[i - 1] - step), a[i - 1] + step);
    return a;
  };
  const f = sweep(z, false), b = sweep(z, true);
  let out = f.map((v, i) => 0.5 * (v + b[i]));
  for (let k = 0; k < 3; k++) out = sweep(sweep(out, false), true);
  return out;
}

/** Grade limit along an edge while pinned samples keep their level. */
export function gradeLimitPinned(z, s, g, pins) {
  const out = Float64Array.from(z);
  for (let it = 0; it < 4; it++) {
    for (let i = 1; i < out.length; i++) if (!pins[i]) { const st = g * Math.max(s[i] - s[i - 1], 1e-6); out[i] = Math.min(Math.max(out[i], out[i - 1] - st), out[i - 1] + st); }
    for (let i = out.length - 2; i >= 0; i--) if (!pins[i]) { const st = g * Math.max(s[i + 1] - s[i], 1e-6); out[i] = Math.min(Math.max(out[i], out[i + 1] - st), out[i + 1] + st); }
  }
  return out;
}

/**
 * Vertical profile of one edge over natural ground: smoothed terrain line, grade-limited,
 * blended onto its end nodes' levels (pads tilt with node.grad), then faired to the class K.
 * e: edge view (P, s, L, trim, c, n); ground(x,y): natural height; ends[k] = node level or null.
 * Returns { z, elev, tunnel } arrays.
 */
export function edgeProfile(e, ground, ends = [null, null], grads = [[0, 0], [0, 0]], nodePos = [null, null]) {
  const c = e.c, n = e.P.length, g = c.max_grade ?? 0.1;
  const N = e.P.map((p) => ground(p[0], p[1]));
  const ds = n > 1 ? e.L / (n - 1) : SPACING;
  let z = gradeLimit(gaussianSmooth(N.map((v) => Math.max(v, BANK_LEVEL)), e.s, c.sigma ?? 40), ds, g);
  // carry the end levels inward over a span long enough for the grade (compute_node_z)
  const raw = z, inner = Math.max(e.L - e.trim[0] - e.trim[1], 1);
  const off = [0, 1].map((k) => (ends[k] == null ? null : ends[k] - (k === 0 ? raw[0] : raw[n - 1])));
  const spans = [0, 1].map((k) => (off[k] == null ? 0 : Math.min(Math.max(Math.abs(off[k]) / (0.5 * g), 40, Math.min(150, e.L * 0.5)), e.L)));
  if (off[0] != null && off[1] != null && (e.L < 200 || spans[0] + spans[1] > inner)) {
    z = raw.map((v, i) => {
      const t = smoothstep(e.trim[0], e.L - e.trim[1], e.s[i]);
      return e.L < 200 ? ends[0] + (ends[1] - ends[0]) * t : v + off[0] * (1 - t) + off[1] * t;
    });
  } else {
    z = raw.map((v, i) => {
      let r = v;
      for (const k of [0, 1]) if (off[k] != null) { const ss = k === 0 ? e.s[i] : e.L - e.s[i]; r += off[k] * (1 - smoothstep(e.trim[k], e.trim[k] + spans[k], ss)); }
      return r;
    });
  }
  const pins = new Uint8Array(n);
  for (const k of [0, 1]) {
    if (ends[k] == null) continue;
    const G = grads[k] ?? [0, 0], np = nodePos[k] ?? e.P[k === 0 ? 0 : n - 1];
    for (let i = 0; i < n; i++) {
      const ss = k === 0 ? e.s[i] : e.L - e.s[i], f = 1 - smoothstep(e.trim[k], e.trim[k] + 10, ss);
      const plane = ends[k] + (e.P[i][0] - np[0]) * G[0] + (e.P[i][1] - np[1]) * G[1];
      z[i] = z[i] * (1 - f) + plane * f;
      if (ss <= e.trim[k]) pins[i] = 1;
    }
  }
  z = gradeLimitPinned(z, e.s, g, pins);
  z = verticalFair(e, z);
  return { z, ...levelFlags(e, z, N) };
}

/** Final vertical smoothing so grade changes respect the class K value (vertical_fair). */
export function verticalFair(e, z) {
  const n = z.length;
  if (n < 6) return z;
  const pins = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (e.s[i] <= e.trim[0] || e.L - e.s[i] <= e.trim[1]) pins[i] = 1;
  const sigma = Math.max(6, (e.c.k_min ?? 12) * 1.8), base = gradeLimitPinned(z, e.s, e.c.max_grade ?? 0.1, pins);
  let out = base;
  for (let k = 0; k < 3; k++) out = gaussianSmooth(out, e.s, sigma);
  // pull the smoothed profile back onto the pinned junction pads with a long, smooth fade
  for (const k of [0, 1]) {
    const edge = e.trim[k];
    const idx = Math.min(Math.max(k === 0 ? searchsorted(e.s, edge) : searchsorted(e.s, e.L - edge) - 1, 0), n - 1);
    const delta = base[idx] - out[idx];
    out = out.map((v, i) => v + delta * (1 - smoothstep(edge, edge + 2.5 * sigma, k === 0 ? e.s[i] : e.L - e.s[i])));
  }
  return out.map((v, i) => (pins[i] ? base[i] : v));
}

/** Bridges where the deck is >3 m over natural ground; tunnels where >7.5 m under it for over 80 m. */
export function levelFlags(e, z, N) {
  const n = z.length, elev = new Array(n), tunnel = new Array(n).fill(0);
  for (let i = 0; i < n; i++) elev[i] = z[i] - N[i] > 3 ? 1 : 0;
  for (let i = 0; i < n;) {
    if (!(N[i] - z[i] > 7.5)) { i++; continue; }
    let j = i; while (j < n && N[j] - z[j] > 7.5) j++;
    if (e.s[j - 1] - e.s[i] > 80) tunnel.fill(1, i, j);
    i = j;
  }
  return { elev, tunnel };
}
