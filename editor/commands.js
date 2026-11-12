// Shared authoring operations. Both UI gestures and MCP wrap these mutations in
// their session history; coordinates, validation and dependencies stay identical.
import { KINDS } from './kinds.js';
import { validateRecord } from '../format/validate.js';
import { controlIndices, reshape } from '../world/spline.js';
import { cumLength } from '../world/geom.js';
import { groundSampler } from '../world/roadnet.js';
import { levelFlags, SPACING } from '../world/profile.js';
import { edgesAt, followEnd } from './roadedit.js';

export function prepareRecord(kind, rec, doc) {
  validateRecord(kind, rec, doc); KINDS[kind]?.normalize?.(rec); return rec;
}

/** Reconcile graph endpoints after generic inspector/script edits as well as tools. */
export function finalizeRecordEdit(doc, kind, rec, before) {
  validateRecord(kind, rec, doc);
  if (kind !== 'edge' && kind !== 'node') return rec;
  if (rec.id !== before.id || (kind === 'edge' && JSON.stringify(rec.n) !== JSON.stringify(before.n))) throw new Error('road ids/connections are changed by topology tools, not record fields');
  const R = doc.layers.roads, close = (a, b) => Math.hypot(...a.map((v, i) => v - b[i])) < 0.02;
  if (kind === 'node' && !close(rec.p, before.p)) {
    const d = rec.p.map((v, i) => v - before.p[i]);
    for (const e of edgesAt(R, rec.id)) for (const k of [0, 1]) if (e.n[k] === rec.id && !close(e.pts[k ? e.pts.length - 1 : 0], rec.p)) followEnd(e, k, d);
  }
  if (kind === 'edge') for (const k of [0, 1]) {
    const q = rec.pts[k ? rec.pts.length - 1 : 0], old = before.pts[k ? before.pts.length - 1 : 0];
    if (close(q, old)) continue;
    const nd = R.nodes.find((n) => n.id === rec.n[k]);
    if (close(nd.p, q)) continue;
    const d = q.map((v, i) => v - nd.p[i]); nd.p = [...q];
    for (const other of edgesAt(R, nd.id)) if (other !== rec) followEnd(other, other.n[0] === nd.id ? 0 : 1, d);
  }
  for (const r of [rec, ...(KINDS[kind].related?.(rec, doc.layers) ?? [])]) if (r.pts) updateRoadFlags(doc, r);
  return rec;
}
export function transformRecord(doc, kind, rec, { dx = 0, dy = 0, dz = 0, rotate_deg = 0, scale, ground = false } = {}, sampleGround) {
  const K = KINDS[kind];
  if (!K) throw new Error(`unknown record kind '${kind}'`);
  if (![dx, dy, dz, rotate_deg].every(Number.isFinite)) throw new Error('transform numbers must be finite');
  if (dx || dy || dz) K.move(rec, dx, dy, dz, doc.layers);
  if (rotate_deg) {
    if (!K.rotate) throw new Error(`${kind} cannot rotate`);
    const [cx, cy] = K.center(rec); K.rotate(rec, rotate_deg * Math.PI / 180, cx, cy);
  }
  if (scale !== undefined) { if (!K.scale) throw new Error(`${kind} cannot scale`); K.scale(rec, scale); }
  if (ground) {
    if (!['building', 'furniture', 'tree', 'wind'].includes(kind)) throw new Error(`${kind} cannot be grounded`);
    const [x, y, z] = K.center(rec), sample = sampleGround ?? groundSampler({ ...doc.layers.terrain, base: doc.layers.terrain.h });
    K.move(rec, 0, 0, Math.max(sample(x, y), 0) - z, doc.layers);
  }
  if (kind === 'edge' || kind === 'node') {
    for (const r of [rec, ...(K.related?.(rec, doc.layers) ?? [])]) if (r.pts) updateRoadFlags(doc, r);
  }
  validateRecord(kind, rec); return rec;
}

export function assignMaterial(doc, rec, material, { part, slot = 'm' } = {}) {
  if (!Object.hasOwn(doc.layers.defs?.materials ?? {}, material)) throw new Error(`unknown material '${material}'`);
  if (rec.t && Array.isArray(rec.p)) { rec.material = material; delete rec.owner; return; }
  if (!['m', 'roofMaterial', 'trimMaterial'].includes(slot)) throw new Error(`unknown material slot '${slot}'`);
  if (!Array.isArray(rec.parts)) throw new Error('material assignment requires a building');
  if (part !== undefined && (!Number.isInteger(part) || part < 0 || part >= rec.parts.length)) throw new Error('building part index out of range');
  for (const p of part === undefined ? rec.parts : [rec.parts[part]]) p[slot] = material;
}

