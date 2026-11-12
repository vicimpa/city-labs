// Local, metre-based building meshes. Render caches may bake a transform into these
// buffers, but authoring coordinates and UVs never depend on world position or yaw.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ensureLocalBuilding } from '../format/transforms.js';

const ARCHITECTURAL = new Set(['tower', 'podium_tower', 'stepped', 'round_tower', 'landmark', 'block', 'l_block',
  'courtyard', 'hospital', 'school', 'mall', 'terminal', 'station', 'warehouse', 'hangar', 'pavilion', 'house', 'shop']);

function ringsOf(part) {
  return [part.p, ...(part.holes ?? [])].map((ring, i) => {
    const pts = ring.map(([x, y]) => new THREE.Vector2(x, y));
    if (pts.length > 1 && pts[0].equals(pts.at(-1))) pts.pop();
    // Exterior CCW, holes CW: identical winding produces outward wall normals.
    if (THREE.ShapeUtils.isClockWise(pts) !== (i > 0)) pts.reverse();
    return pts;
  });
}

function geometry(positions, uvs) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

/** Hard-edged walls: U is cumulative arc length, V is height relative to the part. */
export function wallGeometry(part) {
  const pos = [], uv = [], z = part.z ?? 0, h = part.h ?? 3;
  for (const ring of ringsOf(part)) {
    let u = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], next = u + a.distanceTo(b);
      if (next === u) continue;
      for (const [x, y, dz, s, v] of [[a.x, a.y, 0, u, 0], [b.x, b.y, 0, next, 0], [a.x, a.y, h, u, h],
        [b.x, b.y, 0, next, 0], [b.x, b.y, h, next, h], [a.x, a.y, h, u, h]]) {
        pos.push(x, y, z + dz); uv.push(s, v);
      }
      u = next;
    }
  }
  return geometry(pos, uv);
}

export function capGeometry(part, top = true) {
  const rings = ringsOf(part), shape = new THREE.Shape(rings[0]);
  shape.holes = rings.slice(1).map((r) => new THREE.Path(r));
  const source = new THREE.ShapeGeometry(shape), g = source.toNonIndexed(); source.dispose();
  const a = g.attributes.position, z = (part.z ?? 0) + (top ? part.h ?? 3 : 0);
  for (let i = 0; i < a.count; i++) a.setZ(i, z);
  if (!top) {
    for (const attr of Object.values(g.attributes)) for (let i = 0; i < attr.count; i += 3) {
      for (let c = 0; c < attr.itemSize; c++) {
        const v = attr.getComponent(i + 1, c); attr.setComponent(i + 1, c, attr.getComponent(i + 2, c)); attr.setComponent(i + 2, c, v);
      }
    }
  }
  g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

// Thin edge-following bands preserve courtyard holes and arbitrary concave outlines.
function bands(part, levels) {
  const pieces = [];
  for (const ring of ringsOf(part)) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], len = a.distanceTo(b);
    if (len < 0.01) continue;
    for (const [z, h, depth] of levels) {
      const box = new THREE.BoxGeometry(len, depth, h);
      box.rotateZ(Math.atan2(b.y - a.y, b.x - a.x));
      box.translate((a.x + b.x) / 2, (a.y + b.y) / 2, z + h / 2);
      const g = box.toNonIndexed(); box.dispose(); pieces.push(g);
    }
  }
  if (!pieces.length) return null;
  const g = mergeGeometries(pieces); pieces.forEach((p) => p.dispose());
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

/** Returns independent geometries, owned by the caller. No canvas/WebGL required. */
export function buildingGeometries(rec, { detail = 'medium' } = {}) {
  ensureLocalBuilding(rec);
  const out = [], enabled = detail !== 'none' && rec.detail !== 'none' && ARCHITECTURAL.has(rec.type);
  for (const part of rec.parts ?? []) {
    if (part.p?.length < 3 || !part.p || (part.h ?? 3) <= 0) continue;
    const roof = part.roofMaterial ?? part.m;
    out.push({ g: wallGeometry(part), m: part.m, role: 'wall' },
      { g: capGeometry(part), m: roof, role: 'roof' }, { g: capGeometry(part, false), m: part.m, role: 'base' });
    if (!enabled || (part.h ?? 3) < 2) continue;
    const z = part.z ?? 0, top = z + (part.h ?? 3), h = part.h ?? 3;
    const levels = [[z, Math.min(0.5, h * 0.06), 0.22], [top - 0.2, 0.2, 0.35]];
    // Tall/flat-roof types get a parapet; modest houses keep a light cornice.
    if (!['house', 'shop', 'hangar'].includes(rec.type)) levels.push([top, 0.55, 0.24]);
    if (detail === 'high' && h > 9) {
      // Limited architectural floor bands, not one Object3D per floor/window.
      const step = Math.max(3.3, h / 12);
      for (let dz = step; dz < h - 1; dz += step) levels.push([z + dz - 0.08, 0.16, 0.12]);
    }
    const g = bands(part, levels);
    if (g) out.push({ g, m: part.trimMaterial ?? roof, role: 'detail' });
  }
  return out;
}
