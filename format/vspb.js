// VSPB — Vespera binary world format. Spec: docs/VSPB.md.
// A file is a header + chunks; every layer is a set of self-describing columnar tables, so readers
// pick the columns they know by name, skip the rest, and writers keep unknown ones on re-save.
// Works in the browser and in Node (needs CompressionStream / Response).

export const MAGIC = 'VSPB';
export const VERSION = { major: 1, minor: 0 };

const CH_CRITICAL = 1;                // chunk flag: a reader that doesn't know the tag must refuse the file
const CODEC_NONE = 0, CODEC_DEFLATE = 1;
const COL_TYPED = 1, COL_PRESENCE = 2, COL_SHUFFLE = 4;
const MODE_ROWS = 0, MODE_MAP = 1, MODE_PROPS = 2;
export const KEY = '$key', PARENT = '$parent';

const BASES = ['', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32', 'f64', 'bool', 'str', 'json'];
const ARR = [null, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array,
  Uint8Array, Uint32Array, Uint32Array];
const B = Object.fromEntries(BASES.map((n, i) => [n, i]));
const isNum = (b) => b >= 1 && b <= 8;
const RANGE = [null, [0, 255], [-128, 127], [0, 65535], [-32768, 32767], [0, 4294967295], [-2147483648, 2147483647]];

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('vspb: big-endian hosts are not supported');

// ---------------------------------------------------------------- type specs: 'f32x3[]', 'u32[]!', 'str', 'json'
export function parseSpec(s) {
  const m = /^([a-z0-9]+?)(?:x(\d+))?((?:\[\])*)(!?)$/.exec(s);
  if (!m || !B[m[1]]) throw new Error('vspb: bad type ' + s);
  return { base: B[m[1]], arity: +(m[2] ?? 1), depth: m[3].length / 2, typed: !!m[4] };
}
export const specString = (c) => BASES[c.base] + (c.arity > 1 ? 'x' + c.arity : '') + '[]'.repeat(c.depth) + (c.typed ? '!' : '');

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);
const isList = (v) => Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView));

// guess a column type from sample values (used for fields no hint or earlier file describes)
export function inferSpec(vals) {
  let depth = 0, leaves = vals.filter((v) => v !== undefined && v !== null);
  if (!leaves.length) return 'json';
  const typed = leaves.find((v) => ArrayBuffer.isView(v));
  if (typed) {
    const base = { Uint8Array: 'u8', Int8Array: 'i8', Uint16Array: 'u16', Int16Array: 'i16', Uint32Array: 'u32',
      Int32Array: 'i32', Float32Array: 'f32', Float64Array: 'f64' }[typed.constructor.name];
    if (base && leaves.every((v) => v instanceof typed.constructor)) return base + '[]!';
    return 'json';
  }
  while (leaves.every(isList)) {
    const next = [];
    for (const v of leaves) for (const x of v) next.push(x);
    if (!next.length) return depth ? 'json' : 'f64[]';
    depth++; leaves = next;
  }
  let base;
  if (leaves.every((v) => typeof v === 'number')) {
    const int = leaves.every(Number.isInteger);
    base = !int ? 'f64' : leaves.every((v) => v >= -2147483648 && v <= 2147483647) ? 'i32' : 'f64';
  } else if (leaves.every((v) => typeof v === 'boolean')) base = 'bool';
  else if (leaves.every((v) => typeof v === 'string')) base = 'str';
  else return 'json';
  // innermost numeric arrays of one short length are vectors, not lists
  let arity = 1;
  if (depth && isNum(B[base])) {
    const inner = []; collectAt(vals, depth - 1, inner);
    const n = inner[0]?.length;
    if (n >= 2 && n <= 4 && inner.every((a) => a.length === n)) { arity = n; depth--; }
  }
  return base + (arity > 1 ? 'x' + arity : '') + '[]'.repeat(depth);
}
// do the values still match a column type (an edit may have turned a vec3 into 4 numbers, a number into text)?
export function fits(c, vals) {
  const leafOk = (v) => {
    if (c.base === B.json) return true;
    if (c.arity > 1) return isList(v) && v.length === c.arity && Array.prototype.every.call(v, (x) => typeof x === 'number');
    if (c.base === B.str) return typeof v === 'string';
    if (c.base === B.bool) return typeof v === 'boolean';
    if (typeof v !== 'number') return false;
    if (c.base >= B.f32) return true;
    const [lo, hi] = RANGE[c.base];
    return Number.isInteger(v) && v >= lo && v <= hi;
  };
  const ok = (v, d) => {
    if (v === undefined) return d === c.depth;          // absent rows only at the top
    if (d === 0) return leafOk(v);
    if (!isList(v)) return false;
    if (d === 1 && c.arity === 1 && isNum(c.base) && ArrayBuffer.isView(v)) return true;
    for (const x of v) if (x === undefined || !ok(x, d - 1)) return false;
    return true;
  };
  return vals.every((v) => ok(v, c.depth));
}
function collectAt(vals, d, out) {
  for (const v of vals) if (v != null) { if (d === 0) out.push(v); else collectAt(v, d - 1, out); }
}

