// Build City Labs for packaging:
//   build/app/            what electron-builder packs (directories.app)
//     package.json        shell manifest: main = boot/boot.cjs, cityLabs.shell
//     boot/               the shell: splash + updater + bundle loader (app/boot)
//     bundle/             the code bundle: main.cjs (main process, deps inlined), preload.cjs,
//                         web/ (built editor), sample/vespera.vspb, package.json
//   release/app-<version>.asar   the same bundle, for hot updates (--asar)
//   node tools/build-app.mjs [--asar]
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { createPackage } from '@electron/asar';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, 'build/app'), bundle = path.join(out, 'bundle');
const t0 = Date.now();
fs.rmSync(out, { recursive: true, force: true });

// the editor page and its modules (three.js and the world builder) as static files
await build({ configFile: false, root, base: '/', logLevel: 'warn',
  build: { outDir: path.join(bundle, 'web'), emptyOutDir: true, chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { editor: path.join(root, 'editor/index.html') } } } });

// the main process with its npm dependencies inlined: the packaged app ships no node_modules
await build({ configFile: false, root, logLevel: 'warn',
  ssr: { noExternal: true, target: 'node' },
  build: { ssr: path.join(root, 'app/main.mjs'), outDir: bundle, emptyOutDir: false, target: 'node22', minify: false,
    rollupOptions: { external: ['electron', 'vite', /^node:/, 'original-fs'],
      output: { format: 'cjs', entryFileNames: 'main.cjs', codeSplitting: false } } } });

fs.copyFileSync(path.join(root, 'app/preload.cjs'), path.join(bundle, 'preload.cjs'));
fs.mkdirSync(path.join(bundle, 'sample'), { recursive: true });
fs.copyFileSync(path.join(root, 'city/data/vespera.vspb'), path.join(bundle, 'sample/vespera.vspb'));
fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: 'city-labs-bundle', version: pkg.version, cityLabs: pkg.cityLabs }, null, 2));

fs.cpSync(path.join(root, 'app/boot'), path.join(out, 'boot'), { recursive: true });
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({
  name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, author: pkg.author,
  homepage: `https://github.com/${pkg.cityLabs.repo}`, main: 'boot/boot.cjs', cityLabs: pkg.cityLabs,
}, null, 2));

if (process.argv.includes('--asar')) {
  fs.mkdirSync(path.join(root, 'release'), { recursive: true });
  const f = path.join(root, 'release', `app-${pkg.version}.asar`);
  await createPackage(bundle, f);
  console.log(`${path.relative(root, f)} ${(fs.statSync(f).size / 1e6).toFixed(1)} MB`);
}
const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`build/app ${(size(out) / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s (version ${pkg.version}, shell ${pkg.cityLabs.shell})`);
