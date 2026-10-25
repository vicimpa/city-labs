// Power lines: a record is the route of the line through its posts, { type, pts: [[x, y], ...] }.
// The posts (lattice towers or wooden poles), their heading and the sagging wires between them are
// derived here from the route and the ground, so moving a post re-strings the line.

// per type: post height, the cross-arms (height, half length) and the wires (side offset, height);
// span: the longest distance between posts when a line is laid by clicking its corners
export const POWER_TYPES = {
  tower: { h: 38, span: 320, arms: [[27, 11], [33, 8]], wires: [[-10.5, 26.5], [10.5, 26.5], [-7.5, 32.5], [7.5, 32.5], [0, 38]], sag: 0.03 },
  pole: { h: 9.5, span: 50, arms: [[8.7, 1.2]], wires: [[-1.1, 8.6], [1.1, 8.6], [0, 9.5]], sag: 0.02 },
};
export const powerType = (t) => POWER_TYPES[t] ?? POWER_TYPES.tower;

/** Posts on the route: corners where the user put them, plus evenly spaced ones so no span exceeds `span`. */
export function layPosts(corners, span) {
  const out = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1], b = corners[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / span));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/**
 * Posts and wires of a line: { posts: [{ x, y, z, a }], wires: [[[x, y, z], ...], ...] }.
 * A post faces along the bisector of its two spans; each wire hangs as a parabola with sag ~ span.
 */
export function powerLayout(rec, ground, samples = 12) {
  const T = powerType(rec.type), P = rec.pts ?? [], n = P.length;
  if (n < 1) return { posts: [], wires: [] };
  const posts = P.map((p, i) => {
    const a = P[Math.max(i - 1, 0)], b = P[Math.min(i + 1, n - 1)];
    let d1 = [p[0] - a[0], p[1] - a[1]], d2 = [b[0] - p[0], b[1] - p[1]];
    const l1 = Math.hypot(...d1), l2 = Math.hypot(...d2);
    d1 = l1 > 1e-6 ? [d1[0] / l1, d1[1] / l1] : null; d2 = l2 > 1e-6 ? [d2[0] / l2, d2[1] / l2] : null;
    const d = d1 && d2 ? [d1[0] + d2[0], d1[1] + d2[1]] : d1 ?? d2 ?? [1, 0];
    return { x: p[0], y: p[1], z: ground(p[0], p[1]), a: Math.atan2(d[1], d[0]) };
  });
  const attach = (q, [off, h]) => [q.x - Math.sin(q.a) * off, q.y + Math.cos(q.a) * off, q.z + h];
  const wires = [];
  for (let i = 0; i + 1 < n; i++) {
    const A = posts[i], B = posts[i + 1], span = Math.hypot(B.x - A.x, B.y - A.y), sag = span * T.sag;
    for (const w of T.wires) {
      const a = attach(A, w), b = attach(B, w), line = [];
      for (let k = 0; k <= samples; k++) {
        const t = k / samples;
        line.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t - 4 * sag * t * (1 - t)]);
      }
      wires.push(line);
    }
  }
  return { posts, wires };
}
