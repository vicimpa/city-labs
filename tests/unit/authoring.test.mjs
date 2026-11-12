// Behavioral checks of the document/command contract, independent of WebGL.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyWorld, withDefaults, encodeWorld, decodeWorld } from '../../format/world.js';
import { decode, encode } from '../../format/vspb.js';
import { localToWorld, worldToLocal, buildingMatrix } from '../../format/transforms.js';
import { transformRecord, assignMaterial } from '../../editor/commands.js';
import { addRoad, snapEnd } from '../../editor/roadedit.js';
import { FileSession } from '../../mcp/file-session.js';
import { runScript } from '../../mcp/script.js';
import { materialReferences, validateWorld } from '../../format/validate.js';
import { renderMap } from '../../mcp/map.js';

const legacy = () => ({ type: 'courtyard', zone: 'midtown', note: 'preserved', parts: [{ p: [[1000, 2000], [1040, 2000], [1040, 2030], [1000, 2030]], holes: [[[1010, 2010], [1010, 2020], [1020, 2020], [1020, 2010]]], z: 12.25, h: 18, m: 'brick' }] });
const docWithBuilding = () => { const d = emptyWorld({ size: 256, res: 8 }); d.layers.buildings.items.push(legacy()); return withDefaults(d); };

test('legacy local migration preserves every world vertex, hole and unknown field', () => {
  const original = legacy(), d = emptyWorld({ size: 256, res: 8 }); d.layers.buildings.items.push(structuredClone(original)); withDefaults(d);
  const b = d.layers.buildings.items[0]; assert.deepEqual(b.transform.p, [1020, 2015, 12.25]); assert.equal(b.note, original.note);
  for (const [ri, ring] of [original.parts[0].p, ...original.parts[0].holes].entries()) {
    const local = [b.parts[0].p, ...b.parts[0].holes][ri];
    ring.forEach((p, i) => assert.deepEqual(localToWorld(b, [...local[i], b.parts[0].z]), [...p, original.parts[0].z]));
  }
  const snapshot = structuredClone(b); withDefaults(d); assert.deepEqual(b, snapshot, 'migration is idempotent');
});

test('object transforms preserve local buffers and invert arbitrary positive TRS', () => {
  const d = docWithBuilding(), b = d.layers.buildings.items[0], before = structuredClone(b.parts);
  transformRecord(d, 'building', b, { dx: 12, dy: -8, dz: 4, rotate_deg: 37, scale: [1.2, 0.7, 2] });
  b.transform.r[0] = 0.42; b.transform.r[1] = -0.2;
  assert.deepEqual(b.parts, before);
  for (const p of [[-20, -15, 0], [0, 0, 18], [15.2, -6.2, 5.5]]) {
    const q = worldToLocal(b, localToWorld(b, p)); p.forEach((v, i) => assert(Math.abs(v - q[i]) < 1e-9));
  }
  assert(buildingMatrix(b).every(Number.isFinite));
});

test('compact terrain and transforms round trip exactly, future model refused', async () => {
  const d = docWithBuilding(), t = d.layers.terrain; t.h[27] = 18.125; t.h[82] = -3.25;
  const bytes = await encodeWorld(d), stored = await decode(bytes), again = await decodeWorld(bytes);
  assert.equal(stored.layers.terrain.heightEncoding, 'sparse-grade-v1'); assert.equal(stored.layers.terrain.h, undefined);
  assert.deepEqual(again.layers.terrain.h, t.h); assert.deepEqual(again.layers.terrain.base, t.base);
  assert.deepEqual(again.layers.buildings.items[0], d.layers.buildings.items[0]);
  const future = { ...d, meta: { documentVersion: 999 } }; await assert.rejects(decodeWorld(await encode(future)), /unsupported document version/);
  const bad = structuredClone(stored); bad.layers.terrain.gradeIndex[0] = 999999; await assert.rejects(decodeWorld(await encode(bad)), /sparse/);
});

test('level-aware road snapping rejects overhead roads and failed topology edits roll back', () => {
  const d = emptyWorld({ size: 512, res: 8, ground: 0 }), R = d.layers.roads;
  const road = addRoad(d, () => 0, [[-100, 0], [100, 0]], 'street', 'bridge', { elevation: 20, snap: false });
  assert(road); assert.equal(snapEnd(R, [0, 0, 0], R.classes.street), null);
  assert(snapEnd(R, [0, 0, 23], R.classes.street)?.edge);
  const before = structuredClone(R);
  const rejected = addRoad(d, () => 0, [[0, 0, 23], [0.1, 0, 23]], 'street', 'too short');
  assert.equal(rejected, null); assert.deepEqual(R, before);
});

