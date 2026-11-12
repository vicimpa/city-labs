import * as THREE from 'three';
import { filletPath, resample } from '../world/profile.js';
import { cumLength } from '../world/geom.js';
import { hw } from '../world/roadnet.js';
import { ribbon } from '../viewer/world3d.js';

const fill = new THREE.MeshBasicMaterial({ color: '#80bdff', transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false });
const axis = new THREE.LineBasicMaterial({ color: '#b8ddff', depthTest: false, transparent: true, opacity: 0.9 });

/** Lightweight, bounded-cost preview. It never edits the graph or terrain. */
export function roadPreview(points, roadClass, ground, elevation = 0) {
  const group = new THREE.Group();
  const unique = points.filter((p, i) => !i || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 0.1);
  if (unique.length < 2) return group;
  const curve = filletPath(unique, unique.map((_, i) => i && i < unique.length - 1 ? roadClass.r ?? 30 : 0));
  const length = cumLength(curve).at(-1) ?? 0;
  const path = resample(curve, Math.max(4, length / 2000)).map((p) => [p[0], p[1], Math.max(ground(p[0], p[1]), 0) + elevation + 0.2]);
  const mesh = new THREE.Mesh(ribbon(path, hw(roadClass), 0), fill); group.add(mesh);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path.map((p) => new THREE.Vector3(...p))), axis); line.renderOrder = 9; group.add(line);
  group.userData.length = length;
  return group;
}

export function polygonIssue(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; area += a[0] * b[1] - b[0] * a[1]; }
  if (Math.abs(area) < 0.1) return 'area';
  const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const intersects = (a, b, c, d) => {
    if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) || Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) return false;
    return orient(a, b, c) * orient(a, b, d) <= 0 && orient(c, d, a) * orient(c, d, b) <= 0;
  };
  for (let i = 0; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
    if (i === 0 && j === points.length - 1) continue;
    if (intersects(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length])) return 'intersection';
  }
  return null;
}