export function updateRoadFlags(doc, rec) {
  const H = groundSampler(doc.layers.terrain), z = rec.pts.map((p) => p[2]);
  Object.assign(rec, levelFlags({ s: cumLength(rec.pts) }, z, rec.pts.map((p) => H(p[0], p[1]))));
}

/** State can be retained through a drag so each frame is evaluated from the same original curve. */
export function reshapeCurve(doc, kind, rec, state, operation) {
  const res = reshape(state.start, state.C, operation, state.step ?? SPACING);
  state.pts.length = 0; for (const p of res.pts) state.pts.push(p); state.C2 = res.C;
  if (state.ends && operation.move !== undefined) {
    const last = operation.move !== 0, q = state.pts[last ? state.pts.length - 1 : 0], q0 = state.start[last ? state.start.length - 1 : 0];
    const d = [q[0] - q0[0], q[1] - q0[1], (q[2] ?? 0) - (q0[2] ?? 0)];
    state.ends.nd.p = state.ends.p0.map((v, i) => v + d[i]);
    for (const o of state.ends.others) { o.e.pts.length = 0; for (const p of o.start) o.e.pts.push([...p]); followEnd(o.e, o.k, d); }
  }
  if (kind === 'edge') {
    updateRoadFlags(doc, rec);
    for (const o of state.ends?.others ?? []) updateRoadFlags(doc, o.e);
  }
  return res;
}

export function roadControls(rec, tolerance = 1.5) {
  if (!Number.isFinite(tolerance) || tolerance < 0.05 || tolerance > 100) throw new Error('control tolerance must be 0.05–100 metres');
  const indices = controlIndices(rec.pts, tolerance, 120);
  return { indices, points: indices.map((i) => [...rec.pts[i]]) };
}

export function editRoadControl(doc, rec, { action, index, point, tolerance = 1.5 }) {
  const { indices: C } = roadControls(rec, tolerance), max = C.length - 1;
  if (!Number.isInteger(index) || index < 0 || index > max) throw new Error('road control index out of range');
  const state = { pts: rec.pts, start: rec.pts.map((p) => [...p]), C, step: SPACING };
  if (action === 'move' && (index === 0 || index === max)) {
    const R = doc.layers.roads, id = rec.n[index === 0 ? 0 : 1], nd = R.nodes.find((n) => n.id === id);
    if (nd) state.ends = { nd, p0: [...nd.p], others: edgesAt(R, id).filter((e) => e !== rec).map((e) => ({ e, k: e.n[0] === id ? 0 : 1, start: e.pts.map((p) => [...p]) })) };
  }
  if (action === 'remove') {
    if (index === 0 || index === max || C.length < 3) throw new Error('road endpoints cannot be removed; delete or split the road');
    return reshapeCurve(doc, 'edge', rec, state, { remove: index });
  }
  if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) throw new Error('control point requires three finite coordinates');
  if (action === 'move') return reshapeCurve(doc, 'edge', rec, state, { move: index, to: point });
  if (action === 'insert') {
    if (index >= max) throw new Error('insert index must name a segment before the last point');
    // Split the underlying sampled segment by adding one authored control. The
    // curve solver then resamples both neighbouring spans consistently.
    const sample = Math.round((C[index] + C[index + 1]) / 2), start = state.start;
    start.splice(sample, 0, [...point]);
    const next = C.map((i) => i >= sample ? i + 1 : i); next.splice(index + 1, 0, sample);
    state.C = next; state.start = start;
    return reshapeCurve(doc, 'edge', rec, state, { move: index + 1, to: point });
  }
  throw new Error(`unknown curve operation '${action}'`);
}

export function roadMetrics(rec) {
  let length = 0, maxGrade = 0;
  for (let i = 1; i < rec.pts.length; i++) {
    const a = rec.pts[i - 1], b = rec.pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    length += d; if (d > 1e-5) maxGrade = Math.max(maxGrade, Math.abs(b[2] - a[2]) / d);
  }
  return { length, maxGrade, controls: roadControls(rec).points.length, bridges: (rec.elev ?? []).filter(Boolean).length, tunnels: (rec.tunnel ?? []).filter(Boolean).length };
}
