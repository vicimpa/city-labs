// Meaningful CPU geometry/lifetime checks; no WebGL context or browser required.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildingGeometries, wallGeometry } from '../../viewer/buildings.js';
import { World3D } from '../../viewer/world3d.js';
import { facadeTextures } from '../../viewer/facades.js';
import { buildingMatrix, localToWorld } from '../../format/transforms.js';
import { disposeRenderObjects } from '../../viewer/resources.js';
import { emptyWorld } from '../../format/world.js';

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const release = (parts) => parts.forEach(({ g }) => g.dispose());
const shape = () => ({ type: 'block', detail: 'none', transform: { p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
  parts: [{ p: [[0, 0], [12, 0], [12, 12], [0, 12]], holes: [[[4, 4], [4, 8], [8, 8], [8, 4]]], z: 2, h: 10, m: 'wall' }] });
const documentOf = (items = [], furniture = []) => ({ layers: {
  defs: { materials: { wall: { color: '#aabbee', roughness: 0.75 }, other: { color: '#ee9977', roughness: 0.75 },
    roof: { color: '#445566', roughness: 0.9 } }, buildingTypes: { block: { wall: '' } },
  furniture: { bench: { parts: [{ k: 'box', s: [2, 1, 0.4], c: '#555555' }, { k: 'box', s: [1, 1, 1], c: '#555555' }] } } },
  buildings: { items, trees: [], trains: [] }, furniture: { items: furniture },
} });

// The diagonal's U span must be physical length, not its projected X or Y length.
{
  const g = wallGeometry({ p: [[0, 0], [3, 4], [-4, 3]], h: 6 });
  const uv = g.attributes.uv;
  near(uv.getX(1) - uv.getX(0), 5);
  near(uv.getY(2) - uv.getY(0), 6);
  g.dispose();
}

// Roof/cap tessellation and wall normals respect a courtyard, including clockwise input.
{
  const b = shape(), parts = buildingGeometries(b), roof = parts.find((p) => p.role === 'roof');
  const mesh = new THREE.Mesh(roof.g, new THREE.MeshBasicMaterial()); mesh.updateMatrixWorld();
  assert.equal(new THREE.Raycaster(new THREE.Vector3(6, 6, 50), new THREE.Vector3(0, 0, -1)).intersectObject(mesh).length, 0);
  assert.ok(new THREE.Raycaster(new THREE.Vector3(2, 2, 50), new THREE.Vector3(0, 0, -1)).intersectObject(mesh).length > 0);
  let area = 0;
  const p = roof.g.attributes.position, va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    va.fromBufferAttribute(p, i); vb.fromBufferAttribute(p, i + 1); vc.fromBufferAttribute(p, i + 2);
    area += vb.sub(va).cross(vc.sub(va)).length() / 2;
  }
  near(area, 12 * 12 - 4 * 4);
  const walls = parts.find((p) => p.role === 'wall').g;
  near(walls.attributes.normal.getY(0), -1); // exterior south wall
  near(walls.attributes.normal.getX(24), 1); // inner west wall faces into courtyard
  for (const { g } of parts) for (let i = 0; i < g.attributes.normal.count; i++) {
    const n = new THREE.Vector3().fromBufferAttribute(g.attributes.normal, i);
    near(n.length(), 1);
  }
  release(parts); mesh.material.dispose();
}

