// 2D polyline helpers (port of the Python generator's geom.py, see the first git commit). Points are [x, y] arrays; numbers are metres.

export const unit = (v) => { const n = Math.max(Math.hypot(v[0], v[1]), 1e-9); return [v[0] / n, v[1] / n]; };
export const leftNormal = (t) => [-t[1], t[0]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function cumLength(P) {
  const s = new Float64Array(P.length);
  for (let i = 1; i < P.length; i++) s[i] = s[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
  return s;
}

/** numpy.interp: piecewise linear, clamped at the ends. xs ascending. */
export function interp(x, xs, ys) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const d = xs[hi] - xs[lo];
  return d > 0 ? ys[lo] + (ys[hi] - ys[lo]) * ((x - xs[lo]) / d) : ys[hi];
}

/** numpy.searchsorted(a, v) (side='left'): first i with a[i] >= v. */
export function searchsorted(a, v) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

export function linspace(a, b, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = n === 1 ? a : a + ((b - a) * i) / (n - 1);
  return out;
}

/** Unit tangents of a polyline: central differences, one-sided at the ends. */
export function tangents(P) {
  const n = P.length, T = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = P[i === 0 ? 0 : i === n - 1 ? n - 2 : i - 1], b = P[i === 0 ? 1 : i === n - 1 ? n - 1 : i + 1];
    T[i] = unit([b[0] - a[0], b[1] - a[1]]);
  }
  return T;
}

/** Intersection of infinite lines p + t d and q + u e -> [t, u] or null. */
export function lineIntersect(p, d, q, e) {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-9) return null;
  const qx = q[0] - p[0], qy = q[1] - p[1];
  return [(qx * e[1] - qy * e[0]) / den, (qx * d[1] - qy * d[0]) / den];
}

/** Proper intersection of segments -> [t, u] or null. */
export function segIntersect(p1, p2, q1, q2) {
  const rx = p2[0] - p1[0], ry = p2[1] - p1[1], sx = q2[0] - q1[0], sy = q2[1] - q1[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = q1[0] - p1[0], qy = q1[1] - p1[1];
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
}

/** Closest point on polyline P to x -> { d, i (segment), t, q }. */
export function projectToPolyline(P, x) {
  let best = { d: Infinity, i: 0, t: 0, q: P[0] };
  for (let i = 0; i + 1 < P.length; i++) {
    const a = P[i], b = P[i + 1], abx = b[0] - a[0], aby = b[1] - a[1];
    const t = clamp(((x[0] - a[0]) * abx + (x[1] - a[1]) * aby) / Math.max(abx * abx + aby * aby, 1e-12), 0, 1);
    const qx = a[0] + abx * t, qy = a[1] + aby * t, d = Math.hypot(qx - x[0], qy - x[1]);
    if (d < best.d) best = { d, i, t, q: [qx, qy] };
  }
  return best;
}

/** Gaussian smoothing of uniformly spaced samples z(s), edge values held (geom.gaussian_smooth). */
export function gaussianSmooth(z, s, sigma) {
  const n = z.length;
  if (n < 3 || sigma <= 0) return Float64Array.from(z);
  const ds = (s[n - 1] - s[0]) / (n - 1);
  const k = Math.max(1, Math.floor((3 * sigma) / ds));
  const w = new Float64Array(2 * k + 1);
  let sum = 0;
  for (let j = -k; j <= k; j++) { const x = j * ds; w[j + k] = Math.exp(-0.5 * (x / sigma) ** 2); sum += w[j + k]; }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -k; j <= k; j++) acc += w[j + k] * z[clamp(i + j, 0, n - 1)];
    out[i] = acc / sum;
  }
  return out;
}

/** Python round(): halves go to the even neighbour. */
export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Resample a polyline to k points evenly spaced along its length. */
export function resampleN(C, k) {
  const s = cumLength(C), L = s[s.length - 1];
  if (L < 1e-6) return Array.from({ length: k }, () => [C[0][0], C[0][1]]);
  const xs = C.map((p) => p[0]), ys = C.map((p) => p[1]);
  return linspace(0, L, k).map((t) => [interp(t, s, xs), interp(t, s, ys)]);
}
