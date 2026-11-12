// Unpack the runtime world, including expanded graded terrain and local transforms.
//   node tools/vspb2json.mjs [in.vspb] [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeWorld } from '../format/world.js';

function layerFilename(name) {
  // Layer names are data, not filesystem paths; preserve unusual names safely.
  let safe = encodeURIComponent(name);
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safe)) safe = '_' + safe;
  if (safe.length > 180) safe = safe.slice(0, 120) + '-' + createHash('sha256').update(name).digest('hex').slice(0, 24);
  return safe + '.json';
}
export async function unpackWorld(src, dir) {
  const doc = await decodeWorld(fs.readFileSync(src));
  fs.mkdirSync(dir, { recursive: true });
  const plain = (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v), files = [], used = new Set();
  for (const [name, layer] of Object.entries(doc.layers)) {
    let filename = layerFilename(name);
    if (used.has(filename.toLowerCase())) filename = filename.slice(0, -5) + '-' + createHash('sha256').update(name).digest('hex').slice(0, 24) + '.json';
    used.add(filename.toLowerCase());
    const file = path.join(dir, filename);
    fs.writeFileSync(file, JSON.stringify(layer, plain));
    files.push({ name, file, bytes: fs.statSync(file).size });
  }
  return { doc, files };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const src = process.argv[2] ?? 'city/data/vespera.vspb', dir = process.argv[3] ?? 'city/data/unpacked';
  const { doc, files } = await unpackWorld(src, dir);
  for (const { file, bytes } of files) console.log(`${file} ${(bytes / 1e6).toFixed(1)} MB`);
  console.log('format', `${doc.version.major}.${doc.version.minor}`, doc.meta);
}
