// Document invariants at import/command boundaries. Unknown fields remain legal.
import { validateTransform } from './transforms.js';

const finite = (v, path) => { if (!Number.isFinite(v)) throw new Error(`${path}: expected a finite number`); };
const vec = (v, n, path) => { if (!Array.isArray(v) || v.length !== n) throw new Error(`${path}: expected ${n} coordinates`); v.forEach((x, i) => finite(x, `${path}[${i}]`)); };
const ring = (v, path, n = 3) => {
  if (!Array.isArray(v) || v.length < n || v.length > 65536) throw new Error(`${path}: expected ${n}–65536 points`);
  v.forEach((p, i) => vec(p, 2, `${path}[${i}]`));
};
export function safeKey(name, path = 'name') {
  if (typeof name !== 'string' || !name.trim() || name.length > 160 || ['__proto__', 'prototype', 'constructor'].includes(name)) throw new Error(`${path}: invalid resource name`);
  return name;
}

export function validateRecord(kind, rec, doc) {
  if (!rec || typeof rec !== 'object') throw new Error(`${kind}: expected a record`);
  if (kind === 'building') {
    if (!Array.isArray(rec.parts) || rec.parts.length > 4096) throw new Error('building.parts: expected 0–4096 parts');
    if (rec.transform) validateTransform(rec.transform);
    rec.parts.forEach((p, i) => {
      const path = `building.parts[${i}]`;
      ring(p.p, path + '.p'); (p.holes ?? []).forEach((h, j) => ring(h, `${path}.holes[${j}]`));
      finite(p.z ?? 0, path + '.z'); finite(p.h, path + '.h');
      if (p.h <= 0 || p.h > 10000) throw new Error(`${path}.h: height must be in (0, 10000]`);
    });
  } else if (kind === 'furniture') {
    vec(rec.p, 3, 'furniture.p'); finite(rec.h ?? 0, 'furniture.h');
    if (rec.tilt) vec(rec.tilt, 2, 'furniture.tilt');
    if (rec.scale) validateTransform({ p: rec.p, r: [0, 0, rec.h ?? 0], s: rec.scale }, 'furniture');
  } else if (kind === 'surface') {
    ring(rec.p, 'surface.p'); (rec.holes ?? []).forEach((h, i) => ring(h, `surface.holes[${i}]`));
  } else if (kind === 'node') vec(rec.p, 3, 'node.p');
  else if (kind === 'tree') vec(rec, 3, 'tree');
  else if (kind === 'wind') vec(rec, 4, 'wind');
  else if (kind === 'edge' || kind === 'rail' || kind === 'train') {
    const pts = kind === 'rail' ? rec : rec.pts;
    if (!Array.isArray(pts) || pts.length < 2 || pts.length > 1_000_000) throw new Error(`${kind}: expected 2–1000000 points`);
    pts.forEach((p, i) => vec(p, 3, `${kind}.points[${i}]`));
    if (kind === 'edge') for (const key of ['elev', 'tunnel']) {
      if (rec[key] && (rec[key].length !== pts.length || !rec[key].every((v) => v === 0 || v === 1))) throw new Error(`edge.${key}: expected one 0/1 flag per point`);
    }
  } else if (kind === 'powerline') ring(rec.pts, 'powerline.pts', 2);
  if (doc) {
    const R = doc.layers.roads, defs = doc.layers.defs;
    if (kind === 'edge' || kind === 'node') {
      if (!Number.isInteger(rec.id) || rec.id < 0) throw new Error(`${kind}.id: expected a nonnegative integer`);
      const records = kind === 'edge' ? R.edges : R.nodes;
      if (records.some((r) => r !== rec && r.id === rec.id)) throw new Error(`${kind}: duplicate id ${rec.id}`);
      if (kind === 'edge') {
        if (!Array.isArray(rec.n) || rec.n.length !== 2 || !rec.n.every((id) => R.nodes.some((n) => n.id === id))) throw new Error(`road ${rec.id}: missing end node`);
        if (!Object.hasOwn(R.classes ?? {}, rec.cls)) throw new Error(`road ${rec.id}: missing class '${rec.cls}'`);
      }
    }
    if (kind === 'building') for (const p of rec.parts) for (const key of ['m', 'roofMaterial', 'trimMaterial'])
      if (p[key] !== undefined && !Object.hasOwn(defs.materials ?? {}, p[key])) throw new Error(`building: unknown material '${p[key]}'`);
    if (kind === 'surface' && !Object.hasOwn(defs.surfaces ?? {}, rec.m)) throw new Error(`unknown surface material '${rec.m}'`);
    if (kind === 'furniture') {
      if (!Object.hasOwn(defs.furniture ?? {}, rec.t)) throw new Error(`unknown prefab '${rec.t}'`);
      if (rec.material !== undefined && !Object.hasOwn(defs.materials ?? {}, rec.material)) throw new Error(`unknown material '${rec.material}'`);
    }
  }
  return rec;
}

