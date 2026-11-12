// Independent binary-boundary, compatibility and command-atomicity regressions.
// Headless, deterministic, scratch files only. Run: node tests/unit/format.robustness.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { decode, encode } from '../../format/vspb.js';
import { emptyWorld, encodeWorld, decodeWorld } from '../../format/world.js';
import { validateWorld, validateRecord } from '../../format/validate.js';
import { ensureLocalBuilding, localToWorld, worldToLocal, buildingCenter } from '../../format/transforms.js';
import { FileSession } from '../../mcp/file-session.js';
import { runScript } from '../../mcp/script.js';

let failures = 0, checks = 0;
const test = async (name, fn) => { checks++; try { await fn(); console.log(`OK   ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message}`); } };
class Bytes {
  parts = []; size = 0;
  bytes(v) { const b = Buffer.from(v); this.parts.push(b); this.size += b.length; return this; }
  u8(v) { return this.bytes([v]); }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return this.bytes(b); }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return this.bytes(b); }
  str(v) { const b = Buffer.from(v); return this.u32(b.length).bytes(b); }
  align(n) { return this.bytes(Buffer.alloc((n - this.size % n) % n)); }
  out() { return Buffer.concat(this.parts); }
}
const chunk = (tag, payload, flags = 0, raw = payload.length) => new Bytes().bytes(Buffer.from(tag)).u32(flags).u32(raw).u32(payload.length).bytes(payload).align(8).out();
const header = () => new Bytes().bytes(Buffer.from('VSPB')).u16(1).u16(0).u32(0).u32(0).out();
const file = (...chunks) => Buffer.concat([header(), chunk('META', Buffer.from('{}')), ...chunks, chunk('END ', Buffer.alloc(0))]);
function table({ name = 'x.items', parent = '', mode = 0, rows = 1, columns = [{ name: 'id', values: [1] }] } = {}) {
  const b = new Bytes().str(name).str(parent).u8(mode).u32(rows).u16(columns.length);
  for (const c of columns) {
    if (c.strings) {
      const dictionary = [...new Set(c.strings)];
      b.str(c.name).u8(10).u8(1).u8(0).u8(0).u32(dictionary.length);
      dictionary.forEach((v) => b.str(v));
      b.u32(c.strings.length).align(8); c.strings.forEach((v) => b.u32(dictionary.indexOf(v)));
    } else {
      b.str(c.name).u8(5).u8(1).u8(0).u8(0).u32(c.values.length).align(8);
      c.values.forEach((v) => b.u32(v));
    }
  }
  return b.out();
}
const world = () => emptyWorld({ size: 32, res: 2, ground: 0 });
async function withSession(fn, build = world) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'city-format-robust-'));
  try {
    const name = path.join(dir, 'scratch.vspb'); fs.writeFileSync(name, await encodeWorld(build()));
    return await fn(await new FileSession(name).ready(), name);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

await test('every strict prefix of a valid binary is rejected', async () => {
  const data = file(chunk('TABL', table()));
  assert.equal((await decode(data)).layers.x.items[0].id, 1);
  for (let n = 0; n < data.length; n++) await assert.rejects(decode(data.subarray(0, n)), undefined, `accepted truncated prefix ${n}/${data.length}`);
});
await test('oversized chunk budgets and malformed compressed length reject without allocation', async () => {
  const oversized = file(chunk('META', Buffer.alloc(0), 0, 512 * 1024 * 1024 + 1));
  await assert.rejects(decode(oversized), /budget|bounds|size/);
  const bomb = file(chunk('META', deflateRawSync(Buffer.from(' '.repeat(100000))), 1 << 8, 4));
  await assert.rejects(decode(bomb), /declared|corrupt/);
  const badStored = file(chunk('TABL', table())); badStored.writeUInt32LE(0xffffffff, 16 + 24 + 12);
  await assert.rejects(decode(badStored));
});
await test('invalid parents, duplicate tables and excessive row counts reject', async () => {
  await assert.rejects(decode(file(chunk('TABL', table({ parent: 'missing' })))), /parent/);
  await assert.rejects(decode(file(chunk('TABL', table({ name: 'x.parents' })), chunk('TABL', table({ name: 'x.parents.children', parent: 'x.parents', columns: [{ name: '$parent', values: [4] }] })))), /parent/);
  await assert.rejects(decode(file(chunk('TABL', table()), chunk('TABL', table()))), /duplicate/);
  await assert.rejects(decode(file(chunk('TABL', table({ rows: 1000001, columns: [] })))), /table/);
  await assert.rejects(decode(file(chunk('TABL', table({ name: '__proto__' })))), /table/);
});
await test('duplicate named columns cannot silently overwrite values', async () => {
  await assert.rejects(decode(file(chunk('TABL', table({ columns: [{ name: 'id', values: [7] }, { name: 'id', values: [9] }] })))));
});
await test('map tables reject missing and repeated keys instead of silently losing rows', async () => {
  await assert.rejects(decode(file(chunk('TABL', table({ name: 'x.map', mode: 1, rows: 2, columns: [{ name: 'value', values: [7, 9] }] })))));
  await assert.rejects(decode(file(chunk('TABL', table({ name: 'x.map', mode: 1, rows: 2, columns: [{ name: '$key', strings: ['same', 'same'] }, { name: 'value', values: [7, 9] }] })))));
});
await test('seeded corrupt-header fuzz has bounded rejection and no unhandled promise failures', async () => {
  let state = 0x5eed1234; const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const source = file(chunk('TABL', table()));
  const unhandled = []; const capture = (error) => unhandled.push(error); process.on('unhandledRejection', capture);
  try {
    for (let i = 0; i < 64; i++) {
      const data = Buffer.from(source); const pos = 16 + 24;
      data.writeUInt32LE((0x80000000 | (rand() & 0x7fffffff)) >>> 0, pos + (i % 2 ? 8 : 12));
      await assert.rejects(decode(data));
    }
    await new Promise((r) => setImmediate(r)); assert.equal(unhandled.length, 0);
  } finally { process.off('unhandledRejection', capture); }
});
await test('unknown ancillary codec and nested extension fields round-trip verbatim', async () => {
  const encoded = file(chunk('TABL', table()), chunk('XTRA', Buffer.from([0, 255, 8, 9]), 77 << 8, 123));
  const decoded = await decode(encoded), again = await decode(await encode(decoded));
  const opaque = (chunks) => chunks.map((u) => ({ ...u, body: [...u.body] }));
  assert.deepEqual(opaque(again.unknown), opaque(decoded.unknown));
  const doc = world(); doc.meta['com.example.future'] = { enabled: true, options: [1, null, 'x'] };
  doc.layers.future = { records: [{ vendor: 'custom', params: { gain: 0.1234567890123 }, children: [{ id: 'a', flags: [1, 3] }] }] };
  const reloaded = await decodeWorld(await encodeWorld(doc));
  assert.deepEqual(reloaded.layers.future, doc.layers.future); assert.deepEqual(reloaded.meta['com.example.future'], doc.meta['com.example.future']);
});
await test('editing preserved integer vectors widens types instead of truncating', async () => {
  const first = await decode(await encode({ layers: { f: { items: [{ p: [1, 2] }] } } }, { hints: { 'f.items.p': 'u8x2' } }));
  first.layers.f.items[0].p = [1000, -2];
  const second = await decode(await encode(first));
  assert.deepEqual(second.layers.f.items[0].p, [1000, -2]);
});
await test('editing preserved integer typed lists widens incompatible element types', async () => {
  const first = await decode(await encode({ layers: { f: { samples: new Uint8Array([1, 2]) } } }));
  first.layers.f.samples = new Uint16Array([1000, 2000]);
  const second = await decode(await encode(first));
  assert.deepEqual([...second.layers.f.samples], [1000, 2000]);
});
await test('sparse graded terrain preserves signed-zero Float32 bits', async () => {
  const doc = world(); doc.layers.terrain.h[5] = -0;
  const before = new Uint32Array(doc.layers.terrain.h.buffer).slice();
  const after = (await decodeWorld(await encodeWorld(doc))).layers.terrain.h;
  assert.deepEqual(new Uint32Array(after.buffer, after.byteOffset, after.length), before);
});
await test('Float64 terrain from an old declared schema is not narrowed silently', async () => {
  const doc = world(), n = doc.layers.terrain.base.length;
  doc.layers.terrain.base = new Float64Array(n); doc.layers.terrain.h = new Float64Array(n); doc.layers.terrain.h[7] = 1 / 3;
  doc.schema.hints['terrain.base'] = 'f64[]!'; doc.schema.hints['terrain.h'] = 'f64[]!';
  const after = (await decodeWorld(await encodeWorld(doc))).layers.terrain;
  assert.equal(after.h[7], 1 / 3);
});
await test('sparse terrain rejects unsorted, repeated and out-of-range overrides', async () => {
  for (const indices of [[4, 3], [3, 3], [9999]]) {
    const doc = world(), T = doc.layers.terrain; delete T.h;
    Object.assign(T, { heightEncoding: 'sparse-grade-v1', gradeIndex: Uint32Array.from(indices), gradeHeight: Float32Array.from(indices, () => 1) });
    await assert.rejects(decodeWorld(await encode(doc)), /sparse/);
  }
});
await test('legacy local-transform migration preserves points and matrix inverse', async () => {
  const rec = { vendorExtension: { keep: 7 }, parts: [{ p: [[1000.25, -4], [1020.25, -4], [1020.25, 6]], holes: [[[1004, -2], [1005, -2], [1005, -1]]], z: 14, h: 30, m: 'concrete' }] };
  const before = structuredClone(rec); ensureLocalBuilding(rec);
  before.parts[0].p.forEach((p, i) => assert.deepEqual(localToWorld(rec, [...rec.parts[0].p[i], rec.parts[0].z]), [...p, before.parts[0].z]));
  rec.transform = { p: [14, -29, 8], r: [0.3, -0.4, 0.7], s: [2, 0.4, 1.3] };
  const p = [3, 5, -9], q = worldToLocal(rec, localToWorld(rec, p));
  q.forEach((v, i) => assert.ok(Math.abs(v - p[i]) < 1e-10));
  assert.deepEqual(rec.vendorExtension, before.vendorExtension);
});
await test('validated multi-part buildings do not overflow argument limits when finding a center', () => {
  const ring = Array.from({ length: 50000 }, (_, i) => [Math.cos(i * Math.PI / 25000) * 100, Math.sin(i * Math.PI / 25000) * 100]);
  const rec = { parts: Array.from({ length: 3 }, (_, i) => ({ p: ring.map((p) => [...p]), z: i * 3, h: 3, m: 'concrete' })) };
  validateRecord('building', rec);
  const center = buildingCenter(rec); assert.ok(center.every(Number.isFinite));
});
await test('document validation rejects negative graph IDs consistently with command validation', () => {
  const doc = world(); doc.layers.roads.nodes = [{ id: -1, p: [0, 0, 0] }];
  assert.throws(() => validateWorld(doc), /id|node/);
});
await test('invalid individual commands and failed batches restore values, history and dirty state', async () => withSession(async (s) => {
  const clean = structuredClone(s.doc.layers), history = s.history.done.length;
  await assert.rejects(runScript(s, "world.create('tree', [0, 0, 1]); throw new Error('intentional rollback');"));
  assert.deepEqual(s.doc.layers, clean); assert.equal(s.history.done.length, history); assert.equal(s.dirty.size, 0);
}));
await test('terrain callback cannot leak out-of-box edits through failed transaction/undo', async () => withSession(async (s) => {
  const T = s.doc.layers.terrain, before = T.base.slice(); let rejected = false;
  try { s.terrain([0, 0, 0, 0], (base) => { base[0] = 8; base[1] = NaN; }, 'bad bounded brush'); } catch { rejected = true; }
  if (!rejected) s.undo();
  assert.deepEqual(T.base, before);
}));
await test('deleting an in-use road class either rejects atomically or keeps a valid graph', async () => withSession(async (s) => {
  const before = structuredClone(s.doc.layers), history = s.history.done.length; let rejected = false;
  try { s.setDef('roads.classes', 'street', null); } catch { rejected = true; }
  if (rejected) { assert.deepEqual(s.doc.layers, before); assert.equal(s.history.done.length, history); }
  else validateWorld(s.doc);
}, () => {
  const doc = world(); doc.layers.roads.nodes = [{ id: 1, p: [-8, 0, 0] }, { id: 2, p: [8, 0, 0] }];
  doc.layers.roads.edges = [{ id: 1, cls: 'street', n: [1, 2], pts: [[-8, 0, 0], [0, 0, 0], [8, 0, 0]], elev: [0, 0, 0], tunnel: [0, 0, 0] }]; return doc;
}));
await test('undo accepts a valid long rail without argument-spread failure', async () => withSession(async (s) => {
  const rail = Array.from({ length: 150000 }, (_, i) => [i, 0, 0]); s.insert('rail', rail);
  s.edit('rail', rail, (r) => { r[0][0] = -1; });
  try { s.undo(); } catch (e) { throw new Error(`${e.message}; valid rail has ${rail.length} points after failed undo`); }
  assert.equal(rail.length, 150000); assert.equal(rail[0][0], 0);
}));

await test('edits made during asynchronous save remain dirty if absent from saved bytes', async () => withSession(async (s, name) => {
  const saving = s.save();
  s.terrain([0, 0, 0, 0], (base) => { base[0] = 7; }, 'edit while save is compressing');
  await saving;
  const persisted = await decodeWorld(fs.readFileSync(name));
  const saved = persisted.layers.terrain.base[0] === s.doc.layers.terrain.base[0];
  assert.ok(saved || s.dirty.has('terrain'), `document base[0]=${s.doc.layers.terrain.base[0]}, saved=${persisted.layers.terrain.base[0]}, dirty=${[...s.dirty]}`);
}));
await test('overlapping initial loads cannot replace an edit after the first load completes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'city-format-ready-'));
  try {
    const name = path.join(dir, 'scratch.vspb'); fs.writeFileSync(name, await encodeWorld(world()));
    const s = new FileSession(name), first = s.ready(), second = s.ready();
    await first; s.insert('tree', [0, 0, 1]); await second;
    assert.equal(s.doc.layers.buildings.trees.length, 1, "second ready() replaced the first request\'s inserted tree");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`${checks - failures}/${checks} robustness checks passed`);
if (failures) process.exitCode = 1;