// UV and local authoring coordinates do not change when a building is moved/tilted/scaled.
{
  const b = shape(), before = buildingGeometries(b), saved = JSON.stringify(b.parts);
  b.transform = { p: [310, -95, 17], r: [0.2, -0.12, 0.77], s: [1.8, 0.8, 1.2] };
  const after = buildingGeometries(b);
  assert.equal(JSON.stringify(b.parts), saved);
  before.forEach(({ g }, i) => assert.deepEqual([...g.attributes.uv.array], [...after[i].g.attributes.uv.array]));
  const world = new World3D(documentOf([b]), { detail: 'none' }).buildAll();
  const group = world.groups.blocks.children[0], mesh = group.children[0]; group.updateMatrixWorld(true);
  const expected = new THREE.Box3();
  for (const { g } of after) {
    const clone = g.clone().applyMatrix4(new THREE.Matrix4().fromArray(buildingMatrix(b)));
    clone.computeBoundingBox(); expected.union(clone.boundingBox); clone.dispose();
  }
  for (const axis of ['x', 'y', 'z']) { near(mesh.geometry.boundingBox.min[axis], expected.min[axis], 5e-5); near(mesh.geometry.boundingBox.max[axis], expected.max[axis], 5e-5); }
  for (let i = 0; i < mesh.geometry.attributes.normal.count; i++) near(new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.normal, i).length(), 1);
  const point = new THREE.Vector3(...localToWorld(b, [2, 2, 12]));
  const normal = new THREE.Vector3(0, 0, 1).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(new THREE.Matrix4().fromArray(buildingMatrix(b))));
  const hit = new THREE.Raycaster(point.clone().addScaledVector(normal, 10), normal.clone().negate()).intersectObject(group, true)[0];
  assert.ok(hit); assert.equal(hit.object.userData.owner(hit.faceIndex), b);
  const preview = world.buildingPreview(b), localBuffers = preview.children.map((o) => o.geometry.attributes.position.array);
  b.transform.p[0] += 20; preview.matrix.fromArray(buildingMatrix(b)); preview.updateMatrixWorld(true);
  preview.children.forEach((o, i) => assert.equal(o.geometry.attributes.position.array, localBuffers[i]));
  disposeRenderObjects([preview], { materials: false });
  release(before); release(after); world.dispose(); assert.equal(world.stats().meshes, 0);
}

// Optional roof material, deterministic architectural detail, and quality/distance switching.
{
  const b = shape(); delete b.detail; b.parts[0].roofMaterial = 'roof';
  const a = buildingGeometries(b), c = buildingGeometries(b);
  assert.ok(a.some((p) => p.role === 'detail'));
  assert.equal(a.find((p) => p.role === 'roof').m, 'roof');
  a.forEach(({ g }, i) => assert.deepEqual([...g.attributes.position.array], [...c[i].g.attributes.position.array]));
  const none = buildingGeometries(b, { detail: 'none' }); assert.ok(!none.some((p) => p.role === 'detail'));
  const world = new World3D(documentOf([b])).buildAll(), camera = new THREE.PerspectiveCamera();
  camera.position.set(1e4, 1e4, 1e4); world.update(camera);
  const details = []; world.groups.blocks.traverse((o) => { if (o.userData.detail) details.push(o); });
  assert.ok(details.length); assert.ok(details.every((o) => !o.visible));
  camera.position.set(6, 6, 30); world.update(camera); assert.ok(details.every((o) => o.visible));
  world.setQuality('low'); assert.ok(world.groups.blocks.children.every((g) => g.children.every((o) => !o.userData.detail)));
  world.dispose(); release(a); release(c); release(none);
}

// Sharing a PBR shader retains per-record colour and triangle ownership in a merged mesh.
{
  const a = shape(), b = shape(); b.transform.p[0] = 30; b.parts[0].m = 'other';
  const world = new World3D(documentOf([a, b]), { detail: 'none' }).buildAll();
  const root = world.groups.blocks; root.updateMatrixWorld(true);
  assert.equal(root.children[0].children.length, 1);
  for (const [x, rec] of [[2, a], [32, b]]) {
    const hit = new THREE.Raycaster(new THREE.Vector3(x, 2, 30), new THREE.Vector3(0, 0, -1)).intersectObject(root, true)[0];
    assert.equal(hit.object.userData.owner(hit.faceIndex), rec);
    const c = new THREE.Color(world.defs.materials[rec.parts[0].m].color), colors = hit.object.geometry.attributes.color;
    near(colors.getX(hit.face.a), c.r); near(colors.getY(hit.face.a), c.g); near(colors.getZ(hit.face.a), c.b);
  }
  world.defs.materials.wall.roughness = 0.31; world.defs.materials.wall.metalness = 0.7;
  world.defs.materials.wall.opacity = 0.6; world.defs.materials.wall.emissive = '#ff2200'; world.defs.materials.wall.emissiveIntensity = 0.4;
  world.refreshMaterials();
  const mat = [...world.mats.values()].find((m) => m.userData.m === 'wall');
  near(mat.roughness, 0.31); near(mat.metalness, 0.7); near(mat.opacity, 0.6); near(mat.emissiveIntensity, 0.4);
  assert.equal(mat.transparent, true); assert.equal(mat.depthWrite, false); world.dispose();
}