export function materialReferences(doc, name) {
  const refs = [];
  for (const b of doc.layers.buildings?.items ?? []) for (const p of b.parts ?? [])
    for (const key of ['m', 'roofMaterial', 'trimMaterial']) if (p[key] === name) refs.push({ owner: b, rec: p, key });
  for (const f of Object.values(doc.layers.defs?.furniture ?? {})) for (const p of f.parts ?? [])
    if (p.m === name) refs.push({ owner: f, rec: p, key: 'm' });
  for (const f of doc.layers.furniture?.items ?? []) if (f.material === name) refs.push({ owner: f, rec: f, key: 'material' });
  return refs;
}

function validateRoadClass(c) {
  const ranges = { lanes: [1, 16], lane_w: [0.5, 30], shoulder: [0, 200], median: [0, 200], side: [0, 200], sigma: [0, 5000], r: [0, 10000], corner: [0, 1000], max_grade: [0.001, 1], k_min: [0.1, 1000] };
  for (const [key, [lo, hi]] of Object.entries(ranges)) if (c[key] !== undefined && (!Number.isFinite(c[key]) || c[key] < lo || c[key] > hi || key === 'lanes' && !Number.isInteger(c[key]))) throw new Error(`road class.${key}: expected ${lo}–${hi}`);
}

export function validateMaterial(value, path = 'material') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected a material object`);
  for (const key of ['color', 'emissive', 'specular']) if (value[key] !== undefined && !/^#[\da-f]{6}$/i.test(value[key])) throw new Error(`${path}.${key}: expected #rrggbb`);
  for (const key of ['roughness', 'metalness', 'opacity']) if (value[key] !== undefined && (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1)) throw new Error(`${path}.${key}: expected a number between 0 and 1`);
  for (const key of ['glow', 'nightGlow', 'emissiveIntensity', 'shininess']) if (value[key] !== undefined && (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > 10000)) throw new Error(`${path}.${key}: expected a number between 0 and 10000`);
  return value;
}

export function validateDefChange(doc, group, name, value) {
  safeKey(group, 'group'); safeKey(name);
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('resource value must be an object or null');
  if (group === 'materials') {
    if (value === null) {
      const n = materialReferences(doc, name).length;
      if (n) throw new Error(`material '${name}' is used by ${n} parts; assign a replacement before deleting it`);
    } else {
      validateMaterial(value, `materials.${name}`);
      if (value.facade && value.facade !== 'wall' && !doc.layers.defs.facades?.[value.facade]) throw new Error(`unknown facade '${value.facade}'`);
    }
  }
  if (group === 'facades' && value) {
    for (const key of ['bay', 'floor']) if (value[key] !== undefined && (!Number.isFinite(value[key]) || value[key] < 0.1 || value[key] > 100)) throw new Error(`facade.${key}: expected 0.1–100 metres`);
    for (const key of ['lit', 'warm', 'sparse']) if (value[key] !== undefined && (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1)) throw new Error(`facade.${key}: expected 0–1`);
    if (value.window !== undefined && !(Number.isFinite(value.window) && value.window >= 0 && value.window <= 1) && (!Array.isArray(value.window) || value.window.length !== 2 || !value.window.every((x) => Number.isFinite(x) && x >= 0 && x <= 1))) throw new Error('facade.window: expected one/two fractions between 0 and 1');
  }
  if (group === 'roads.classes' && value) validateRoadClass(value);
  if (group === 'furniture' && value) for (const [i, part] of (value.parts ?? []).entries()) {
    if (part.at) vec(part.at, 3, `prefab.parts[${i}].at`);
    if (part.s) { vec(part.s, 3, `prefab.parts[${i}].s`); if (part.s.some((x) => x <= 0)) throw new Error('prefab dimensions must be positive'); }
    for (const key of ['h', 'r']) if (part[key] !== undefined && (!Number.isFinite(part[key]) || part[key] <= 0)) throw new Error(`prefab.${key}: expected a positive size`);
  }
  if (value === null) {
    let used = false;
    if (group === 'roads.classes') used = doc.layers.roads.edges.some((e) => e.cls === name);
    if (group === 'furniture') used = doc.layers.furniture.items.some((f) => f.t === name);
    if (group === 'surfaces') used = doc.layers.buildings.surfaces.some((s) => s.m === name);
    if (group === 'buildingTypes' || group === 'zones') used = doc.layers.buildings.items.some((b) => b[group === 'zones' ? 'zone' : 'type'] === name);
    if (group === 'facades') used = Object.values(doc.layers.defs.materials).some((m) => m.facade === name) || Object.values(doc.layers.defs.buildingTypes).some((b) => b.wall === name);
    if (used) throw new Error(`resource '${group}.${name}' is used; assign a replacement before deleting it`);
  }
}

