// City Labs: the city editor as a desktop app. The web editor in a window, with direct .vspb file
// access (open / save / save as / watch for outside changes) and an MCP server on 127.0.0.1 whose
// tool calls run inside the editor, so an agent's edits show live and land in the undo history.
// Started by app/dev.mjs (repo + Vite dev server) or by the installed shell (app/boot/boot.cjs),
// which passes the bundle directory and the updater.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, clipboard, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { TOOLS, TOOL_BY_NAME } from '../mcp/ops.js';
import { t, setLang } from '../editor/i18n.js';

export const APP_NAME = 'City Labs';
const MCP_PORT = +(process.env.VSPB_MCP_PORT ?? 7357);
const STATE = () => path.join(app.getPath('userData'), 'state.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')); } catch { return {}; } };
const writeState = (s) => { try { fs.writeFileSync(STATE(), JSON.stringify({ ...readState(), ...s })); } catch { /* not fatal */ } };

let win = null, vite = null, file = null, dirty = false, forceClose = false, ownWrite = 0, watcher = null;
let opts = null;                         // start() options: { mode, root, bundleDir, version, shell, updater }

// ---------------------------------------------------------------- file access
// the sample world: the repo's city in dev, a writable copy of the bundled one when installed
function sampleWorld() {
  if (opts.mode === 'dev') return path.join(opts.root, 'city/data/vespera.vspb');
  const dst = path.join(app.getPath('userData'), 'worlds', 'vespera.vspb');
  if (!fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, fs.readFileSync(path.join(opts.bundleDir, 'sample/vespera.vspb'))); }
  return dst;
}
// a .vspb named on the command line (Windows / Linux file associations, scripts)
export const vspbArg = (argv) => { const a = argv.slice(1).find((x) => x.toLowerCase().endsWith('.vspb') && !x.startsWith('-')); return a && path.resolve(a); };
/** The world to open at start: one handed over by the system, or none (the editor starts a new map). */
function pickStartFile() {
  for (const f of [opts.openFile, vspbArg(process.argv)]) if (f && fs.existsSync(f)) return f;
  return null;
}
/** The system asks to open a file while the app runs: the editor decides (it may have unsaved work). */
export function openRequest(f) {
  if (!f || !win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send('file:open-request', { path: f });
}
function setFile(f) {
  file = f;
  if (f) app.addRecentDocument?.(f);
  watcher?.close();
  watcher = null;
  if (!f) return;
  // watch the folder: saves replace the file (write + rename), which a watch on the file itself loses
  let t = 0;
  const base = path.basename(f);
  watcher = fs.watch(path.dirname(f), (_ev, name) => {
    if (name && name !== base) return;
    clearTimeout(t);
    t = setTimeout(() => {
      let m = 0; try { m = fs.statSync(f).mtimeMs; } catch { return; }
      if (Math.abs(m - ownWrite) > 1) win?.webContents.send('file:changed', { path: f });
    }, 300);
  });
}
function writeFile(f, bytes) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(bytes));
  fs.renameSync(tmp, f);
  ownWrite = fs.statSync(f).mtimeMs;
}
const fileFilter = [{ name: 'Vespera world', extensions: ['vspb'] }];

ipcMain.handle('file:current', () => (file ? { path: file, bytes: fs.readFileSync(file) } : null));
ipcMain.handle('file:reload', () => (file ? { path: file, bytes: fs.readFileSync(file) } : null));
ipcMain.handle('file:new', () => { setFile(null); return null; });
ipcMain.handle('file:openPath', (_e, f) => { setFile(f); return { path: f, bytes: fs.readFileSync(f) }; });
ipcMain.handle('file:sample', () => { setFile(sampleWorld()); return { path: file, bytes: fs.readFileSync(file) }; });
ipcMain.handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: fileFilter, defaultPath: file ? path.dirname(file) : app.getPath('documents') });
  if (r.canceled || !r.filePaths[0]) return null;
  setFile(r.filePaths[0]);
  return { path: file, bytes: fs.readFileSync(file) };
});
ipcMain.handle('file:save', async (_e, bytes) => {
  if (!file) return saveAs(bytes);
  writeFile(file, bytes);
  return { path: file };
});
ipcMain.handle('file:saveAs', (_e, bytes) => saveAs(bytes));
// exports go wherever the user picks (not the world file)
ipcMain.handle('file:export', async (_e, name, bytes) => {
  const ext = path.extname(name).slice(1);
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(file ? path.dirname(file) : app.getPath('documents'), name),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(bytes));
  return { path: r.filePath };
});
async function saveAs(bytes) {
  const r = await dialog.showSaveDialog(win, { filters: fileFilter, defaultPath: file ?? path.join(app.getPath('documents'), 'city.vspb') });
  if (r.canceled || !r.filePath) return null;
  writeFile(r.filePath, bytes);
  setFile(r.filePath);
  return { path: file };
}
ipcMain.on('doc:dirty', (_e, d) => { dirty = !!d; win?.setDocumentEdited?.(dirty); });
ipcMain.on('doc:title', (_e, title) => win?.setTitle(title));
// the editor's language also drives the menu, dialogs and (via state.json) the shell's splash
ipcMain.on('app:lang', (_e, l) => { setLang(l); writeState({ lang: l }); buildMenu(); });
// the ☰ button in the editor's top bar (Windows / Linux have no menu bar without a title bar)
ipcMain.on('app:menu', (_e, { x, y }) => Menu.getApplicationMenu()?.popup({ window: win, x: Math.round(x), y: Math.round(y) }));
ipcMain.on('app:zoom', () => { if (!win) return; if (win.isMaximized()) win.unmaximize(); else win.maximize(); });
ipcMain.on('app:close-now', () => { forceClose = true; win?.close(); });
ipcMain.handle('app:info', () => ({ name: APP_NAME, version: opts.version, shell: opts.shell, mode: opts.mode,
  mcpPort: MCP_PORT, mcpUrl: `http://127.0.0.1:${MCP_PORT}/mcp`, update: opts.updater?.state ?? null }));