// Furniture parts sharing a colour produce one draw per cell/type; full transforms survive.
{
  const props = [{ t: 'bench', p: [3, 4, 5], h: 0.7, tilt: [0.2, 0.1], scale: [2, 1, 3] }, { t: 'bench', p: [650, 4, 5] }];
  const doc = documentOf([], props); doc.layers.defs.furniture.bench.parts[1].c = '#cc4422';
  const world = new World3D(doc).buildAll();
  assert.equal(world.groups.furniture.children.length, 2);
  assert.equal(world.propMats.size, 1, 'plain part colours retain one opaque PBR descriptor');
  const mesh = world.groups.furniture.children[0], m = new THREE.Matrix4(); mesh.getMatrixAt(0, m);
  assert.equal(mesh.material.vertexColors, true);
  assert.ok(new Set(mesh.geometry.attributes.color.array).size > 2, 'one prefab batch retains several part colours');
  near(m.elements[12], 3); near(new THREE.Vector3().setFromMatrixColumn(m, 0).length(), 2);
  assert.equal(mesh.userData.owner(0), props[0]); assert.ok(mesh.boundingSphere.radius < 10);
  const counts = new Map(), observed = new Set(), track = (r) => {
    if (!r || observed.has(r)) return; observed.add(r);
    r.addEventListener('dispose', () => counts.set(r, (counts.get(r) ?? 0) + 1));
  };
  world.groups.furniture.traverse((o) => { track(o); track(o.geometry); track(o.material); });
  world.buildFurniture(); assert.ok(counts.size > 0); assert.ok([...counts.values()].every((n) => n === 1));
  world.dispose(); assert.ok([...counts.values()].every((n) => n === 1));
}