export const DOCUMENT_VERSION = 2;
export function validateWorld(doc) {
  if (!doc?.layers || !doc.meta) throw new Error('city: expected meta and layers');
  const version = doc.meta.documentVersion ?? 1;
  if (!Number.isInteger(version) || version < 1 || version > DOCUMENT_VERSION) throw new Error(`city: unsupported document version ${version}`);
  const t = doc.layers.terrain;
  if (t) {
    for (const key of ['nx', 'ny']) if (!Number.isInteger(t[key]) || t[key] < 2) throw new Error(`terrain.${key}: expected at least 2 cells`);
    const n = t.nx * t.ny;
    if (n > 4_200_000) throw new Error('terrain: grid exceeds 4200000 cells');
    if (!Number.isFinite(t.res) || t.res <= 0) throw new Error('terrain.res: expected a positive grid spacing');
    finite(t.x0, 'terrain.x0'); finite(t.y0, 'terrain.y0');
    for (const key of ['h', 'base']) if (t[key]) {
      if (t[key].length !== n) throw new Error(`terrain.${key}: wrong cell count`);
      for (const z of t[key]) finite(z, `terrain.${key}`);
    }
    if (!t.h) throw new Error('terrain.h: missing heightfield');
  }
  for (const b of doc.layers.buildings?.items ?? []) validateRecord('building', b, doc);
  for (const f of doc.layers.furniture?.items ?? []) validateRecord('furniture', f, doc);
  for (const [kind, key] of [['surface', 'surfaces'], ['tree', 'trees'], ['wind', 'wind'], ['rail', 'rails'], ['train', 'trains'], ['powerline', 'powerlines']])
    for (const rec of doc.layers.buildings?.[key] ?? []) validateRecord(kind, rec, doc);
  const R = doc.layers.roads;
  if (R) {
    for (const c of Object.values(R.classes ?? {})) validateRoadClass(c);
    const nodes = new Set();
    for (const n of R.nodes ?? []) { validateRecord('node', n); if (!Number.isInteger(n.id) || n.id < 0 || nodes.has(n.id)) throw new Error(`road node: duplicate/invalid id ${n.id}`); nodes.add(n.id); }
    const edges = new Set();
    for (const e of R.edges ?? []) {
      validateRecord('edge', e);
      if (!Number.isInteger(e.id) || e.id < 0 || edges.has(e.id)) throw new Error(`road edge: duplicate/invalid id ${e.id}`);
      if (!Array.isArray(e.n) || e.n.length !== 2 || !e.n.every((id) => nodes.has(id))) throw new Error(`road ${e.id}: missing end node`);
      if (!Object.hasOwn(R.classes ?? {}, e.cls)) throw new Error(`road ${e.id}: missing class '${e.cls}'`);
      edges.add(e.id);
    }
  }
  for (const [name, m] of Object.entries(doc.layers.defs?.materials ?? {})) validateMaterial(m, `materials.${name}`);
  return doc;
}