// the editor's update button: restart into a downloaded bundle, or fetch the new installer
ipcMain.handle('app:update', (_e, action) => (action === 'check' ? opts.updater?.check(true) : action === 'restart' ? restartForUpdate() : opts.updater?.downloadShell()));
function restartForUpdate() { app.relaunch(); app.quit(); }

// ---------------------------------------------------------------- MCP: tool calls run in the editor
let callSeq = 0;
const pending = new Map();
ipcMain.on('mcp:result', (_e, { id, result }) => { pending.get(id)?.(result); pending.delete(id); });
function inEditor(name, args) {
  if (!win) return Promise.resolve({ isError: true, content: [{ type: 'text', text: 'the editor window is closed' }] });
  const id = ++callSeq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    win.webContents.send('mcp:call', { id, name, args });
    setTimeout(() => { if (pending.delete(id)) resolve({ isError: true, content: [{ type: 'text', text: `${name}: the editor did not answer in 120 s` }] }); }, 120000);
  });
}
async function callTool(name, args = {}) {
  if (!TOOL_BY_NAME[name]) return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  const r = await inEditor(name, args);
  if (name !== 'screenshot' || r.isError) return r;
  // the editor aimed the camera and hid its panels; grab the frame, then bring the panels back
  let img = await win.webContents.capturePage();
  await inEditor('__ui', { shot: false });
  if (args.width && img.getSize().width > args.width) img = img.resize({ width: args.width });
  return { content: [{ type: 'image', data: img.toPNG().toString('base64'), mimeType: 'image/png' }, ...r.content] };
}
function mcpServer() {
  const s = new McpServer({ name: 'vespera-editor', version: '1.0.0' });
  for (const t of TOOLS) s.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.schema(z) }, (args) => callTool(t.name, args));
  return s;
}
const readBody = (req) => new Promise((resolve, reject) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined); } catch (e) { reject(e); } });
  req.on('error', reject);
});
let mcpHttp = null;
function startMcp() {
  const srv = mcpHttp = http.createServer(async (req, res) => {
    const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    // only local tools: refuse pages from other sites (DNS rebinding) and anything not on loopback
    const origin = req.headers.origin;
    if (origin && !/^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|file:\/\/)/.test(origin)) return json(403, { error: 'origin not allowed' });
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/health') return json(200, { app: 'vespera-editor', file, dirty });
      if (url.pathname === '/tool' && req.method === 'POST') { const { name, args } = await readBody(req); return json(200, await callTool(name, args)); }
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') return json(405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
        const body = await readBody(req), server = mcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        return transport.handleRequest(req, res, body);
      }
      json(404, { error: 'not found' });
    } catch (e) { json(500, { error: String(e?.message ?? e) }); }
  });
  srv.on('error', (e) => console.error(`MCP server not started on :${MCP_PORT}: ${e.message}`));
  srv.listen(MCP_PORT, '127.0.0.1', () => console.log(`MCP: http://127.0.0.1:${MCP_PORT}/mcp`));
}