// Furniture PBR resources split only incompatible descriptors; a record override wins.
{
  const a = { t: 'bench', p: [0, 0, 0] }, b = { t: 'bench', p: [10, 0, 0], material: 'paint' };
  const doc = documentOf([], [a, b]);
  doc.layers.defs.materials.paint = { color: '#2266cc', roughness: 0.8 };
  doc.layers.defs.materials.metal = { color: '#aabbcc', roughness: 0.2, metalness: 0.9, opacity: 0.6, emissive: '#cc2200', emissiveIntensity: 0.4 };
  doc.layers.defs.furniture.bench.parts[1].m = 'metal';
  const world = new World3D(doc).buildAll(), meshes = world.groups.furniture.children;
  assert.equal(meshes.length, 3); assert.equal(world.propMats.size, 2);
  const resourceMesh = meshes.find((m) => m.material.metalness === 0.9), oldResourceMaterial = resourceMesh.material;
  near(oldResourceMaterial.roughness, 0.2); near(oldResourceMaterial.opacity, 0.6); near(oldResourceMaterial.emissiveIntensity, 0.4);
  assert.equal(oldResourceMaterial.transparent, true); assert.equal(oldResourceMaterial.depthWrite, false);
  const overridden = meshes.find((m) => m.userData.owner(0) === b), paint = new THREE.Color('#2266cc');
  assert.equal(overridden.material.metalness, 0); assert.equal(overridden.material.opacity, 1);
  for (let i = 0; i < overridden.geometry.attributes.color.count; i++) {
    near(overridden.geometry.attributes.color.getX(i), paint.r); near(overridden.geometry.attributes.color.getZ(i), paint.b);
  }
  world.groups.furniture.updateMatrixWorld(true);
  for (const [x, rec] of [[0, a], [10, b]]) {
    const hit = new THREE.Raycaster(new THREE.Vector3(x, 0, 10), new THREE.Vector3(0, 0, -1)).intersectObject(world.groups.furniture, true)[0];
    assert.ok(hit); assert.equal(hit.object.userData.owner(hit.instanceId), rec);
  }
  // Even an identical building descriptor must have separate lifetime/ownership.
  const buildingMaterial = world.material('metal', null); assert.notEqual(buildingMaterial, oldResourceMaterial);
  let buildingDisposed = 0, oldDisposed = 0;
  buildingMaterial.addEventListener('dispose', () => buildingDisposed++); oldResourceMaterial.addEventListener('dispose', () => oldDisposed++);
  world.buildFurniture(); assert.equal(buildingDisposed, 0); assert.equal(oldDisposed, 0, 'live prop material is retained across rebuilds');
  Object.assign(doc.layers.defs.materials.metal, { color: '#cc8844', roughness: 0.45, metalness: 0.3, opacity: 0.9, emissive: '#00ff00', emissiveIntensity: 1.2 });
  world.refreshMaterials();
  assert.equal(oldDisposed, 1); assert.equal(world.propMats.size, 2);
  const changed = world.groups.furniture.children.find((m) => m.material.metalness === 0.3);
  near(changed.material.roughness, 0.45); near(changed.material.opacity, 0.9); near(changed.material.emissiveIntensity, 1.2);
  assert.equal(changed.material.emissive.getHex(), 0x00ff00);
  const tint = new THREE.Color('#cc8844'); near(changed.geometry.attributes.color.getX(0), tint.r);
  for (let i = 0; i < 12; i++) { doc.layers.defs.materials.metal.roughness = 0.2 + i * 0.01; world.buildFurniture(); assert.equal(world.propMats.size, 2); }
  world.L.furniture.items = []; world.buildFurniture(); assert.equal(world.propMats.size, 0);
  world.dispose(); assert.equal(oldDisposed, 1);
}

// Different material ids/colours with the same PBR fields stay in a single prefab batch.
{
  const doc = documentOf([], [{ t: 'bench', p: [0, 0, 0] }]);
  doc.layers.defs.materials.coatA = { color: '#11aa44', roughness: 0.8 };
  doc.layers.defs.materials.coatB = { color: '#8844dd', roughness: 0.8 };
  doc.layers.defs.furniture.bench.parts.forEach((p, i) => { p.m = i ? 'coatB' : 'coatA'; });
  const world = new World3D(doc).buildAll();
  assert.equal(world.groups.furniture.children.length, 1); assert.equal(world.propMats.size, 1);
  doc.layers.defs.materials.coatB.glow = 0.2; doc.layers.defs.materials.coatB.nightGlow = 1.5;
  world.refreshMaterials(); assert.equal(world.groups.furniture.children.length, 2);
  world.setNight(true); near([...world.propMats.values()].find((m) => m.userData.pbr.night === 1.5).emissiveIntensity, 1.5);
  world.setNight(false); near([...world.propMats.values()].find((m) => m.userData.pbr.night === 1.5).emissiveIntensity, 0.2);
  world.dispose();
}

// Road tile granularity changes draw grouping without changing record ownership or geometry.
{
  const doc = emptyWorld({ size: 2000, res: 100, ground: 10 }); doc.layers.defs.facades = {};
  doc.layers.roads.nodes = [[100, 0, 10], [500, 0, 10], [700, 200, 10], [900, 200, 10]].map((p, i) => ({ id: i + 1, p, grad: [0, 0] }));
  doc.layers.roads.edges = [
    { id: 1, n: [1, 2], cls: 'street', pts: [[100, 0, 10], [500, 0, 10]] },
    { id: 2, n: [3, 4], cls: 'street', pts: [[700, 200, 10], [900, 200, 10]] },
  ];
  const world = new World3D(doc, { roadTileSize: 600 }); world.buildRoads();
  const count = world.roadTiles.size;
  world.roadTileSize = 1200; world.buildRoads(); assert.ok(world.roadTiles.size < count); assert.equal(world.tileSize, 600);
  world.groups.roads.updateMatrixWorld(true);
  for (const [x, y, record] of [[200, 0, doc.layers.roads.edges[0]], [800, 200, doc.layers.roads.edges[1]]]) {
    const hit = new THREE.Raycaster(new THREE.Vector3(x, y, 50), new THREE.Vector3(0, 0, -1)).intersectObject(world.groups.roads, true)[0];
    assert.ok(hit); assert.equal(hit.object.userData.owner(hit.faceIndex), record);
  }
  world.dispose();
}

