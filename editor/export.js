// Export the world for other tools: a glTF 3D model (.glb), a top-down plan (.png) or all data (.json).
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { renderMap, encodePng } from '../mcp/map.js';

/** The scene as binary glTF. opts: terrainStep (1, 2, 4… or 0 for none), roads, buildings, furniture, trees. */
export async function exportGlb(world, { terrainStep = 2, roads = true, buildings = true, furniture = true, trees = true } = {}) {
  const root = new THREE.Group();
  root.name = 'City Labs';
  root.rotation.x = -Math.PI / 2;                   // the editor is Z-up, glTF is Y-up
  if (terrainStep > 0 && world.terrainGeo) root.add(terrainMesh(world, terrainStep));
  const add = (name, obj) => { if (obj) { const c = obj.clone(true); c.name = name; root.add(c); } };
  if (roads) add('roads', world.groups.roads);
  if (buildings) for (const n of ['blocks', 'surfaces', 'rails', 'wind']) add(n, world.groups[n]);
  if (trees) add('trees', world.groups.trees);
  if (furniture) add('furniture', world.groups.furniture);
  const scene = new THREE.Scene(); scene.add(root);
  const out = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false, maxTextureSize: 1024 });
  return new Uint8Array(out);
}

// the terrain mesh at every step-th grid node (positions, colours and normals of the live mesh)
function terrainMesh(world, step) {
  const t = world.L.terrain, g = world.terrainGeo, nx = Math.floor((t.nx - 1) / step) + 1, ny = Math.floor((t.ny - 1) / step) + 1;
  const P = g.attributes.position.array, C = g.attributes.color.array, N = g.attributes.normal.array;
  const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3), nrm = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const src = ((j * step) * t.nx + i * step) * 3, dst = (j * nx + i) * 3;
    for (let k = 0; k < 3; k++) { pos[dst + k] = P[src + k]; col[dst + k] = C[src + k]; nrm[dst + k] = N[src + k]; }
  }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let n = 0;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
    idx[n++] = a; idx[n++] = b; idx[n++] = e; idx[n++] = a; idx[n++] = e; idx[n++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  mesh.name = 'terrain';
  return mesh;
}

/** The whole map as a PNG plan, `width` pixels wide. */
export async function exportPng(doc, graded, kinds, width = 4096) {
  const t = doc.layers.terrain;
  const bbox = t ? [t.x0, t.y0, t.x0 + (t.nx - 1) * t.res, t.y0 + (t.ny - 1) * t.res] : [-2000, -2000, 2000, 2000];
  const m = renderMap(doc, { bbox, width, graded, kinds });
  const b64 = await encodePng(m.rgba, m.width, m.height);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Every layer as JSON (typed arrays as plain arrays). */
export function exportJson(doc) {
  return new TextEncoder().encode(JSON.stringify({ format: 'city-labs-json', meta: doc.meta ?? {}, layers: doc.layers },
    (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)));
}
