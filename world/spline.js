// Editing dense polylines (road axes, railways, train routes) through a few control points.
// Control points are found by simplifying the polyline. Moving or removing one changes only the
// stretch up to the second control point on each side, as a smooth change of the line's own shape,
// so the rest of the line stays exactly as it was and the joins keep their tangents.

/** Indices of the points that carry the shape: Douglas–Peucker within `tol` m, at least every `maxGap` m. */
export function controlIndices(pts, tol = 1.0, maxGap = 80) {
  const n = pts.length;
  if (n <= 2) return [...Array(n).keys()];
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay, L = Math.hypot(dx, dy);
    let worst = -1, wd = tol, len = 0;
    for (let i = a + 1; i <= b; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    for (let i = a + 1; i < b; i++) {
      const d = L > 1e-6 ? Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L    // a loop: distance from its start
        : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst < 0 && len > maxGap && b - a > 1) worst = (a + b) >> 1;    // long straight stretches still get handles
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

// centripetal Catmull–Rom between p1 and p2 (p0, p3 the neighbours), at t in [0, 1]
function cr(p0, p1, p2, p3, t) {
  const d = (a, b) => Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], (b[2] ?? 0) - (a[2] ?? 0)) ** 0.5, 1e-4);
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3), u = t1 + (t2 - t1) * t;
  const lerp = (a, b, ta, tb) => a.map((v, k) => (tb === ta ? v : ((tb - u) * v + (u - ta) * b[k]) / (tb - ta)));
  const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

// spline segment r of a control list (ends extended by reflection), at t in [0, 1]
function seg(L, r, t) {
  const p1 = L[r], p2 = L[r + 1];
  const p0 = L[r - 1] ?? p1.map((v, q) => 2 * v - p2[q]), p3 = L[r + 2] ?? p2.map((v, q) => 2 * v - p1[q]);
  return cr(p0, p1, p2, p3, t);
}
const dist2 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// uniform samples along a polyline Q (both ends kept), every ~step m; at[j] is the fraction along Q
function even(Q, step) {
  const s = [0];
  for (let i = 1; i < Q.length; i++) s.push(s[i - 1] + dist2(Q[i - 1], Q[i]));
  const L = s[s.length - 1], n = Math.max(1, Math.round(L / step)), out = [], at = [];
  let i = 0;
  for (let j = 0; j <= n; j++) {
    const u = (L * j) / n;
    while (i < Q.length - 2 && s[i + 1] < u) i++;
    const f = s[i + 1] > s[i] ? (u - s[i]) / (s[i + 1] - s[i]) : 0;
    out.push(j === 0 ? Q[0].slice() : j === n ? Q[Q.length - 1].slice() : Q[i].map((v, q) => v + (Q[i + 1][q] - v) * f));
    at.push(L > 0 ? u / L : j / n);
  }
  return { out, at };
}

/**
 * Change the control points of a polyline and re-draw the affected stretch.
 * op: { move: k, to: [x, y, z?] } or { remove: k } (k = index into C). step: sample spacing (m).
 * Moving a point shifts the line by a smooth bump that fades out at the second control point on
 * each side (C2 at the joins, flat at the top, so curves stay wide). Removing one replaces the line
 * between its neighbours by the spline through them; the next segments out bend to meet it smoothly.
 * Returns { pts, C, from } where from[j] is the old index each new point came from (to carry flags).
 */
export function reshape(pts, C, op, step = 4) {
  const m = C.length, k = op.move ?? op.remove, dim = pts[0].length, rm = op.remove !== undefined;
  const old = C.map((i) => pts[i].slice());
  const neu = old.map((p) => p.slice());
  if (!rm) neu[k] = Array.from({ length: dim }, (_, q) => op.to[q] ?? old[k][q] ?? 0);
  else neu.splice(k, 1);
  const a = Math.max(0, k - 2), b = Math.min(m - 1, k + 2);
  const moved = [];                                   // [{ p, j }]: the old points C[a] .. C[b], displaced
  if (!rm) {
    const S = [0];
    for (let i = C[a] + 1; i <= C[b]; i++) S.push(S[S.length - 1] + dist2(pts[i - 1], pts[i]));
    const sk = S[C[k] - C[a]], sb = S[S.length - 1], d = neu[k].map((v, q) => v - old[k][q]);
    const bump = (u) => u * u * u * (u * (u * 6 - 15) + 10);
    for (let i = C[a]; i <= C[b]; i++) {
      const si = S[i - C[a]];
      const w = i === C[k] ? 1 : si < sk ? (a < k && sk > 0 ? bump(si / sk) : 0) : b > k && sb > sk ? bump((sb - si) / (sb - sk)) : 0;
      moved.push({ p: pts[i].map((v, q) => v + (d[q] ?? 0) * w), j: i });
    }
  } else for (let r = a; r < b; r++) {
    const i0 = C[r], i1 = C[r + 1];
    let len = 0; const s = [0];
    for (let i = i0 + 1; i <= i1; i++) s.push((len += dist2(pts[i - 1], pts[i])));
    for (let i = r === a ? i0 : i0 + 1; i <= i1; i++) {
      const t = len > 0 ? s[i - i0] / len : (i - i0) / Math.max(i1 - i0, 1);
      let S1;
      if (r === k - 1 || r === k) {                // the two segments around the removed point merge
        const lo = C[k - 1], hi = C[k + 1];
        let tot = 0, at = 0;
        for (let q = lo + 1; q <= hi; q++) { const d = dist2(pts[q - 1], pts[q]); tot += d; if (q <= i) at += d; }
        S1 = seg(neu, k - 1, tot > 0 ? at / tot : 0);
      } else S1 = seg(neu, r < k ? r : r - 1, t);
      if (r === k - 1 || r === k) { moved.push({ p: S1.slice(0, dim), j: i }); continue; }   // the stretch itself: smooth
      const S0 = seg(old, r, t);
      moved.push({ p: pts[i].map((v, q) => v + (S1[q] ?? 0) - (S0[q] ?? 0)), j: i });
    }
  }
  // re-sample each new control segment of the stretch evenly
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const bounds = [];                                  // old point indices of the new control points in the stretch
  for (let r = a; r <= b; r++) if (!(rm && r === k)) bounds.push(C[r]);
  const samples = [], from = [], ctrlAt = [0];
  for (let r = 0; r + 1 < bounds.length; r++) {
    const part = moved.filter((q) => q.j >= bounds[r] && q.j <= bounds[r + 1]);
    const { out, at } = even(part.map((q) => q.p), step);
    out.forEach((p, j) => {
      if (r > 0 && j === 0) return;
      samples.push(p.map(r3));
      from.push(Math.round(bounds[r] + at[j] * (bounds[r + 1] - bounds[r])));
    });
    ctrlAt.push(samples.length - 1);
  }
  const lo = C[a], hi = C[b], head = pts.slice(0, lo).map((q) => q.slice()), tail = pts.slice(hi + 1).map((q) => q.slice());
  const shift = samples.length - (hi - lo + 1);
  return {
    pts: [...head, ...samples, ...tail],
    C: [...C.slice(0, a), ...ctrlAt.map((j) => lo + j), ...C.slice(b + 1).map((i) => i + shift)],
    from: [...head.map((_, i) => i), ...from, ...tail.map((_, i) => hi + 1 + i)],
  };
}
