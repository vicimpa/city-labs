// Fetch the official portable Node distribution, verify its SHA-256, and bundle just node + licence.
// Copying Homebrew's process.execPath would silently depend on Homebrew dylibs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
export async function prepareNode(triple) {
  const { version, source } = JSON.parse(fs.readFileSync(path.join(root, 'desktop/node-runtime.json'), 'utf8'));
  const targets = {
    'aarch64-apple-darwin': 'darwin-arm64', 'x86_64-apple-darwin': 'darwin-x64',
    'x86_64-unknown-linux-gnu': 'linux-x64', 'aarch64-unknown-linux-gnu': 'linux-arm64',
    'x86_64-pc-windows-msvc': 'win-x64', 'aarch64-pc-windows-msvc': 'win-arm64',
  };
  const platform = targets[triple];
  if (!platform) throw new Error(`No bundled Node distribution configured for ${triple}`);
  const windows = platform.startsWith('win-');
  const destination = path.join(root, `src-tauri/binaries/city-labs-node-${triple}${windows ? '.exe' : ''}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.mkdirSync(path.join(root, 'src-tauri/resources'), { recursive: true });
  const base = `${source}${version}/`;
  const name = windows ? `${platform}/node.exe` : `node-${version}-${platform}.tar.gz`;
  const cache = path.join(root, 'build/node-runtime', version, platform);
  fs.mkdirSync(cache, { recursive: true });
  const download = async (url) => { const response = await fetch(url); if (!response.ok) throw new Error(`${response.status}: ${url}`); return Buffer.from(await response.arrayBuffer()); };
  const sumsPath = path.join(cache, 'SHASUMS256.txt');
  if (!fs.existsSync(sumsPath)) fs.writeFileSync(sumsPath, await download(base + 'SHASUMS256.txt'));
  const sums = fs.readFileSync(sumsPath, 'utf8');
  const expected = sums.split('\n').map((line) => line.trim().split(/\s+/)).find(([, file]) => file === name)?.[0];
  if (!expected) throw new Error(`No official checksum for ${name}`);
  const archive = path.join(cache, path.basename(name));
  if (!fs.existsSync(archive)) fs.writeFileSync(archive, await download(base + name));
  const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (actual !== expected) { fs.rmSync(archive); throw new Error(`Node checksum mismatch for ${name}`); }
  let binary = archive;
  if (!windows) {
    const folder = path.join(cache, `node-${version}-${platform}`);
    if (!fs.existsSync(path.join(folder, 'bin/node'))) execFileSync('tar', ['-xzf', archive, '-C', cache]);
    binary = path.join(folder, 'bin/node');
    fs.copyFileSync(path.join(folder, 'LICENSE'), path.join(root, 'src-tauri/resources/node-LICENSE.txt'));
  } else {
    const license = path.join(cache, 'LICENSE');
    if (!fs.existsSync(license)) fs.writeFileSync(license, await download(`https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`));
    fs.copyFileSync(license, path.join(root, 'src-tauri/resources/node-LICENSE.txt'));
  }
  fs.copyFileSync(binary, destination); fs.chmodSync(destination, 0o755);
  return { destination, version };
}