// Only transparent buildings split by authored owner; shared PBR descriptors stay cached.
{
  const a = shape(), b = shape(); b.transform.p[1] = 30;
  const doc = documentOf([a, b]); doc.layers.defs.materials.wall.opacity = 0.5;
  const world = new World3D(doc, { detail: 'none' }).buildAll(), root = world.groups.blocks;
  const meshes = root.children.flatMap((g) => g.children);
  assert.equal(meshes.length, 2); assert.equal(meshes[0].material, meshes[1].material);
  assert.notEqual(meshes[0].geometry.boundingSphere.center.y, meshes[1].geometry.boundingSphere.center.y, 'sort centers distinguish authored objects');
  root.updateMatrixWorld(true);
  for (const [y, rec] of [[2, a], [32, b]]) {
    const hit = new THREE.Raycaster(new THREE.Vector3(2, y, 50), new THREE.Vector3(0, 0, -1)).intersectObject(root, true)[0];
    assert.equal(hit.object.userData.owner(hit.faceIndex), rec);
  }
  doc.layers.defs.materials.wall.opacity = 1; world.refreshMaterials();
  assert.equal(root.children.flatMap((g) => g.children).length, 1, 'opaque objects return to one merged batch'); world.dispose();
}

// Transparent props become sortable Mesh records sharing buffers, while opaque props instance.
{
  const a = { t: 'bench', p: [0, 10, 0], material: 'glass' }, b = { t: 'bench', p: [0, 16, 0], material: 'glass' };
  const doc = documentOf([], [a, b]); doc.layers.defs.materials.glass = { color: '#4488cc', opacity: 0.45, roughness: 0.2 };
  const world = new World3D(doc).buildAll(); let meshes = world.groups.furniture.children;
  assert.equal(meshes.length, 2); assert.ok(meshes.every((m) => m.isMesh && !m.isInstancedMesh));
  assert.equal(meshes[0].geometry, meshes[1].geometry); assert.equal(meshes[0].material, meshes[1].material);
  world.groups.furniture.updateMatrixWorld(true);
  for (const [y, rec] of [[10, a], [16, b]]) {
    const hit = new THREE.Raycaster(new THREE.Vector3(0, y, 10), new THREE.Vector3(0, 0, -1)).intersectObject(world.groups.furniture, true)[0];
    assert.ok(hit); assert.equal(hit.object.userData.owner(hit.faceIndex), rec);
  }
  const oldMaterial = meshes[0].material; let oldDisposed = 0;
  oldMaterial.addEventListener('dispose', () => oldDisposed++);
  doc.layers.defs.materials.glass.opacity = 1; world.refreshMaterials();
  meshes = world.groups.furniture.children; assert.equal(meshes.length, 1); assert.equal(meshes[0].isInstancedMesh, true);
  assert.equal(meshes[0].count, 2); assert.equal(oldDisposed, 1); assert.equal(world.propMats.size, 1);
  doc.layers.defs.materials.glass.opacity = 0.3; world.refreshMaterials();
  meshes = world.groups.furniture.children; assert.equal(meshes.length, 2); assert.equal(world.propMats.size, 1);
  const shared = meshes[0].geometry; let geometryDisposed = 0, materialDisposed = 0;
  shared.addEventListener('dispose', () => geometryDisposed++); meshes[0].material.addEventListener('dispose', () => materialDisposed++);
  world.dispose(); world.dispose(); assert.equal(geometryDisposed, 1); assert.equal(materialDisposed, 1); assert.equal(oldDisposed, 1);
}