// ---------------------------------------------------------------- byte writer / reader
class Writer {
  constructor(n = 1 << 16) { this.buf = new Uint8Array(n); this.dv = new DataView(this.buf.buffer); this.n = 0; }
  need(k) {
    if (this.n + k <= this.buf.length) return;
    let cap = this.buf.length * 2; while (cap < this.n + k) cap *= 2;
    const b = new Uint8Array(cap); b.set(this.buf.subarray(0, this.n)); this.buf = b; this.dv = new DataView(b.buffer);
  }
  align(a) { const p = (a - (this.n % a)) % a; this.need(p); this.buf.fill(0, this.n, this.n + p); this.n += p; }
  u8(v) { this.need(1); this.buf[this.n++] = v; }
  u16(v) { this.need(2); this.dv.setUint16(this.n, v, true); this.n += 2; }
  u32(v) { this.need(4); this.dv.setUint32(this.n, v, true); this.n += 4; }
  bytes(u8) { this.need(u8.length); this.buf.set(u8, this.n); this.n += u8.length; }
  str(s) { const b = TE.encode(s); this.u32(b.length); this.bytes(b); }
  out() { return this.buf.slice(0, this.n); }
}
class Reader {
  constructor(u8) { this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.n = 0; }
  align(a) { this.n += (a - (this.n % a)) % a; }          // relative to the payload start, like Writer
  u8_() { return this.u8[this.n++]; }
  u16() { const v = this.dv.getUint16(this.n, true); this.n += 2; return v; }
  u32() { const v = this.dv.getUint32(this.n, true); this.n += 4; return v; }
  str() { const k = this.u32(), s = TD.decode(this.u8.subarray(this.n, this.n + k)); this.n += k; return s; }
  // typed view if aligned, copy otherwise
  arr(Ctor, count) {
    const bytes = count * Ctor.BYTES_PER_ELEMENT, off = this.u8.byteOffset + this.n;
    const a = off % Ctor.BYTES_PER_ELEMENT === 0 ? new Ctor(this.u8.buffer, off, count)
      : new Ctor(this.u8.slice(this.n, this.n + bytes).buffer);
    this.n += bytes; return a;
  }
}
const TE = new TextEncoder(), TD = new TextDecoder();

// byte-plane shuffle: floats compress far better when their exponent bytes sit together
function shuffle(u8, size) {
  const n = u8.length / size, out = new Uint8Array(u8.length);
  for (let b = 0; b < size; b++) for (let i = 0; i < n; i++) out[b * n + i] = u8[i * size + b];
  return out;
}
function unshuffle(u8, size) {
  const n = u8.length / size, out = new Uint8Array(u8.length);
  for (let b = 0; b < size; b++) for (let i = 0; i < n; i++) out[i * size + b] = u8[b * n + i];
  return out;
}

// ---------------------------------------------------------------- compression
async function pipe(u8, stream) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer()); }
const deflate = (u8) => pipe(u8, new CompressionStream('deflate-raw'));
const inflate = (u8) => pipe(u8, new DecompressionStream('deflate-raw'));

