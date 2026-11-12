import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TerrainChunks } from '../../viewer/terrain.js';
import { World3D } from '../../viewer/world3d.js';

const close = (a, b, e = 1e-4) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
function terrain(nx = 131, ny = 99, height = (x, y) => 10 + Math.sin(x / 12) * Math.cos(y / 17)) {
  const t = { nx, ny, x0: 0, y0: 0, res: 1, h: new Float32Array(nx * ny) };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) t.h[j * nx + i] = height(i, j);
  t.base = t.h.slice(); return t;
}
function source(t) {
  const positions = [], colors = [], normals = [];
  for (let j = 0; j < t.ny; j++) for (let i = 0; i < t.nx; i++) {
    positions.push(t.x0 + i * t.res, t.y0 + j * t.res, t.h[j * t.nx + i]); colors.push(0.3, 0.5, 0.2); normals.push(0, 0, 1);
  }
  const g = new THREE.BufferGeometry();
  for (const [key, values] of [['position', positions], ['color', colors], ['normal', normals]]) g.setAttribute(key, new THREE.Float32BufferAttribute(values, 3));
  return g;
}
function denseMesh(t, g) {
  const geo = g.clone(), index = [];
  for (let j = 0; j < t.ny - 1; j++) for (let i = 0; i < t.nx - 1; i++) {
    const a = j * t.nx + i, b = a + 1, c = a + t.nx + 1, d = a + t.nx; index.push(a, b, c, a, c, d);
  }
  geo.setIndex(index); const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial()); mesh.updateMatrixWorld(); return mesh;
}
function heightAt(chunks, x, y) {
  const ray = new THREE.Raycaster(new THREE.Vector3(x, y, 500), new THREE.Vector3(0, 0, -1)), hits = [];
  chunks.group.updateMatrixWorld(true);
  for (const chunk of chunks.chunks) THREE.Mesh.prototype.raycast.call(chunk.mesh, ray, hits);
  hits.sort((a, b) => a.distance - b.distance); assert.ok(hits.length, `no terrain at ${x},${y}`); return hits[0].point.z;
}
const material = new THREE.MeshBasicMaterial();

// Mismatched chunk LODs share every boundary vertex; partial edge chunks remain watertight.
{
  const t = terrain(), g = source(t), chunks = new TerrainChunks(t, g, material, { chunkCells: 32 });
  assert.equal(chunks.chunks.length, 20); assert.equal(g.index, null);
  chunks.chunks.forEach((c, i) => chunks.rebuild(c, i % 2 ? 1 : 8));
  const edge = (chunk, x) => {
    const a = chunk.mesh.geometry.attributes.position, points = new Map();
    for (let i = 0; i < a.count; i++) if (a.getX(i) === x) points.set(a.getY(i), a.getZ(i));
    return [...points].sort((a, b) => a[0] - b[0]);
  };
  for (const a of chunks.chunks) {
    const b = chunks.chunks.find((c) => c.i0 === a.i1 && c.j0 === a.j0);
    if (b) { assert.deepEqual(edge(a, a.i1), edge(b, b.i0)); assert.equal(edge(a, a.i1).length, a.j1 - a.j0 + 1); }
    const geo = a.mesh.geometry, p = geo.attributes.position, indices = geo.index.array;
    let area = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const [aa, bb, cc] = indices.subarray(i, i + 3);
      const cross = (p.getX(bb) - p.getX(aa)) * (p.getY(cc) - p.getY(aa)) - (p.getY(bb) - p.getY(aa)) * (p.getX(cc) - p.getX(aa));
      assert.ok(cross > 0, 'all triangles face up and have positive area'); area += cross / 2;
    }
    close(area, (a.i1 - a.i0) * (a.j1 - a.j0));
  }
  chunks.dispose(); chunks.dispose(); g.dispose();
}

