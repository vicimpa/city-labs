// Railway structures derived from the track polyline and the ground: where the track runs above the
// ground it becomes a viaduct, a box girder under the bed carried by piers. Nothing here is stored.

export const PIER = { spacing: 36, clear: 2.5, w: 5, d: 2.2, under: 0.6 };
export const GIRDER = { clear: 1.5, hw: 2.2, depth: 1.6 };

const arc = (P) => {
  const s = [0];
  for (let i = 1; i < P.length; i++) s.push(s[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  return s;
};

/** Piers every `spacing` m where the track is over `clear` m above the ground: [{ x, y, a, z0, z1 }] (a = heading). */
export function railPiers(P, ground, { spacing = PIER.spacing, clear = PIER.clear } = {}) {
  if (P.length < 2) return [];
  const s = arc(P), L = s[s.length - 1], out = [];
  let i = 0;
  for (let u = spacing / 2; u < L; u += spacing) {
    while (i < P.length - 2 && s[i + 1] < u) i++;
    const a = P[i], b = P[i + 1], f = (u - s[i]) / Math.max(s[i + 1] - s[i], 1e-6);
    const x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f, z = (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * f;
    const g = ground(x, y);
    if (z - g > clear) out.push({ x, y, a: Math.atan2(b[1] - a[1], b[0] - a[0]), z0: g - 1, z1: z - PIER.under });
  }
  return out;
}

/** Index ranges [i0, i1] of the stretches over `clear` m above the ground (the viaduct girder runs under them). */
export function elevatedRuns(P, ground, clear = GIRDER.clear) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= P.length; i++) {
    const up = i < P.length && (P[i][2] ?? 0) - ground(P[i][0], P[i][1]) > clear;
    if (up && start < 0) start = i;
    if (!up && start >= 0) { if (i - start >= 2) runs.push([Math.max(start - 1, 0), Math.min(i, P.length - 1)]); start = -1; }
  }
  return runs;
}