// Shared resources and owned tunnel textures dispose exactly once, and shutdown is idempotent.
{
  const world = new World3D(documentOf([shape()])), texture = new THREE.Texture(), mat = new THREE.MeshBasicMaterial({ map: texture });
  mat.userData.ownedTextures = [texture];
  const geo = new THREE.BoxGeometry(), a = new THREE.InstancedMesh(geo, mat, 1), b = new THREE.InstancedMesh(geo, mat, 1);
  world.groups.furniture.add(a, b); world.facades.shared = { map: texture }; world.mats.set('shared', mat);
  const counts = new Map();
  for (const r of [geo, mat, texture, a, b]) r.addEventListener('dispose', () => counts.set(r, (counts.get(r) ?? 0) + 1));
  world.dispose(); world.dispose();
  assert.equal(counts.size, 5); assert.ok([...counts.values()].every((n) => n === 1));
  const root = new THREE.Group(), gm = new THREE.MeshBasicMaterial(), gg = new THREE.BoxGeometry(); root.add(new THREE.Mesh(gg, gm));
  let materials = 0; gm.addEventListener('dispose', () => materials++);
  disposeRenderObjects([root], { materials: false }); assert.equal(materials, 0); gm.dispose();
}

// Headless canvas stub checks texture lifetime transitions without coupling to pixel rendering.
{
  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { fillRect() {}, createLinearGradient() { return { addColorStop() {} }; } }; } };
  try {
    const cache = facadeTextures({ office: { lit: 1 } });
    assert.equal(cache.office.bumpMap.colorSpace, THREE.NoColorSpace);
    const emissive = cache.office.emissiveMap; let disposed = 0;
    emissive.addEventListener('dispose', () => disposed++);
    facadeTextures({ office: { lit: 0 } }, 4, cache); assert.equal(disposed, 1); assert.equal(cache.office.emissiveMap, null);
    const map = cache.office.map, bump = cache.office.bumpMap; let removed = 0;
    map.addEventListener('dispose', () => removed++); bump.addEventListener('dispose', () => removed++);
    facadeTextures({}, 4, cache); assert.equal(removed, 2); assert.deepEqual(cache, {});
  } finally { if (previous === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = previous; }
}

// No train rendering/ticker unless explicitly requested; opting in still works.
{
  const doc = documentOf(); doc.layers.buildings.trains = [{ pts: [[0, 0, 0], [100, 0, 0]], closed: false }];
  const tickers = [() => {}], world = new World3D(doc, { tickers }).buildAll();
  assert.equal(world.groups.trains.children.length, 0); assert.equal(tickers.length, 1); world.dispose(); assert.equal(tickers.length, 1);
  const shown = new World3D(doc, { tickers, showTrains: true, animateTrains: true }).buildAll();
  assert.equal(shown.groups.trains.children.length, 2); assert.equal(tickers.length, 2);
  shown.buildTrains(); assert.equal(tickers.length, 2); shown.dispose(); assert.equal(tickers.length, 1);
}

// Reproducible structural draw budget, not a GPU benchmark: 1,000 buildings, two colours,
// shared PBR descriptor, four spatial cells. Every building mesh has one material/no groups.
{
  const items = Array.from({ length: 1000 }, (_, i) => {
    const b = shape(); delete b.detail; b.parts[0].holes = []; b.parts[0].m = i % 2 ? 'wall' : 'other';
    b.transform.p = [(i % 32) * 30, Math.floor(i / 32) * 30, 0]; return b;
  });
  const started = performance.now(), world = new World3D(documentOf(items)).buildAll(), stats = world.stats();
  assert.ok(stats.buildingMeshes <= 150, JSON.stringify(stats));
  assert.equal(stats.materials, 1); assert.equal(stats.cells, 4);
  world.groups.blocks.traverse((o) => { if (o.isMesh) { assert.ok(!Array.isArray(o.material)); assert.equal(o.geometry.groups.length, 0); } });
  console.log('1,000-building CPU construction:', Math.round(performance.now() - started), 'ms;', JSON.stringify(stats));
  world.dispose();
}
console.log('render geometry, transforms, picking, batching and disposal checks passed');