// ---------------------------------------------------------------- column encode
function writeColumn(w, name, spec, vals) {
  const c = parseSpec(spec), rows = vals.length;
  const present = vals.map((v) => v !== undefined);
  const sparse = present.some((p) => !p);
  let flags = (c.typed ? COL_TYPED : 0) | (sparse ? COL_PRESENCE : 0);
  // flatten the list levels; the last level of a plain numeric list is copied run by run
  const runsOnly = c.depth > 0 && c.arity === 1 && isNum(c.base);
  let cur = vals, runs = null;
  const offsets = [];
  for (let d = 0; d < c.depth; d++) {
    const off = new Uint32Array(cur.length + 1), next = [];
    const last = runsOnly && d === c.depth - 1;
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i] ?? [];
      off[i + 1] = off[i] + a.length;
      if (last) next.push(a); else for (let k = 0; k < a.length; k++) next.push(a[k]);
    }
    offsets.push(off);
    if (last) runs = next; else cur = next;
  }
  let values, dict = null;
  const Ctor = ARR[c.base];
  if (runs) {
    const off = offsets[offsets.length - 1];
    values = new Ctor(off[off.length - 1]);
    let k = 0;
    for (const r of runs) { if (ArrayBuffer.isView(r)) values.set(r, k); else for (let i = 0; i < r.length; i++) values[k + i] = r[i]; k += r.length; }
  } else if (c.base === B.str || c.base === B.json) {
    const map = new Map(); dict = [];
    values = new Uint32Array(cur.length * c.arity);
    cur.forEach((v, i) => {
      const s = c.base === B.json ? JSON.stringify(v ?? null) : String(v ?? '');
      let j = map.get(s); if (j === undefined) { map.set(s, j = dict.length); dict.push(s); }
      values[i] = j;
    });
  } else {
    values = new Ctor(cur.length * c.arity);
    if (c.arity === 1) cur.forEach((v, i) => { values[i] = c.base === B.bool ? (v ? 1 : 0) : (v ?? 0); });
    else cur.forEach((v, i) => { if (v) for (let a = 0; a < c.arity; a++) values[i * c.arity + a] = v[a] ?? 0; });
  }
  let vbytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  if (Ctor.BYTES_PER_ELEMENT > 1 && values.length >= 256) { vbytes = shuffle(vbytes, Ctor.BYTES_PER_ELEMENT); flags |= COL_SHUFFLE; }

  w.str(name); w.u8(c.base); w.u8(c.arity); w.u8(c.depth); w.u8(flags);
  if (sparse) {
    const bits = new Uint8Array((rows + 7) >> 3);
    present.forEach((p, i) => { if (p) bits[i >> 3] |= 1 << (i & 7); });
    w.bytes(bits);
  }
  for (const off of offsets) { w.align(4); w.bytes(new Uint8Array(off.buffer)); }
  if (dict) { w.u32(dict.length); for (const s of dict) w.str(s); }
  w.u32(values.length);
  w.align(8); w.bytes(vbytes);
}

// ---------------------------------------------------------------- column decode
function readColumn(r, rows) {
  const name = r.str(), base = r.u8_(), arity = r.u8_(), depth = r.u8_(), flags = r.u8_();
  if (!ARR[base]) throw new Error(`vspb: column ${name} has unknown type ${base}`);
  let present = null;
  if (flags & COL_PRESENCE) { present = r.u8.slice(r.n, r.n + ((rows + 7) >> 3)); r.n += (rows + 7) >> 3; }
  const offsets = [];
  let n = rows;
  for (let d = 0; d < depth; d++) { r.align(4); const off = r.arr(Uint32Array, n + 1); offsets.push(off); n = off[n]; }
  let dict = null;
  if (base === B.str || base === B.json) {
    dict = Array.from({ length: r.u32() }, () => r.str());
    if (base === B.json) dict = dict.map((s) => JSON.parse(s));
  }
  const count = r.u32(), Ctor = ARR[base];
  r.align(8);
  let values;
  if (flags & COL_SHUFFLE) {
    const k = count * Ctor.BYTES_PER_ELEMENT;
    values = new Ctor(unshuffle(r.u8.subarray(r.n, r.n + k), Ctor.BYTES_PER_ELEMENT).buffer); r.n += k;
  } else values = r.arr(Ctor, count);
  const spec = { base, arity, depth, typed: !!(flags & COL_TYPED) };
  const f32 = base === B.f32;
  const num = (k) => (f32 ? +values[k].toPrecision(7) : values[k]);
  const leaf = (i) => {
    if (dict) return dict[values[i]];
    if (arity === 1) return base === B.bool ? values[i] !== 0 : num(i);
    const v = new Array(arity); for (let a = 0; a < arity; a++) v[a] = num(i * arity + a); return v;
  };
  const at = (lvl, i) => {
    if (lvl === depth) return leaf(i);
    const a = offsets[lvl][i], b = offsets[lvl][i + 1];
    if (lvl === depth - 1 && spec.typed && arity === 1 && isNum(base)) return values.subarray(a, b);
    const out = new Array(b - a); for (let k = a; k < b; k++) out[k - a] = at(lvl + 1, k); return out;
  };
  const get = (i) => (present && !(present[i >> 3] & (1 << (i & 7))) ? undefined : at(0, i));
  return { name, spec: specString(spec), get };
}