test('headless commands are atomic, undoable and scripts form one transaction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'city-labs-authoring-')), file = path.join(dir, 'scratch.vspb');
  try {
    fs.writeFileSync(file, await encodeWorld(docWithBuilding())); const s = await new FileSession(file).ready(), b = s.doc.layers.buildings.items[0], before = structuredClone(b);
    assert.throws(() => s.edit('building', b, (r) => { r.note = 'partial'; r.transform.s[0] = 0; }), /scale/);
    assert.deepEqual(b, before); assert.equal(s.history.done.length, 0); assert.equal(s.dirty.size, 0);
    await runScript(s, "world.move('building', world.list('building')[0], 4, 5); world.scale('building', world.list('building')[0], 2)");
    assert.equal(s.history.done.length, 1); s.undo(); assert.deepEqual(b, before); s.redo(); assert.equal(b.transform.s[0], 2);
    const applied = structuredClone(b), count = s.history.done.length;
    await assert.rejects(runScript(s, "world.move('building', world.list('building')[0], 100, 100); throw new Error('rollback')"), /rolled back/);
    assert.deepEqual(b, applied); assert.equal(s.history.done.length, count);
    s.setDef('materials', 'custom', { color: '#c0ffee', roughness: 0.35, metalness: 0.4 });
    s.edit('building', b, (r) => assignMaterial(s.doc, r, 'custom'));
    assert.equal(materialReferences(s.doc, 'custom').length, 1); assert.throws(() => s.setDef('materials', 'custom', null), /used/);
    await s.save(); const opened = await decodeWorld(fs.readFileSync(file)); assert.equal(opened.layers.buildings.items[0].parts[0].m, 'custom');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('top-down maps project local building instances at world positions', () => {
  const d = docWithBuilding();
  const map = renderMap(d, { bbox: [990, 1990, 1050, 2040], width: 120, layers: ['buildings'] });
  const k = (70 * map.width + 30) * 4; // (1005,2005), outside the courtyard hole
  assert(map.rgba[k] > map.rgba[k + 2], 'brick footprint appears at the expected global position');
  assert.doesNotThrow(() => validateWorld(d));
});

test('the complete v1 sample migrates and compactly reopens within one millimetre', async () => {
  const source = fs.readFileSync('city/data/vespera.vspb'), legacyDoc = await decode(source), migrated = await decodeWorld(source);
  const packed = await encodeWorld(migrated), opened = await decodeWorld(packed);
  let maximum = 0, vertices = 0;
  legacyDoc.layers.buildings.items.forEach((b, bi) => b.parts.forEach((part, pi) => {
    const next = opened.layers.buildings.items[bi].parts[pi], instance = opened.layers.buildings.items[bi];
    for (const [ri, ring] of [part.p, ...(part.holes ?? [])].entries()) ring.forEach((q, qi) => {
      const p = [next.p, ...(next.holes ?? [])][ri][qi], world = localToWorld(instance, [...p, next.z]);
      maximum = Math.max(maximum, Math.hypot(world[0] - q[0], world[1] - q[1], world[2] - part.z)); vertices++;
    });
  }));
  assert(maximum < 0.001, `max world vertex error ${maximum} m`);
  assert.deepEqual(opened.layers.terrain.h, migrated.layers.terrain.h); assert.deepEqual(opened.layers.terrain.base, migrated.layers.terrain.base);
  assert.equal(opened.layers.roads.edges.length, legacyDoc.layers.roads.edges.length);
  assert.deepEqual(opened.layers.issues, legacyDoc.layers.issues, 'unrelated extension layer survives');
  assert(packed.length < source.length * 0.65, 'compact sample is materially smaller');
  console.log(`Full sample: ${vertices} vertices, max world error ${maximum.toExponential(3)} m; ${source.length} -> ${packed.length} bytes`);
});

test('v2 does not resurrect deliberately deleted unused built-in materials', async () => {
  const d = docWithBuilding(); delete d.layers.defs.materials.bronze;
  const again = await decodeWorld(await encodeWorld(d)); assert.equal(Object.hasOwn(again.layers.defs.materials, 'bronze'), false);
});