// ---------------------------------------------------------------- window + menu
const send = (what) => () => win?.webContents.send('menu', what);
function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: t('menu.file'), submenu: [
      { label: t('menu.new'), accelerator: 'CmdOrCtrl+N', click: send('new') },
      { label: t('common.open'), accelerator: 'CmdOrCtrl+O', click: send('open') },
      { label: t('common.save'), accelerator: 'CmdOrCtrl+S', click: send('save') },
      { label: t('common.saveAs'), accelerator: 'Shift+CmdOrCtrl+S', click: send('saveAs') },
      { label: t('file.reloadFromDisk'), click: send('reload') },
      { type: 'separator' },
      { label: t('menu.openSample'), click: send('sample') },
      { label: t('menu.export'), accelerator: 'CmdOrCtrl+E', click: send('export') },
      { label: t(process.platform === 'darwin' ? 'menu.showInFinder' : 'menu.showInFolder'), click: () => file && shell.showItemInFolder(file) },
      ...(mac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
    ] },
    // no undo/redo roles here: Cmd+Z goes to the editor's own history
    { label: t('menu.edit'), submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: t('menu.view'), submenu: [{ role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: t('menu.help'), submenu: [
      { label: t('menu.version', { app: APP_NAME, v: opts.version ?? '', shell: opts.shell ?? '—' }), enabled: false },
      { label: t('menu.checkUpdates'), enabled: !!opts.updater, click: () => opts.updater?.check(true) },
      { label: t('menu.projectPage'), click: () => shell.openExternal('https://github.com/vicimpa/city-labs') },
    ] },
    { label: 'MCP', submenu: [
      { label: t('menu.mcpServer', { url: `http://127.0.0.1:${MCP_PORT}/mcp` }), enabled: false },
      { label: t('menu.copyClaudeCommand'), click: () => clipboard.writeText(`claude mcp add --transport http city-labs http://127.0.0.1:${MCP_PORT}/mcp`) },
    ] },
  ]));
}

async function createWindow() {
  const st = readState();
  win = new BrowserWindow({ width: st.bounds?.width ?? 1600, height: st.bounds?.height ?? 1000, x: st.bounds?.x, y: st.bounds?.y,
    backgroundColor: '#0b0f14', title: APP_NAME, show: false,
    // no system title bar: the editor's top bar is the title bar (traffic lights / window buttons sit in it)
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 13, y: 12 } }
      : { titleBarOverlay: { color: '#0e131a', symbolColor: '#d8dde3', height: 38 } }),
    webPreferences: { preload: opts.preload, contextIsolation: true, sandbox: true } });
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    writeState({ bounds: win.getBounds() });
    if (!dirty || forceClose) return;
    e.preventDefault();
    const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: [t('common.save'), t('dialog.dontSave'), t('dialog.cancel')], defaultId: 0, cancelId: 2,
      message: file ? t('dialog.saveChanges', { name: path.basename(file) }) : t('dialog.saveChangesNew') });
    if (r === 0) win.webContents.send('app:save-and-close');
    else if (r === 1) { forceClose = true; win.close(); }
  });
  win.on('closed', () => { win = null; });
  // links open in the browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  await win.loadURL(opts.url);
  return win;
}

// installed: the built editor is served from the bundle as app://city-labs/ (the shell registered the scheme)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.vspb': 'application/octet-stream' };
function serveBundle(webDir) {
  protocol.handle('app', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'editor/index.html';
    const f = path.join(webDir, rel.endsWith('/') ? rel + 'index.html' : rel);
    if (!f.startsWith(webDir)) return new Response('forbidden', { status: 403 });
    try { return new Response(await fs.promises.readFile(f), { headers: { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' } }); }
    catch { return new Response('not found', { status: 404 }); }
  });
}

/** Start the editor. mode 'dev': repo at opts.root, Vite dev server; mode 'prod': built bundle at opts.bundleDir. */
export async function start(o) {
  opts = o;
  if (o.mode === 'dev' && devPending) o.openFile ??= devPending;
  await app.whenReady();
  if (o.mode === 'dev') {
    process.chdir(o.root);
    const { createServer } = await import('vite');
    vite = await createServer({ configFile: path.join(o.root, 'viewer/vite.config.js'), root: o.root, server: { port: 5287, open: false, strictPort: false }, logLevel: 'warn' });
    await vite.listen();
    o.preload = path.join(o.root, 'app/preload.cjs');
    o.url = new URL('editor/?host=app', vite.resolvedUrls.local[0]).href;
  } else {
    serveBundle(path.join(o.bundleDir, 'web'));
    o.preload = path.join(o.bundleDir, 'preload.cjs');
    o.url = 'app://city-labs/editor/index.html?host=app';
  }
  o.updater?.on((state) => win?.webContents.send('update', state));
  setLang(readState().lang ?? (app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en'));
  setFile(pickStartFile());
  buildMenu();
  startMcp();
  return createWindow();
}
// in dev there is no shell: take the system's open requests here (the shell forwards them when installed)
if (!process.env.CITY_LABS_SHELL) {
  app.on('open-file', (e, f) => { e.preventDefault(); if (win) openRequest(f); else devPending = f; });
  app.on('second-instance', (_e, argv) => openRequest(vspbArg(argv)));
}
let devPending = null;
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { watcher?.close(); mcpHttp?.close(); vite?.close(); });
