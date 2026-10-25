// Write manifest.json for a release folder: what the shell's updater reads from the latest release.
//   { version, shell, tag, asar: { file, sha256, size }, installers: { "<platform>-<arch>": file } }
//   node tools/release-manifest.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = process.argv[2] ?? 'release';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const files = fs.readdirSync(dir);
const asar = files.find((f) => f === `app-${pkg.version}.asar`);
if (!asar) throw new Error(`no app-${pkg.version}.asar in ${dir}`);
const buf = fs.readFileSync(path.join(dir, asar));
const installers = {};
for (const f of files) {
  const m = /^City-Labs-[\d.]+-(mac|win|linux)-(arm64|x64|x86_64|amd64)\.(dmg|exe|AppImage)$/.exec(f);
  if (!m) continue;
  const platform = { mac: 'darwin', win: 'win32', linux: 'linux' }[m[1]], arch = m[2] === 'arm64' ? 'arm64' : 'x64';
  installers[`${platform}-${arch}`] = f;
}
const manifest = { version: pkg.version, shell: pkg.cityLabs.shell, tag: `v${pkg.version}`,
  asar: { file: asar, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length }, installers };
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
