// Export the world for other tools: a glTF 3D model (.glb), a top-down plan (.png) or all data (.json).
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { renderMap, encodePng } from '../mcp/map.js';
import { controlIndices } from '../world/spline.js';

/** Static glTF in metres, Y up. Metadata lives once in scene.extras.cityLabs;
 * node extras carry compact ownership ranges referencing its entity IDs.
 * Triangle offsets follow source faceIndex; primitives describe glTF group offsets.
 * metadata:false exports geometry without the game index/road graph. */
export async function exportGlb(world, { terrainStep = 2, roads = true, buildings = true, furniture = true, trees = true, metadata = true } = {}) {
  if (!Number.isInteger(terrainStep) || terrainStep < 0) throw new Error('terrainStep must be a nonnegative integer');
  const root = new THREE.Group(), scene = new THREE.Scene(), temporary = [], materials = new Map();
  root.name = scene.name = 'City Labs';
  root.rotation.x = -Math.PI / 2;                   // [x,y,z] authoring -> [x,z,-y] glTF
  scene.add(root);
  const index = metadata ? gameIndex(world, { roads, buildings, furniture, trees, terrain: terrainStep > 0 }) : null;
  if (index) scene.userData.cityLabs = index.data;
  try {
    if (terrainStep > 0 && world.terrainGeo) {
      const terrain = terrainMesh(world, terrainStep);
      temporary.push(terrain.geometry, terrain.material);
      if (index) terrain.userData.cityLabs = { category: 'terrain', ownership: { domain: 'triangles', ranges: [{ start: 0, count: terrain.geometry.index.count / 3, entityId: index.entity(world.L.terrain)?.id }], primitives: [{ index: 0, firstTriangle: 0, triangleCount: terrain.geometry.index.count / 3 }] } };
      root.add(terrain);
    }
    const add = (name, object) => {
      if (!object) return;
      const cloned = cloneForExport(object, name, index, materials, temporary);
      if (cloned) { cloned.name = name; root.add(cloned); }
    };
    if (roads) add('roads', world.groups.roads);
    if (buildings) for (const name of ['blocks', 'surfaces', 'rails', 'wind', 'trains', 'cables']) add(name, world.groups[name]);
    if (trees) add('trees', world.groups.trees);
    if (furniture) add('furniture', world.groups.furniture);
    scene.updateMatrixWorld(true);
    const exporter = new GLTFExporter();
    // Materials are shared with the editor. Strip renderer cache descriptions from
    // the OUTPUT definition rather than modifying or disposing the live material.
    exporter.register(() => ({ writeMaterial(_material, definition) { delete definition.extras; } }));
    return new Uint8Array(await exporter.parseAsync(scene, { binary: true, onlyVisible: false, maxTextureSize: 1024 }));
  } finally {
    // Clone geometry and textures stay shared. Only independently created terrain
    // resources and export-converted material objects belong to this operation.
    for (const resource of temporary) resource.dispose();
  }
}

const yUp = ([x, y, z = 0]) => [x, z, -y];
function gameIndex(world, options) {
  const L = world.L, records = new WeakMap(), entities = [], registered = new Set();
  const collections = [
    ['terrain', options.terrain && L.terrain ? [L.terrain] : []],
    ['building', options.buildings ? L.buildings?.items : []], ['surface', options.buildings ? L.buildings?.surfaces : []],
    ['rail', options.buildings ? L.buildings?.rails : []], ['wind', options.buildings ? L.buildings?.wind : []],
    ['train', options.buildings ? L.buildings?.trains : []], ['powerline', options.buildings ? L.buildings?.powerlines : []],
    ['furniture', options.furniture ? L.furniture?.items : []], ['tree', options.trees ? L.buildings?.trees : []],
    ['edge', options.roads ? L.roads?.edges : []], ['node', options.roads ? L.roads?.nodes : []],
  ];
  for (const [kind, list] of collections) (list ?? []).forEach((record, i) => {
    if (!record || typeof record !== 'object') return;
    const entry = { id: `${kind}:${i}`, kind, index: i };
    if (typeof record.id === 'string' || typeof record.id === 'number') entry.sourceId = record.id;
    for (const key of ['type', 'zone', 'name']) if (typeof record[key] === 'string') entry[key] = record[key];
    if (kind === 'furniture' && typeof record.t === 'string') entry.type = record.t;
    // The first reference wins if an in-memory document aliases a record object.
    if (!records.has(record)) records.set(record, entry);
  });
  const entity = (record) => {
    const entry = record && typeof record === 'object' ? records.get(record) : null;
    if (entry && !registered.has(entry.id)) { registered.add(entry.id); entities.push(entry); }
    return entry ?? null;
  };
  const data = { format: 'city-labs-game', version: 1, documentVersion: world.doc?.meta?.documentVersion ?? 1,
    units: 'metres', upAxis: 'Y', sourceToExport: '[x,z,-y]', graphSpace: 'world', entityIds: 'kind:index at export time',
    geometry: 'static render meshes; engine collision and navigation meshes are not generated',
    ownership: { ranges: 'start-inclusive element offset and count', triangles: 'index triplets or nonindexed vertex triplets; use primitive firstTriangle offsets', unassigned: 'entityId:null means this derived mesh has no authoring-owner hook' }, entities };
  if (options.roads && L.roads) {
    const R = L.roads, nodes = new Map((R.nodes ?? []).map((node) => [node.id, entity(node)?.id]));
    data.roadGraph = {
      classes: JSON.parse(JSON.stringify(R.classes ?? {})),
      controlPolicy: { method: 'XY axis simplification', toleranceMetres: 1.5, maximumGapMetres: 120 },
      nodes: (R.nodes ?? []).map((node) => ({ entityId: entity(node)?.id, position: yUp(node.p), ...(node.kind ? { kind: node.kind } : {}) })),
      edges: (R.edges ?? []).map((edge) => {
        const indices = controlIndices(edge.pts, 1.5, 120);
        return { entityId: entity(edge)?.id, nodes: edge.n.map((id) => nodes.get(id)), class: edge.cls,
          axis: edge.pts.map(yUp), controlIndices: indices, controlPoints: indices.map((i) => yUp(edge.pts[i])),
          ...(edge.elev ? { elevated: Array.from(edge.elev) } : {}), ...(edge.tunnel ? { tunnel: Array.from(edge.tunnel) } : {}) };
      }),
    };
  }
  return { data, entity };
}