// Far LOD preserves original triangulation beneath a road cut and at the shoreline.
{
  const t = terrain(129, 97, (x, y) => x < 28 ? (x - 20) * 0.6 : 2 + (y - 48) ** 2 * 0.015 + Math.sin(x / 3) * 0.8);
  const g = source(t), roads = { classes: { street: { hw: 3 } }, edges: [{ cls: 'street', pts: [[29, 48, 2], [128, 48, 2]] }] };
  const chunks = new TerrainChunks(t, g, material, { chunkCells: 32, roads }), full = denseMesh(t, g);
  for (const c of chunks.chunks) chunks.rebuild(c, 8);
  for (const [x, y] of [[40.25, 48.25], [75.75, 47.5], [100.4, 49.2], [20.25, 12.75], [19.75, 66.2]]) {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, y, 500), new THREE.Vector3(0, 0, -1));
    close(heightAt(chunks, x, y), ray.intersectObject(full)[0].point.z);
  }
  const roadX = 65.25, roadY = 48.25, height = heightAt(chunks, roadX, roadY);
  assert.ok(height < 3.2, 'terrain stays inside road cut, rather than interpolating the surrounding hillside across it');
  chunks.dispose(); g.dispose(); full.geometry.dispose(); full.material.dispose();
}

// Park/plaza overlays keep their dense underlying surface after moving/changing a polygon.
{
  const t = terrain(97, 97, (x, y) => 10 + ((x - 48) ** 2 + (y - 48) ** 2) * 0.01);
  const g = source(t), full = denseMesh(t, g), chunks = new TerrainChunks(t, g, material, { chunkCells: 32 });
  for (const c of chunks.chunks) chunks.rebuild(c, 8);
  const expected = new THREE.Raycaster(new THREE.Vector3(45.25, 45.25, 500), new THREE.Vector3(0, 0, -1)).intersectObject(full)[0].point.z;
  assert.ok(Math.abs(heightAt(chunks, 45.25, 45.25) - expected) > 0.1, 'unprotected coarse interpolation differs inside a small depression');
  chunks.setSurfaces([{ p: [[36, 36], [58, 36], [58, 58], [36, 58]] }]);
  close(heightAt(chunks, 45.25, 45.25), expected);
  chunks.setSurfaces([]); assert.ok(Math.abs(heightAt(chunks, 45.25, 45.25) - expected) > 0.1);
  chunks.dispose(); g.dispose(); full.geometry.dispose(); full.material.dispose();
}

// Distance LOD materially reduces a flat unprotected terrain; close detail returns to step 1.
{
  const t = terrain(257, 257, () => 10), g = source(t), chunks = new TerrainChunks(t, g, material, { chunkCells: 64 });
  const camera = new THREE.PerspectiveCamera(); camera.position.set(1e4, -1e4, 1e4); chunks.update(camera);
  const far = chunks.chunks.reduce((n, c) => n + c.mesh.geometry.index.count / 3, 0);
  assert.ok(far < 2 * 256 * 256 / 8, `far triangles ${far}`);
  camera.position.set(128, 128, 25); chunks.update(camera);
  assert.ok(chunks.chunks.every((c) => c.step === 1));
  const near = chunks.chunks.reduce((n, c) => n + c.mesh.geometry.index.count / 3, 0);
  assert.equal(near, 2 * 256 * 256); chunks.dispose(); g.dispose();
}

// Sculpt updates authoritative export attributes and only affected render chunks/bounds.
{
  const t = terrain(514, 259, () => 10), doc = { layers: { terrain: t, defs: {} } }, world = new World3D(doc).buildAll();
  assert.equal(world.terrainGeo.index, null); assert.equal(world.terrainGeo.attributes.position.count, t.nx * t.ny);
  const previous = world.terrainChunks.chunks.map((c) => c.mesh.geometry), counters = new Map();
  for (const g of previous) g.addEventListener('dispose', () => counters.set(g, (counters.get(g) ?? 0) + 1));
  t.h[80 * t.nx + 80] = 160; world.updateTerrain(80, 80, 80, 80);
  assert.equal(world.terrainGeo.attributes.position.getZ(80 * t.nx + 80), 160);
  const changed = world.terrainChunks.chunks[0];
  assert.equal(changed.mesh.geometry, previous[0], 'ordinary brush updates reuse GPU buffers');
  assert.equal(changed.mesh.geometry.boundingBox.max.z, 160);
  assert.equal(counters.size, 0);
  t.h[80 * t.nx + 80] = 0.2; world.updateTerrain(80, 80, 80, 80);
  assert.equal(counters.size, 1, 'a new shoreline rebuilds only its affected chunk topology');
  assert.ok([...counters.values()].every((n) => n === 1));
  world.dispose(); assert.ok([...counters.values()].every((n) => n === 1));
}
material.dispose();
console.log('terrain LOD: stitched borders, positive area, road cuts, shorelines, distance budgets, sculpt locality and disposal passed');
