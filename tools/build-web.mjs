// Build the web editor (GitHub Pages): the editor page at the site root, the sample city next to it.
//   node tools/build-web.mjs [outDir = dist-web]
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(root, process.argv[2] ?? 'dist-web');
const t0 = Date.now();
// root = editor/, so index.html lands at the site root; relative URLs work under any sub-path
await build({ configFile: false, root: path.join(root, 'editor'), base: './', logLevel: 'warn', publicDir: false,
  build: { outDir: out, emptyOutDir: true, chunkSizeWarningLimit: 4000 } });
fs.mkdirSync(path.join(out, 'samples'), { recursive: true });
fs.copyFileSync(path.join(root, 'city/data/vespera.vspb'), path.join(out, 'samples/vespera.vspb'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`${path.relative(root, out)} ${(size(out) / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
