// Authoring transforms, shared by the editor, MCP and renderers. Metres, Z up;
// column-major matrices and Euler XYZ radians (the same convention as glTF/Three.js).
// Building footprints, holes and part.z live in object space. Road-owned furniture
// retains p/h so road generation can replace it without a second source of truth.
export const IDENTITY = () => ({ p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] });

export function validateTransform(t, path = 'transform') {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error(`${path}: expected {p, r, s}`);
  for (const key of ['p', 'r', 's']) {
    if (!Array.isArray(t[key]) || t[key].length !== 3 || !t[key].every(Number.isFinite)) throw new Error(`${path}.${key}: expected three finite numbers`);
  }
  if (t.s.some((v) => v < 0.001 || v > 1000)) throw new Error(`${path}.s: scale must be between 0.001 and 1000`);
  return t;
}

/** Migrate once, without rounding vertices or changing their world-space positions. */
export function ensureLocalBuilding(b) {
  if (b.transform) { validateTransform(b.transform); return b; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity;
  for (const part of b.parts ?? []) {
    z0 = Math.min(z0, part.z ?? 0);
    for (const p of part.p ?? []) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  }
  const p = Number.isFinite(x0 + y0 + x1 + y1) ? [(x0 + x1) / 2, (y0 + y1) / 2, Number.isFinite(z0) ? z0 : 0] : [0, 0, 0];
  b.transform = { p, r: [0, 0, 0], s: [1, 1, 1] };
  for (const part of b.parts ?? []) {
    for (const ring of [part.p ?? [], ...(part.holes ?? [])]) for (const q of ring) { q[0] -= p[0]; q[1] -= p[1]; }
    part.z = (part.z ?? 0) - p[2];
  }
  return b;
}

export function transformOf(kind, rec) {
  if (kind === 'building') return rec.transform ?? IDENTITY();
  if (kind === 'furniture') return { p: rec.p ?? [0, 0, 0], r: [rec.tilt?.[0] ?? 0, rec.tilt?.[1] ?? 0, rec.h ?? 0], s: rec.scale ?? [1, 1, 1] };
  throw new Error(`${kind}: no object transform`);
}

export function matrixFromTransform(t) {
  const [rx, ry, rz] = t.r, [sx, sy, sz] = t.s;
  const a = Math.cos(rx), b = Math.sin(rx), c = Math.cos(ry), d = Math.sin(ry), e = Math.cos(rz), f = Math.sin(rz);
  return [c * e * sx, (a * f + b * e * d) * sx, (b * f - a * e * d) * sx, 0,
    -c * f * sy, (a * e - b * f * d) * sy, (b * e + a * f * d) * sy, 0,
    d * sz, -b * c * sz, a * c * sz, 0, ...t.p, 1];
}
export const buildingMatrix = (rec) => matrixFromTransform(transformOf('building', rec));
export const objectMatrix = (kind, rec) => matrixFromTransform(transformOf(kind, rec));

export function applyMatrix(m, p) {
  const [x, y, z = 0] = p;
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}
export const localToWorld = (rec, p) => applyMatrix(buildingMatrix(rec), p);

export function worldToLocal(rec, p) {
  const t = transformOf('building', rec), m = matrixFromTransform({ ...t, p: [0, 0, 0], s: [1, 1, 1] }), v = p.map((x, i) => x - t.p[i]);
  return [(m[0] * v[0] + m[1] * v[1] + m[2] * v[2]) / t.s[0],
    (m[4] * v[0] + m[5] * v[1] + m[6] * v[2]) / t.s[1],
    (m[8] * v[0] + m[9] * v[1] + m[10] * v[2]) / t.s[2]];
}

export function moveObject(kind, rec, dx = 0, dy = 0, dz = 0) {
  if (![dx, dy, dz].every(Number.isFinite)) throw new Error('translation must be finite');
  if (kind === 'building') ensureLocalBuilding(rec);
  const t = transformOf(kind, rec);
  t.p = t.p.map((v, i) => v + [dx, dy, dz][i]);
  if (kind === 'building') rec.transform = t; else { rec.p = t.p; delete rec.owner; }
}
export function rotateObject(kind, rec, angle, cx, cy) {
  if (!Number.isFinite(angle)) throw new Error('rotation must be finite');
  if (kind === 'building') ensureLocalBuilding(rec);
  const t = transformOf(kind, rec);
  // World Z rotation, including a pivot outside the object. For tilted objects
  // rotate the orientation through quaternions rather than adding to Euler.z.
  if (cx !== undefined && cy !== undefined) {
    const x = t.p[0] - cx, y = t.p[1] - cy, c = Math.cos(angle), s = Math.sin(angle);
    t.p = [cx + x * c - y * s, cy + x * s + y * c, t.p[2]];
  }
  const m = matrixFromTransform({ p: [0, 0, 0], r: t.r, s: [1, 1, 1] }), c = Math.cos(angle), s = Math.sin(angle);
  const m11 = c * m[0] - s * m[1], m12 = c * m[4] - s * m[5], m13 = c * m[8] - s * m[9];
  const m22 = s * m[4] + c * m[5], m23 = s * m[8] + c * m[9];
  t.r[1] = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) { t.r[0] = Math.atan2(-m23, m[10]); t.r[2] = Math.atan2(-m12, m11); }
  else { t.r[0] = Math.atan2(m[6], m22); t.r[2] = 0; }
  if (kind === 'building') rec.transform = t;
  else { rec.p = t.p; rec.h = t.r[2]; rec.tilt = t.r.slice(0, 2); delete rec.owner; }
}
export function scaleObject(kind, rec, scale) {
  const s = typeof scale === 'number' ? [scale, scale, scale] : scale;
  if (kind === 'building') ensureLocalBuilding(rec);
  const t = transformOf(kind, rec), next = { ...t, s: t.s.map((v, i) => v * s[i]) };
  validateTransform(next);
  if (kind === 'building') rec.transform = next; else { rec.scale = next.s; delete rec.owner; }
}

export function buildingCenter(rec) {
  const b = ensureLocalBuilding(rec);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z = Infinity;
  for (const part of b.parts ?? []) {
    z = Math.min(z, part.z ?? 0);
    for (const p of part.p ?? []) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  }
  return Number.isFinite(x0 + y0 + x1 + y1) ? localToWorld(b, [(x0 + x1) / 2, (y0 + y1) / 2, z]) : [...b.transform.p];
}
