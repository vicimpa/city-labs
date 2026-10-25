// City Labs shell: the part the installer puts on disk. It shows a splash, checks GitHub for
// updates and starts the newest compatible app bundle, like Discord's host:
//   - a release whose `shell` is newer than this one needs a new installer: offered for download;
//   - otherwise a newer code bundle (app-<version>.asar) is downloaded, checked against its sha256
//     and started instead of the one built into the installer.
// Bundles live in <userData>/updates; one that fails to start is set aside and the built-in runs.
const { app, BrowserWindow, protocol, net, shell, ipcMain, dialog } = require('electron');
const ofs = require('original-fs');        // plain-file access to .asar archives
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pkg = require('../package.json');
const SHELL = pkg.cityLabs.shell, REPO = pkg.cityLabs.repo;
const FEED = process.env.CITY_LABS_UPDATE_URL;   // test feed: a folder URL holding manifest.json + assets
const CHECK_EVERY = 30 * 60 * 1000;

// the shell's own strings; the language is the editor's choice (state.json) or the system's
const TEXT = {
  en: {
    checking: 'Checking for updates…', newShell: 'Version {v} is out. It needs a fresh install.', downloading: 'Downloading {v}…',
    updating: 'Downloading update {v}…', starting: 'Starting {v}…', version: 'version {v}', download: 'Download', later: 'Later',
    dlFailed: 'Could not download the update', startFailed: 'City Labs failed to start', checkFailed: 'Could not check for updates',
    latest: 'You have the latest City Labs ({v})', downloaded: 'City Labs {v} downloaded',
    macInstall: 'Drag City Labs into Applications, replacing the old one, and start it again.', file: 'File: {path}',
  },
  ru: {
    checking: 'Проверка обновлений…', newShell: 'Вышла новая версия {v}. Её нужно установить заново.', downloading: 'Скачивание {v}…',
    updating: 'Загрузка обновления {v}…', starting: 'Запуск {v}…', version: 'версия {v}', download: 'Скачать', later: 'Позже',
    dlFailed: 'Не удалось скачать обновление', startFailed: 'City Labs не запустился', checkFailed: 'Не удалось проверить обновления',
    latest: 'У вас последняя версия City Labs ({v})', downloaded: 'City Labs {v} скачан',
    macInstall: 'Перетащите City Labs в «Программы» с заменой и запустите заново.', file: 'Файл: {path}',
  },
};
const lang = () => {
  const s = readJson(path.join(app.getPath('userData'), 'state.json'), {}).lang;
  return TEXT[s] ? s : app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en';
};
const T = (k, p = {}) => TEXT[lang()][k].replace(/\{(\w+)\}/g, (m, x) => p[x] ?? m);

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
if (!app.requestSingleInstanceLock()) app.quit();
process.env.CITY_LABS_SHELL = String(SHELL);

// files handed over by the system (double-click, Open With, the dock): kept until the bundle runs,
// then passed to it; later ones (and a second launch with a file) go straight to the editor
let pendingFile = null, bundleMain = null;
const vspbArg = (argv) => { const a = argv.slice(1).find((x) => x.toLowerCase().endsWith('.vspb') && !x.startsWith('-')); return a && path.resolve(a); };
app.on('open-file', (e, f) => { e.preventDefault(); if (bundleMain?.openRequest) bundleMain.openRequest(f); else pendingFile = f; });
app.on('second-instance', (_e, argv) => { const f = vspbArg(argv); if (f) bundleMain?.openRequest?.(f); });

