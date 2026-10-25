// Round-trip check of the real world file: decode -> encode -> decode gives the same document
// (every layer, every value, typed columns stay typed).  node test/vspb.roundtrip.mjs [file.vspb]
import fs from 'node:fs';
import { decode, encode } from '../format/vspb.js';

const file = process.argv[2] ?? 'city/data/vespera.vspb';
const t0 = Date.now();
const doc = await decode(fs.readFileSync(file));
console.log('decode', Date.now() - t0, 'ms');
let bad = 0;
function cmp(a, b, path) {
  if (bad > 20) return;
  if (ArrayBuffer.isView(a)) {
    if (!ArrayBuffer.isView(b) || a.constructor !== b.constructor || a.length !== b.length) { bad++; console.log('typed', path); return; }
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) { bad++; console.log('typed value', path, i); return; }
    return;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) { bad++; console.log('arr', path, a.length, b?.length); return; }
    for (let i = 0; i < a.length; i++) cmp(a[i], b[i], path + '[' + i + ']');
    return;
  }
  if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object') { bad++; console.log('obj', path); return; }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) cmp(a[k], b[k], path + '.' + k);
    return;
  }
  if (a !== b) { bad++; console.log('val', path, a, b); }
}
const again = await decode(await encode(doc));
cmp(doc.layers, again.layers, 'layers');
console.log(bad ? `FAIL ${bad}` : 'OK', Object.keys(doc.layers).map((k) => k).join(', '), `v${doc.version.major}.${doc.version.minor}`);
process.exit(bad ? 1 : 0);
