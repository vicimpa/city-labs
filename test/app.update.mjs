// The packaged app's updater against a local feed (needs `npm run dist` for this platform first):
// 1) a newer code bundle is downloaded and started; 2) a newer shell is offered on the splash and,
// after «Позже», in the editor; 3) a background check downloads a bundle and offers a restart.
//   node test/app.update.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { _electron as electron } from 'playwright';
import { createPackage } from '@electron/asar';

const root = path.resolve(import.meta.dirname, '..');
const exe = { darwin: `release/mac-${process.arch}/City Labs.app/Contents/MacOS/City Labs`, linux: 'release/linux-unpacked/city-labs', win32: 'release/win-unpacked/City Labs.exe' }[process.platform];
if (!fs.existsSync(path.join(root, exe))) { console.error(`no packaged app at ${exe}: run npm run dist first`); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'citylabs-upd-')), feed = path.join(tmp, 'feed');
fs.mkdirSync(feed);
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'OK   ' : 'FAIL ') + m); };

// a code bundle like the built one, with another version
async function bundle(version) {
  const dir = path.join(tmp, 'b-' + version);
  fs.cpSync(path.join(root, 'build/app/bundle'), dir, { recursive: true });
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...p, version }));
  const file = `app-${version}.asar`;
  await createPackage(dir, path.join(feed, file));
  const buf = fs.readFileSync(path.join(feed, file));
  return { file, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
}
const manifest = (m) => fs.writeFileSync(path.join(feed, 'manifest.json'), JSON.stringify({ tag: 'v' + m.version, installers: {}, ...m }));
const server = http.createServer((req, res) => {
  const f = path.join(feed, decodeURIComponent(new URL(req.url, 'http://x').pathname.replace('/feed/', '')));
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const buf = fs.readFileSync(f);
  res.writeHead(200, { 'content-length': buf.length }); res.end(buf);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const FEED = `http://127.0.0.1:${server.address().port}/feed/`;

async function launch(userData) {
  const env = { ...process.env, CITY_LABS_UPDATE_URL: FEED, VSPB_MCP_PORT: '7397' };
  delete env.ELECTRON_RUN_AS_NODE;
  const world = path.join(tmp, 'world.vspb');
  if (!fs.existsSync(world)) fs.copyFileSync(path.join(root, 'city/data/vespera.vspb'), world);
  const app = await electron.launch({ executablePath: path.join(root, exe), args: [`--user-data-dir=${userData}`, world], env });
  return app;
}
async function editorWindow(app) {
  for (let k = 0; k < 600; k++) {
    const w = app.windows().find((x) => x.url().includes('editor/index.html'));
    if (w) { await w.waitForFunction(() => document.getElementById('busy').hidden && window.editor?.doc, null, { timeout: 240000 }); return w; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('no editor window');
}

// 1) code update on start
const a1 = await bundle('0.1.1');
manifest({ version: '0.1.1', shell: 1, asar: a1 });
const ud = path.join(tmp, 'ud1');
let app = await launch(ud);
let win = await editorWindow(app);
const info = await win.evaluate(() => window.vspbHost.info());
ok(info.version === '0.1.1' && info.shell === 1, `newer bundle downloaded and started (${info.version}, shell ${info.shell})`);
ok(fs.existsSync(path.join(ud, 'updates/app-0.1.1.asar')), 'bundle stored in userData/updates');

// 3) background check: a newer bundle appears while running
const a2 = await bundle('0.1.2');
manifest({ version: '0.1.2', shell: 1, asar: a2 });
await win.evaluate(() => window.vspbHost.update('check'));
await win.waitForFunction(() => /0\.1\.2 — перезапустить/.test(document.getElementById('update').textContent), null, { timeout: 60000 })
  .then(() => ok(true, 'background check downloads 0.1.2 and offers a restart'), () => ok(false, 'background check downloads 0.1.2 and offers a restart'));
await app.close();

// 2) a new shell: offered on the splash, then in the editor after «Позже»
manifest({ version: '0.2.0', shell: 2, asar: a2, installers: {} });
app = await launch(ud);
let splash = null;
for (let k = 0; k < 100 && !splash; k++) { splash = app.windows().find((x) => x.url().endsWith('splash.html')); if (!splash) await new Promise((r) => setTimeout(r, 100)); }
await splash.waitForFunction(() => document.getElementById('buttons').classList.contains('on'), null, { timeout: 30000 });
ok(/0\.2\.0/.test(await splash.textContent('#text')), 'splash offers the new build');
await splash.click('text=Позже');
win = await editorWindow(app);
ok((await win.evaluate(() => window.vspbHost.info())).version === '0.1.2', 'meanwhile the newest compatible bundle (0.1.2) runs');
await win.waitForFunction(() => /0\.2\.0 — скачать/.test(document.getElementById('update').textContent), null, { timeout: 30000 })
  .then(() => ok(true, 'the editor shows «Новая версия 0.2.0 — скачать»'), () => ok(false, 'the editor shows the download button'));
await win.screenshot({ path: path.join(os.tmpdir(), 'citylabs-update.png') });
await app.close();

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all update checks passed');
process.exit(fails ? 1 : 0);