// ---------------------------------------------------------------- bundles
const updatesDir = () => path.join(app.getPath('userData'), 'updates');
const builtin = () => { const dir = path.join(__dirname, '..', 'bundle'); const p = require(path.join(dir, 'package.json')); return { dir, version: p.version, shell: p.cityLabs.shell, builtin: true }; };
const cmp = (a, b) => {
  const pa = String(a).split(/[.-]/).map((x) => +x || 0), pb = String(b).split(/[.-]/).map((x) => +x || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function downloaded() {
  const bad = new Set(readJson(path.join(updatesDir(), 'bad.json'), []));
  let names = [];
  try { names = ofs.readdirSync(updatesDir()); } catch { /* none yet */ }
  return names.filter((n) => /^app-.+\.asar$/.test(n)).map((n) => {
    const meta = readJson(path.join(updatesDir(), n.replace(/\.asar$/, '.json')), null);
    return meta && !bad.has(meta.version) ? { dir: path.join(updatesDir(), n), version: meta.version, shell: meta.shell } : null;
  }).filter(Boolean);
}
/** The newest bundle this shell can run. */
function pick() {
  return [builtin(), ...downloaded()].filter((b) => b.shell <= SHELL).sort((a, b) => cmp(b.version, a.version))[0];
}
function prune(keep) {
  for (const b of downloaded()) if (b.version !== keep && cmp(b.version, keep) < 0) {
    try { ofs.rmSync(b.dir, { force: true }); fs.rmSync(b.dir.replace(/\.asar$/, '.json'), { force: true }); } catch { /* in use */ }
  }
}

// ---------------------------------------------------------------- updater
async function fetchWithProgress(url, onProgress) {
  const res = await net.fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = +(res.headers.get('content-length') ?? 0), reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (total) onProgress?.(got / total);
  }
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

class Updater {
  constructor() { this.state = { kind: 'none' }; this.listeners = []; this.running = null; this.manifest = null; }
  on(fn) { this.listeners.push(fn); }
  set(st) { this.state = st; for (const fn of this.listeners) fn(st); }
  asset(m, file) { return FEED ? new URL(file, FEED).href : `https://github.com/${REPO}/releases/download/${m.tag}/${file}`; }
  async manifestNow() {
    const url = FEED ? new URL('manifest.json', FEED).href : `https://github.com/${REPO}/releases/latest/download/manifest.json`;
    const res = await net.fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
    return (this.manifest = await res.json());
  }
  /** What the latest release means for us: { kind: 'shell' | 'asar' | 'none', version, ready? } */
  async check(manual = false, { timeout = 15000 } = {}) {
    let m;
    try { m = await withTimeout(this.manifestNow(), timeout); } catch (e) {
      if (manual) dialog.showMessageBox({ type: 'warning', message: T('checkFailed'), detail: String(e.message ?? e) });
      return this.state;
    }
    const current = this.running ?? pick().version;
    if (m.shell > SHELL) this.set({ kind: 'shell', version: m.version });
    else if (cmp(m.version, current) > 0) {
      const have = downloaded().find((b) => b.version === m.version);
      this.set(have ? { kind: 'asar', version: m.version, ready: true } : { kind: 'asar', version: m.version, ready: false });
      if (!have && this.running) this.downloadAsar().catch((e) => console.error('update download failed:', e));
    } else {
      this.set({ kind: 'none' });
      if (manual) dialog.showMessageBox({ type: 'info', message: T('latest', { v: current }) });
    }
    return this.state;
  }
  async downloadAsar(onProgress) {
    const m = this.manifest, a = m.asar;
    const report = (p) => { onProgress?.(p); this.set({ kind: 'asar', version: m.version, progress: p }); };
    const buf = await fetchWithProgress(this.asset(m, a.file), report);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== a.sha256) throw new Error(`bundle ${m.version}: checksum mismatch`);
    fs.mkdirSync(updatesDir(), { recursive: true });
    const dst = path.join(updatesDir(), `app-${m.version}.asar`), tmp = dst + '.download';
    fs.writeFileSync(tmp, buf);
    ofs.renameSync(tmp, dst);
    fs.writeFileSync(dst.replace(/\.asar$/, '.json'), JSON.stringify({ version: m.version, shell: m.shell, sha256: sha }));
    this.set({ kind: 'asar', version: m.version, ready: true });
  }
  /** Download this platform's installer into Downloads and open it. */
  async downloadShell(onProgress) {
    const m = this.manifest ?? (await this.manifestNow()), file = m.installers?.[`${process.platform}-${process.arch}`];
    if (!file) { shell.openExternal(`https://github.com/${REPO}/releases/latest`); return; }
    const buf = await fetchWithProgress(this.asset(m, file), (p) => { onProgress?.(p); this.set({ kind: 'shell', version: m.version, progress: p }); });
    const dst = path.join(app.getPath('downloads'), file);
    fs.writeFileSync(dst, buf);
    if (process.platform === 'linux') fs.chmodSync(dst, 0o755);
    this.set({ kind: 'shell', version: m.version });
    if (process.platform === 'win32') { await shell.openPath(dst); app.quit(); return; }
    shell.showItemInFolder(dst);
    if (process.platform === 'darwin') await shell.openPath(dst);
    dialog.showMessageBox({ type: 'info', message: T('downloaded', { v: m.version }),
      detail: process.platform === 'darwin' ? T('macInstall') : T('file', { path: dst }) });
  }
}

// ---------------------------------------------------------------- splash
function splashWindow() {
  const w = new BrowserWindow({ width: 340, height: 380, frame: false, resizable: false, show: false, backgroundColor: '#0b0f14',
    webPreferences: { preload: path.join(__dirname, 'splash-preload.cjs'), contextIsolation: true, sandbox: true } });
  w.loadFile(path.join(__dirname, 'splash.html'));
  w.once('ready-to-show', () => w.show());
  const ready = new Promise((r) => w.webContents.once('did-finish-load', r));
  w.say = async (st) => {
    await ready;
    const labels = { download: T('download'), later: T('later'), version: st.version && T('version', { v: st.version }) };
    if (!w.isDestroyed()) w.webContents.executeJavaScript(`window.show(${JSON.stringify({ ...st, labels })})`).catch(() => {});
  };
  w.choice = () => new Promise((r) => ipcMain.once('splash:choice', (_e, c) => r(c)));
  return w;
}

app.whenReady().then(async () => {
  const splash = splashWindow(), updater = new Updater();
  splash.say({ text: T('checking'), version: pick().version });
  const st = await updater.check(false, { timeout: 6000 });
  if (st.kind === 'shell') {
    splash.say({ text: T('newShell', { v: st.version }), offer: true });
    if ((await splash.choice()) === 'download') {
      splash.say({ text: T('downloading', { v: st.version }), progress: 0 });
      try { await updater.downloadShell((p) => splash.say({ text: T('downloading', { v: st.version }), progress: p })); }
      catch (e) { dialog.showErrorBox(T('dlFailed'), String(e.message ?? e)); }
      if (process.platform !== 'linux') { app.quit(); return; }
    }
  } else if (st.kind === 'asar' && !st.ready) {
    try { await updater.downloadAsar((p) => splash.say({ text: T('updating', { v: st.version }), progress: p })); }
    catch (e) { console.error(e); }
  }
  // start the newest compatible bundle; a downloaded one that fails is set aside and the built-in runs
  let b = pick();
  for (;;) {
    splash.say({ text: T('starting', { v: b.version }), progress: null });
    try {
      const main = require(path.join(b.dir, 'main.cjs'));
      updater.running = b.version;
      await main.start({ mode: 'prod', bundleDir: b.dir, version: b.version, shell: SHELL, updater, openFile: pendingFile ?? vspbArg(process.argv) });
      bundleMain = main;
      break;
    } catch (e) {
      console.error(`bundle ${b.version} failed:`, e);
      if (b.builtin) { dialog.showErrorBox(T('startFailed'), String(e.stack ?? e)); app.quit(); return; }
      const badFile = path.join(updatesDir(), 'bad.json');
      fs.writeFileSync(badFile, JSON.stringify([...readJson(badFile, []), b.version]));
      app.relaunch(); app.exit(0); return;
    }
  }
  prune(b.version);
  if (updater.state.kind === 'asar' && updater.state.version === b.version) updater.set({ kind: 'none' });
  splash.destroy();
  setInterval(() => updater.check().catch(() => {}), CHECK_EVERY);
});