// ---------------------------------------------------------------- tables <-> layer objects
// A layer object is split into tables: `<layer>` (one row of plain props), `<layer>.<coll>` for every
// array of records, `<layer>.<map>` for every object of records (key column `$key`), and nested
// `<table>.<field>` child tables for record fields that hold arrays of records (column `$parent`).
function splitLayer(name, layer, kinds) {
  const tables = [], props = {};
  const emit = (tname, mode, rows, parent) => {
    const t = { name: tname, mode, parent: parent ?? '', rows: [] };
    tables.push(t);
    // child-table fields of these rows
    const childFields = new Set();
    for (const row of rows) for (const [k, v] of Object.entries(row.rec))
      if (kinds[tname + '.' + k] === 'rows' || (Array.isArray(v) && v.length && v.every(isRecord) && kinds[tname + '.' + k] !== 'value')) childFields.add(k);
    const childRows = Object.fromEntries([...childFields].map((k) => [k, []]));
    rows.forEach((row, i) => {
      const flat = {};
      if (row.key !== undefined) flat[KEY] = row.key;
      if (row.parent !== undefined) flat[PARENT] = row.parent;
      for (const [k, v] of Object.entries(row.rec)) {
        if (childFields.has(k)) { for (const c of v ?? []) childRows[k].push({ rec: c, parent: i }); } else flat[k] = v;
      }
      t.rows.push(flat);
    });
    for (const k of childFields) emit(tname + '.' + k, MODE_ROWS, childRows[k], tname);
  };
  const deferred = [];
  for (const [k, v] of Object.entries(layer)) {
    const tn = name + '.' + k, kind = kinds[tn];
    if (kind === 'rows' || (kind !== 'value' && Array.isArray(v) && v.length && v.every(isRecord)))
      deferred.push(() => emit(tn, MODE_ROWS, v.map((rec) => ({ rec }))));
    else if (kind === 'map' || (kind !== 'value' && isRecord(v) && Object.keys(v).length && Object.values(v).every(isRecord)))
      deferred.push(() => emit(tn, MODE_MAP, Object.entries(v).map(([key, rec]) => ({ key, rec }))));
    else props[k] = v;
  }
  tables.push({ name, mode: MODE_PROPS, parent: '', rows: [props] });
  for (const f of deferred) f();
  return tables;
}

