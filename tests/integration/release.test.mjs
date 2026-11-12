// Desktop packaging, permissions and release metadata contract.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releaseNotes, verifyInstallers, writeChecksums } from '../../tools/release.mjs';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
assert.equal(pkg.scripts.postinstall, undefined);
assert.equal(config.plugins?.updater, undefined, 'No unconfigured or unsigned automatic update endpoint');
for (const deps of [pkg.dependencies, pkg.devDependencies]) for (const name of Object.keys(deps)) assert.ok(!/electron|asar/.test(name), `Retired runtime dependency ${name}`);
assert.deepEqual(config.app.security.capabilities, ['main']);
const capability = JSON.parse(fs.readFileSync('src-tauri/capabilities/main.json', 'utf8'));
assert.deepEqual(capability.windows, ['main']);
assert.equal(capability.remote, undefined);
assert.ok(!capability.permissions.some((p) => typeof p === 'string' && /^(fs|shell):/.test(p)), 'Renderer cannot read arbitrary files or spawn processes');
assert.ok(config.bundle.externalBin.includes('binaries/city-labs-node'));
console.log('OK full-installer update contract, selected-window capability and bundled Node configuration');
console.log('No automatic updater is enabled; downloaded executable bundles are not loaded.');

const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
const cargoLock = fs.readFileSync('src-tauri/Cargo.lock', 'utf8');
const npmLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
assert.equal(cargo.match(/\[package\][\s\S]*?\nversion = "([^"]+)"/)[1], pkg.version, 'Cargo and npm versions agree');
assert.equal(cargoLock.match(/name = "city-labs"\nversion = "([^"]+)"/)[1], pkg.version, 'Cargo lock version agrees');
assert.equal(npmLock.version, pkg.version);
assert.equal(npmLock.packages[''].version, pkg.version);
assert.equal(config.version, '../package.json');
assert(fs.readFileSync('CHANGELOG.md', 'utf8').includes('## [' + pkg.version + ']'), 'Release has changelog notes');
console.log('OK synchronized npm/Cargo/Tauri release metadata');
assert(releaseNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), pkg.version).includes('### Added'));
assert.throws(() => releaseNotes('# Changelog', pkg.version), /No changelog/);
assert.throws(() => verifyInstallers(['mac.dmg']), /Both macOS/);
const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'city-labs-release-'));
try {
  const names = ['City Labs_arm64.dmg', 'City Labs_x64.dmg', 'City Labs_setup.exe', 'City Labs.AppImage'];
  for (const name of names) fs.writeFileSync(path.join(assets, name), name);
  const output = await writeChecksums(assets), sums = fs.readFileSync(output, 'utf8');
  assert.equal(sums.trim().split('\n').length, 4);
  for (const name of names) assert(sums.includes('  ' + name + '\n'));
  await writeChecksums(assets);
  assert.equal(fs.readFileSync(output, 'utf8'), sums, 'Checksum manifest excludes itself and is repeatable');
} finally { fs.rmSync(assets, { recursive: true, force: true }); }
console.log('OK changelog notes and complete installer checksum manifest');
