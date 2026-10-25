// Compatibility rules of the VSPB format (docs/VSPB.md): node test/vspb.compat.mjs
import assert from 'node:assert/strict';
import { decode, encode, encodeLayer, assemble, VERSION } from '../format/vspb.js';

const ok = (name) => console.log('OK  ', name);
const roundtrip = async (doc, opts) => decode(await encode(doc, opts));

// 1. unknown fields / tables / layers survive decode -> encode untouched
{
  const doc = { meta: {}, layers: { buildings: { items: [
    { type: 'tower', zone: 'downtown', parts: [{ p: [[0, 0], [10, 0], [10, 10]], z: 0, h: 30, m: 'glass_blue', future_lod: 2 }], owner: { id: 7 } },
    { type: 'brand_new_type', zone: 'moon', parts: [] },
  ] }, weather: { rain: 0.3, zones: [{ name: 'fog', p: [[1, 2]] }] } } };
  const a = await roundtrip(doc, { hints: { 'buildings.items.parts.p': 'f32x2[]' } });
  assert.deepEqual(a.layers.buildings.items[0].parts[0].future_lod, 2);
  assert.deepEqual(a.layers.buildings.items[0].owner, { id: 7 });
  assert.equal(a.layers.buildings.items[1].type, 'brand_new_type');
  assert.deepEqual(a.layers.buildings.items[1].parts, []);
  assert.deepEqual(a.layers.weather, doc.layers.weather);
  const b = await roundtrip(a);                       // re-save with the file's own schema
  assert.deepEqual(b.layers, a.layers);
  assert.equal(b.schema.hints['buildings.items.parts.p'], 'f32x2[]');
  ok('unknown fields, types, tables and layers are kept');
}

// 2. sparse fields stay absent (presence bitmap), not defaulted
{
  const a = await roundtrip({ layers: { s: { rows: [{ p: [[0, 0]], holes: [[[1, 1]]] }, { p: [[2, 2]] }] } } });
  assert.ok('holes' in a.layers.s.rows[0]);
  assert.ok(!('holes' in a.layers.s.rows[1]));
  ok('absent fields stay absent');
}

// 3. an edit that no longer fits the stored type re-infers instead of truncating
{
  const a = await roundtrip({ layers: { f: { items: [{ p: [1, 2, 3] }] } } }, { hints: { 'f.items.p': 'f32x3' } });
  a.layers.f.items[0].p = [1, 2, 3, 4];               // vec3 -> 4 numbers
  a.layers.f.items.push({ p: 'somewhere' });           // number list -> text
  const b = await roundtrip(a);
  assert.deepEqual(b.layers.f.items[0].p, [1, 2, 3, 4]);
  assert.equal(b.layers.f.items[1].p, 'somewhere');
  ok('type changes fall back to inference');
}

// 4. empty collections keep their kind
{
  const a = await roundtrip({ layers: { b: { items: [], map: {} } } }, { kinds: { 'b.items': 'rows', 'b.map': 'map' } });
  assert.deepEqual(a.layers.b.items, []);
  assert.deepEqual(a.layers.b.map, {});
  ok('empty collections');
}

// 5. typed columns come back as typed views; plain lists as arrays
{
  const a = await roundtrip({ layers: { t: { h: new Float32Array([1.5, 2.5]), ids: [1, 2, 3] } } }, { hints: { 't.h': 'f32[]!' } });
  assert.ok(a.layers.t.h instanceof Float32Array);
  assert.ok(Array.isArray(a.layers.t.ids));
  ok('typed vs plain lists');
}

// 6. chunks a reader doesn't know: ancillary are skipped, critical are refused
const withChunk = async (tag, flags) => {
  const file = await assemble({}, { a: await encodeLayer('a', { x: 1 }) });
  const end = file.length - 16;                       // before the END chunk
  const extra = new Uint8Array(24); extra.set(new TextEncoder().encode(tag));
  const dv = new DataView(extra.buffer); dv.setUint32(4, flags, true); dv.setUint32(8, 8, true); dv.setUint32(12, 8, true);
  const out = new Uint8Array(file.length + 24);
  out.set(file.subarray(0, end)); out.set(extra, end); out.set(file.subarray(end), end + 24);
  return out;
};
{
  const a = await decode(await withChunk('XTRA', 0));
  assert.equal(a.layers.a.x, 1);
  assert.equal(a.unknown[0].tag, 'XTRA');
  const again = await decode(await encode(a));        // and written back on re-save
  assert.equal(again.unknown[0].tag, 'XTRA');
  await assert.rejects(decode(await withChunk('MUST', 1)), /critical/);
  ok('unknown ancillary chunk skipped and kept, critical refused');
}

// 7. a newer major version is refused, a newer minor is read
{
  const file = await encode({ layers: { a: { x: 1 } } });
  const dv = new DataView(file.buffer);
  dv.setUint16(6, VERSION.minor + 5, true);
  assert.equal((await decode(file)).layers.a.x, 1);
  dv.setUint16(4, VERSION.major + 1, true);
  await assert.rejects(decode(file), /newer/);
  ok('minor versions read, newer major refused');
}
console.log('all compat checks passed');