function encodeTable(t, hints) {
  const w = new Writer();
  w.str(t.name); w.str(t.parent); w.u8(t.mode); w.u32(t.rows.length);
  const cols = [];
  for (const row of t.rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  w.u16(cols.length);
  for (const k of cols) {
    const vals = t.rows.map((r) => r[k]);
    const hint = hints[t.name + '.' + k];
    const spec = k === KEY ? 'str' : k === PARENT ? 'u32' : hint && fits(parseSpec(hint), vals) ? hint : inferSpec(vals);
    writeColumn(w, k, spec, vals);
  }
  return w.out();
}

function decodeTable(u8) {
  const r = new Reader(u8);
  const name = r.str(), parent = r.str(), mode = r.u8_(), rows = r.u32(), ncols = r.u16();
  const cols = [];
  for (let c = 0; c < ncols; c++) cols.push(readColumn(r, rows));
  const out = new Array(rows);
  for (let i = 0; i < rows; i++) {
    const rec = {};
    for (const c of cols) { const v = c.get(i); if (v !== undefined) rec[c.name] = v; }
    out[i] = rec;
  }
  return { name, parent, mode, rows: out, specs: Object.fromEntries(cols.map((c) => [c.name, c.spec])) };
}

// ---------------------------------------------------------------- chunks
async function chunk(tag, payload, { critical = false, compress = true } = {}) {
  let codec = CODEC_NONE, data = payload;
  if (compress && payload.length > 256) { const z = await deflate(payload); if (z.length < payload.length) { data = z; codec = CODEC_DEFLATE; } }
  const w = new Writer(16 + data.length + 8);
  w.bytes(TE.encode(tag.padEnd(4).slice(0, 4)));
  w.u32((critical ? CH_CRITICAL : 0) | (codec << 8));
  w.u32(payload.length); w.u32(data.length);
  w.bytes(data); w.align(8);
  return w.out();
}

/** Encode one layer to a run of TABL chunks. `hints` maps 'table.column' -> type spec;
 *  `kinds` maps 'table.field' -> 'rows' | 'map' | 'value' to settle ambiguous (empty) collections. */
export async function encodeLayer(name, layer, { hints = {}, kinds = {} } = {}) {
  const tables = splitLayer(name, layer, kinds);
  const parts = await Promise.all(tables.map((t) => chunk('TABL', encodeTable(t, hints))));
  return concat(parts);
}

/** Assemble a file from pre-encoded layer chunks (see encodeLayer) plus chunks kept from a read (decode().unknown). */
export async function assemble(meta, layerChunks, unknown = []) {
  const head = new Writer(16);
  head.bytes(TE.encode(MAGIC)); head.u16(VERSION.major); head.u16(VERSION.minor); head.u32(0); head.u32(0);
  const m = await chunk('META', TE.encode(JSON.stringify({ ...meta, layers: Object.keys(layerChunks) })));
  const kept = unknown.map((u) => {
    const w = new Writer(16 + u.body.length + 8);
    w.bytes(TE.encode(u.tag)); w.u32(u.flags); w.u32(u.raw); w.u32(u.body.length); w.bytes(u.body); w.align(8);
    return w.out();
  });
  return concat([head.out(), m, ...Object.values(layerChunks), ...kept, await chunk('END ', new Uint8Array(0))]);
}

/** Encode a whole document { meta, layers: {name: layer} }. */
export async function encode(doc, opts = {}) {
  const chunks = {};
  for (const [name, layer] of Object.entries(doc.layers)) chunks[name] = await encodeLayer(name, layer, optsFor(doc, opts));
  return assemble(doc.meta ?? {}, chunks, doc.unknown);
}
export function optsFor(doc, { hints = {}, kinds = {} } = {}) {
  // types read from the file win over defaults, so a re-save never changes a column's type
  return { hints: { ...hints, ...doc.schema?.hints }, kinds: { ...kinds, ...doc.schema?.kinds } };
}

/** Decode a file. Returns { meta, layers, schema, version, unknown } — `schema` records every column's
 *  type and every table's kind so encode() can write the document back losslessly. */
export async function decode(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (TD.decode(u8.subarray(0, 4)) !== MAGIC) throw new Error('vspb: not a VSPB file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = { major: dv.getUint16(4, true), minor: dv.getUint16(6, true) };
  if (version.major > VERSION.major) throw new Error(`vspb: file version ${version.major}.${version.minor} is newer than this reader (${VERSION.major}.x)`);
  let p = 16, meta = {};
  const tasks = [], unknown = [];
  while (p + 16 <= u8.length) {
    const tag = TD.decode(u8.subarray(p, p + 4)), flags = dv.getUint32(p + 4, true);
    const raw = dv.getUint32(p + 8, true), stored = dv.getUint32(p + 12, true);
    const body = u8.subarray(p + 16, p + 16 + stored);
    p += 16 + stored; p += (8 - (p % 8)) % 8;
    if (tag === 'END ') break;
    const codec = (flags >> 8) & 0xff;
    const data = codec === CODEC_DEFLATE ? inflate(body) : codec === CODEC_NONE ? Promise.resolve(body) : null;
    if (!data) throw new Error(`vspb: chunk ${tag} uses unknown codec ${codec}`);
    if (tag === 'META') tasks.push(data.then((d) => { meta = JSON.parse(TD.decode(d)); }));
    else if (tag === 'TABL') tasks.push(data.then((d) => { if (d.length !== raw) throw new Error('vspb: corrupt chunk'); return decodeTable(d); }));
    else if (flags & CH_CRITICAL) throw new Error(`vspb: unsupported critical chunk ${tag}`);
    else unknown.push({ tag, flags, raw, body: body.slice() });   // ancillary: not understood, written back as is
  }
  const tables = (await Promise.all(tasks)).filter(Boolean);
  const layers = {}, byName = {}, hints = {}, kinds = {};
  for (const t of tables) {
    byName[t.name] = t;
    for (const [c, s] of Object.entries(t.specs)) if (c !== KEY && c !== PARENT) hints[t.name + '.' + c] = s;
    const dot = t.name.lastIndexOf('.'), field = t.name.slice(dot + 1);
    if (t.mode === MODE_PROPS) { layers[t.name] = Object.assign(layers[t.name] ?? {}, t.rows[0]); continue; }
    kinds[t.name] = t.mode === MODE_MAP ? 'map' : 'rows';
    if (t.parent) {
      const P = byName[t.parent];
      if (!P) throw new Error(`vspb: table ${t.name} before its parent`);
      for (const row of P.rows) row[field] ??= [];
      for (const row of t.rows) { const i = row[PARENT]; delete row[PARENT]; P.rows[i][field].push(row); }
    } else {
      const L = (layers[t.name.slice(0, dot)] ??= {});
      if (t.mode === MODE_MAP) L[field] = Object.fromEntries(t.rows.map((row) => { const k = row[KEY]; delete row[KEY]; return [k, row]; }));
      else L[field] = t.rows;
    }
  }
  return { meta, layers, version, unknown, schema: { hints, kinds } };
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let k = 0; for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}
