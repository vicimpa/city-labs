// Unpack a VSPB world into one JSON file per layer, for diffing or reading.
//   node tools/vspb2json.mjs [in.vspb] [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { decode } from '../format/vspb.js';

const src = process.argv[2] ?? 'city/data/vespera.vspb';
const dir = process.argv[3] ?? 'city/data/unpacked';
const doc = await decode(fs.readFileSync(src));
fs.mkdirSync(dir, { recursive: true });
const plain = (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v);
for (const [name, layer] of Object.entries(doc.layers)) {
  const f = path.join(dir, name + '.json');
  fs.writeFileSync(f, JSON.stringify(layer, plain));
  console.log(`${f} ${(fs.statSync(f).size / 1e6).toFixed(1)} MB`);
}
console.log('format', `${doc.version.major}.${doc.version.minor}`, doc.meta);
