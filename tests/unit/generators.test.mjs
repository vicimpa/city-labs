// Generator occupancy and migration correctness under local authoring transforms. Headless only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { emptyWorld, encodeWorld, decodeWorld } from '../../format/world.js';
import { localToWorld, buildingCenter } from '../../format/transforms.js';
import { FileSession } from '../../mcp/file-session.js';
import { runGenerator } from '../../mcp/generators.js';
import { migrateStructures } from '../../tools/migrate-structures.mjs';
import { unpackWorld } from '../../tools/vspb2json.mjs';

const cx = 1000, cy = 1000;
const params = { cx, cy, radius: 300, zone: 'suburb', density: 1, setback: 3, seed: 3 };
function source({ roads = true, duplicate = false } = {}) {
  const doc = emptyWorld({ size: 4096, res: 32, ground: 10 });
  if (roads) {
    doc.layers.roads.nodes = [{ id: 1, p: [800, cy, 10] }, { id: 2, p: [1200, cy, 10] }];
    const pts = Array.from({ length: 101 }, (_, i) => [800 + i * 4, cy, 10]);
    doc.layers.roads.edges = [{ id: 1, cls: 'street', n: [1, 2], pts, elev: pts.map(() => 0), tunnel: pts.map(() => 0), trim: [0, 0] }];
    if (duplicate) doc.layers.roads.edges.push({ ...structuredClone(doc.layers.roads.edges[0]), id: 2 });
  }
  return doc;
}
async function session(doc, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'city-generator-transform-'));
  try {
    const file = path.join(dir, 'scratch world.vspb'); fs.writeFileSync(file, await encodeWorld(doc));
    return await fn(await new FileSession(file).ready(), dir, file);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function bounds(building, caps = true) {
  const out = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of building.parts) for (const p of part.p) for (const z of caps ? [part.z, part.z + part.h] : [part.z]) {
    const [x, y] = localToWorld(building, [p[0], p[1], z]);
    out[0] = Math.min(out[0], x); out[1] = Math.min(out[1], y); out[2] = Math.max(out[2], x); out[3] = Math.max(out[3], y);
  }
  return out;
}
const overlaps = (a, b) => a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6;
function disjoint(items) {
  const boxes = items.map((b) => bounds(b));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]), `buildings ${i}/${j} overlap: ${boxes[i]} and ${boxes[j]}`);
}
const obstacle = (position, r = [0, 0, 0], s = [1, 1, 1], half = 25, height = 35) => ({
  type: 'block', zone: 'midtown', transform: { p: [...position], r: [...r], s: [...s] },
  parts: [{ p: [[-half, -half], [half, -half], [half, half], [-half, half]], z: 0, h: height, m: 'concrete' }],
});
let firstCenter;
test('generated wall/roof rings stay distinct and world occupancy survives normalization', async () => session(source({ duplicate: true }), async (s) => {
  const generated = await runGenerator(s, 'buildings', params);
  const items = s.doc.layers.buildings.items;
  assert.ok(generated.result.buildings >= 8);
  disjoint(items);
  for (const b of items) {
    assert.ok(buildingCenter(b)[0] > 700, 'normalization kept the building near the road in world space');
    assert.notEqual(b.parts[0].p, b.parts[1].p, 'a roof must not alias its wall outline');
    const bottom = b.parts[0].p.map((p) => localToWorld(b, [...p, b.parts[0].z]));
    const top = b.parts[1].p.map((p) => localToWorld(b, [...p, b.parts[1].z]));
    bottom.forEach((p, i) => { assert.equal(p[0], top[i][0]); assert.equal(p[1], top[i][1]); });
  }
  firstCenter = buildingCenter(items[0]);
  assert.equal(s.history.done.length, 1);
  const again = await runGenerator(s, 'buildings', params);
  assert.equal(again.result.buildings, 0, 'a repeated seed does not insert colliding replacements');
  assert.equal(s.history.done.length, 1, 'an empty generator run adds no undo command');
}));