function exportMaterial(source, cache, temporary) {
  if (source.isMeshStandardMaterial || source.isMeshBasicMaterial) return source;
  if (cache.has(source)) return cache.get(source);
  const material = new THREE.MeshStandardMaterial();
  material.name = source.name || source.userData.m || source.userData.name || '';
  // Texture objects remain shared: disposing the temporary material never disposes them.
  for (const key of ['map', 'lightMap', 'lightMapIntensity', 'aoMap', 'aoMapIntensity', 'emissiveMap', 'emissiveIntensity',
    'bumpMap', 'bumpScale', 'normalMap', 'normalMapType', 'displacementMap', 'displacementScale', 'displacementBias',
    'alphaMap', 'envMap', 'envMapIntensity', 'vertexColors', 'transparent', 'opacity', 'alphaTest', 'alphaHash',
    'side', 'flatShading', 'wireframe', 'depthTest', 'depthWrite', 'blending', 'premultipliedAlpha', 'visible'])
    if (source[key] !== undefined) material[key] = source[key];
  for (const key of ['color', 'emissive', 'normalScale']) if (source[key]) material[key].copy(source[key]);
  material.metalness = source.metalness ?? 0;
  // Approximate the legacy Phong lobe with a dielectric microfacet roughness.
  material.roughness = source.roughness ?? (source.isMeshPhongMaterial ? Math.max(0.04, Math.min(1, Math.sqrt(2 / ((source.shininess ?? 30) + 2)))) : 1);
  cache.set(source, material); temporary.push(material); return material;
}

function cloneForExport(source, category, index, materials, temporary) {
  if (source.geometry && (!(source.geometry.attributes.position?.count > 0) || source.geometry.index?.count === 0 || (source.isInstancedMesh && source.count === 0))) return null;
  const cloned = source.clone(false);
  if (source.material) cloned.material = Array.isArray(source.material) ? source.material.map((material) => exportMaterial(material, materials, temporary)) : exportMaterial(source.material, materials, temporary);
  // owner functions disappear during Three's JSON clone; resolve the ORIGINAL
  // closure against the shared record index before handing the copy to glTF.
  cloned.userData = {};
  if (index && source.geometry) {
    const domain = source.isInstancedMesh ? 'instances' : source.isLineSegments ? 'segments' : 'triangles';
    const count = source.isInstancedMesh ? source.count : Math.floor((source.geometry.index?.count ?? source.geometry.attributes.position.count) / (domain === 'segments' ? 2 : 3));
    const ranges = [];
    if (typeof source.userData.owner === 'function') {
      for (let i = 0; i < count; i++) {
        const id = index.entity(source.userData.owner(i))?.id ?? null, previous = ranges.at(-1);
        if (previous?.entityId === id) previous.count++;
        else ranges.push({ start: i, count: 1, entityId: id });
      }
    } else if (count) ranges.push({ start: 0, count, entityId: null });
    const ownership = { domain, ranges };
    if (domain === 'triangles') ownership.primitives = Array.isArray(source.material)
      ? source.geometry.groups.map((group, i) => ({ index: i, firstTriangle: group.start / 3, triangleCount: group.count / 3 }))
      : [{ index: 0, firstTriangle: 0, triangleCount: count }];
    cloned.userData.cityLabs = { category, ...(source.userData.kind ? { kind: source.userData.kind } : {}),
      ...(source.userData.detail ? { detail: true } : {}), ownership };
  }
  for (const child of source.children) { const copy = cloneForExport(child, category, index, materials, temporary); if (copy) cloned.add(copy); }
  return cloned;
}

// Full CPU authoring attributes are independent of the live chunk/LOD Group.
// Always retain the final row/column when a grid is not divisible by step.
function terrainMesh(world, step) {
  const t = world.L.terrain, g = world.terrainGeo;
  const axis = (count) => { const samples = []; for (let i = 0; i < count - 1; i += step) samples.push(i); samples.push(count - 1); return samples; };
  const xs = axis(t.nx), ys = axis(t.ny), nx = xs.length, ny = ys.length;
  const P = g.attributes.position.array, C = g.attributes.color.array, N = g.attributes.normal.array;
  const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3), nrm = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const src = (ys[j] * t.nx + xs[i]) * 3, dst = (j * nx + i) * 3;
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
  mesh.name = 'terrain'; return mesh;
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