for (const [name, rotation, scale] of [['translated', [0, 0, 0], [1, 1, 1]], ['yaw + nonuniform scale', [0, 0, 0.7], [1.8, 0.6, 1.2]], ['tilted + nonuniform scale', [0.4, 0.8, 0.3], [1.2, 0.8, 1.6]]]) {
  test(`building generation respects ${name} obstacles at their world positions`, async () => {
    const center = firstCenter ?? [820, 1025, 10], block = obstacle(center, rotation, scale), reserved = bounds(block), doc = source();
    doc.layers.buildings.items.push(block);
    await session(doc, async (s) => {
      const result = await runGenerator(s, 'buildings', params);
      assert.ok(result.result.buildings > 0, 'the generator still fills unobstructed lots');
      for (const b of s.doc.layers.buildings.items.slice(1)) assert.ok(!overlaps(bounds(b), reserved), 'a generated building intersects the projected obstacle');
      disjoint(s.doc.layers.buildings.items.slice(1));
    });
  });
}
test('tilted top-cap overhang blocks a lot even when the base ring is elsewhere', async () => {
  const center = firstCenter ?? [820, 1025, 10], block = obstacle([center[0] - 50, center[1], 10], [0, Math.PI / 4, 0], [1, 2, 1], 5, 100);
  const probe = [center[0] - 7, center[1] - 5, center[0] + 7, center[1] + 5];
  assert.ok(!overlaps(bounds(block, false), probe)); assert.ok(overlaps(bounds(block), probe));
  const doc = source(); doc.layers.buildings.items.push(block);
  await session(doc, async (s) => {
    await runGenerator(s, 'buildings', params);
    for (const b of s.doc.layers.buildings.items.slice(1)) assert.ok(!overlaps(bounds(b), bounds(block)), 'a building occupies the top-cap projection');
  });
});
test('tree generation excludes the transformed obstacle projection including tilted top caps', async () => {
  const options = { cx, cy, radius: 60, perHectare: 400, patchiness: 0, seed: 11 };
  const block = obstacle([cx - 50, cy, 10], [0, Math.PI / 4, 0], [1, 2, 1], 8, 100), reserved = bounds(block);
  let baselineInside = 0;
  await session(source({ roads: false }), async (s) => {
    await runGenerator(s, 'trees', options);
    baselineInside = s.doc.layers.buildings.trees.filter(([x, y]) => overlaps([x - 1.98, y - 1.98, x + 1.98, y + 1.98], reserved)).length;
  });
  assert.ok(baselineInside > 0, 'seeded candidates exercise the obstacle region');
  const doc = source({ roads: false }); doc.layers.buildings.items.push(block);
  await session(doc, async (s) => {
    const result = await runGenerator(s, 'trees', options); assert.ok(result.result.trees > 0);
    for (const [x, y] of s.doc.layers.buildings.trees) assert.ok(!overlaps([x - 1.98, y - 1.98, x + 1.98, y + 1.98], reserved));
  });
});
test('structure migration connects transformed posts by their world centers and is idempotent', async () => {
  const doc = source({ roads: false }), B = doc.layers.buildings;
  for (const x of [1200, 1300]) B.items.push({ ...obstacle([x, 1800, 10], [0.2, 0.35, 0.7], [2, 0.7, 1.4], 2, 20), type: 'pylon' });
  B.cables = [[[1200, 1800, 30], [1300, 1800, 30]], [[-400, -400, 20], [-350, -400, 20]]];
  const result = migrateStructures(doc);
  assert.equal(result.posts, 2); assert.equal(result.powerlines, 1); assert.equal(B.cables.length, 1);
  assert.deepEqual(B.powerlines[0].pts, [[1200, 1800], [1300, 1800]]);
  const snapshot = structuredClone(B); const second = migrateStructures(doc);
  assert.equal(second.posts, 0); assert.deepEqual(B, snapshot);
});
test('structure migration visits vertical spans once when post X coordinates are equal', () => {
  const doc = source({ roads: false }), B = doc.layers.buildings;
  for (const y of [1800, 1900]) B.items.push({ ...obstacle([1200, y, 10]), type: 'pylon' });
  B.cables = [[[1200, 1800, 30], [1200, 1900, 30]]];
  const result = migrateStructures(doc); assert.equal(result.powerlines, 1); assert.equal(B.powerlines.length, 1);
});
test('large legal tilted projections use bounded occupancy storage', async () => {
  const doc = source({ roads: false });
  doc.layers.buildings.items.push(obstacle([cx - 10, cy, 10], [0, Math.PI / 4, 0], [1000, 1000, 1000], 25, 10000));
  await session(doc, async (s) => {
    const result = await runGenerator(s, 'trees', { cx, cy, radius: 60, perHectare: 25, patchiness: 0 });
    assert.equal(result.result.trees, 0);
  });
});
test('migration CLI defaults to a new output and refuses source/target overwrite', async () => {
  const doc = source({ roads: false });
  await session(doc, async (s, dir, file) => {
    const before = fs.readFileSync(file);
    execFileSync(process.execPath, ['tools/migrate-structures.mjs', file], { cwd: path.resolve(import.meta.dirname, '../..'), stdio: 'pipe' });
    assert.deepEqual(fs.readFileSync(file), before);
    const out = file.replace(/\.vspb$/i, '') + '.structures.vspb'; assert.ok(fs.existsSync(out));
    await decodeWorld(fs.readFileSync(out));
    assert.throws(() => execFileSync(process.execPath, ['tools/migrate-structures.mjs', file, file], { cwd: path.resolve(import.meta.dirname, '../..'), stdio: 'pipe' }));
    assert.deepEqual(fs.readFileSync(file), before);
    const previous = fs.readFileSync(out);
    assert.throws(() => execFileSync(process.execPath, ['tools/migrate-structures.mjs', file, out], { cwd: path.resolve(import.meta.dirname, '../..'), stdio: 'pipe' }));
    assert.deepEqual(fs.readFileSync(out), previous);
  });
});
test('JSON unpack expands sparse terrain, preserves transforms and confines unusual layer filenames', async () => {
  const doc = source({ roads: false }); doc.layers.terrain.h[3] = 19;
  doc.layers.buildings.items.push(obstacle([1200, 1700, 10], [0.2, 0.4, 0.6], [2, 0.5, 1]));
  doc.layers['../escape'] = { preserved: true };
  doc.layers.CON = { preserved: 'reserved' }; doc.layers._CON = { preserved: 'literal' }; doc.layers.Terrain = { preserved: 'case distinct' };
  await session(doc, async (s, dir, file) => {
    const output = path.join(dir, 'json'), result = await unpackWorld(file, output);
    const terrain = JSON.parse(fs.readFileSync(path.join(output, 'terrain.json'))), buildings = JSON.parse(fs.readFileSync(path.join(output, 'buildings.json')));
    assert.equal(terrain.h[3], 19); assert.equal(terrain.heightEncoding, undefined); assert.equal(terrain.h.length, terrain.nx * terrain.ny);
    assert.deepEqual(buildings.items[0].transform, s.doc.layers.buildings.items[0].transform);
    assert.equal(new Set(result.files.map(({ file }) => path.basename(file).toLowerCase())).size, result.files.length, 'case-insensitive/reserved names do not collide');
    for (const entry of result.files) { assert.equal(path.dirname(entry.file), output); if (['CON', '_CON', 'Terrain'].includes(entry.name)) assert.equal(JSON.parse(fs.readFileSync(entry.file)).preserved, doc.layers[entry.name].preserved); }
    const unknown = result.files.find((entry) => entry.name === '../escape'); assert.ok(unknown);
    assert.equal(JSON.parse(fs.readFileSync(unknown.file)).preserved, true); assert.ok(!fs.existsSync(path.join(dir, 'escape.json')));
  });
});
