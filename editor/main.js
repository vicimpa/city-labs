// Vespera world editor: edits the VSPB world in place, keeps a working copy in IndexedDB,
// downloads / writes back .vspb. Scene code is shared with the viewer (viewer/world3d.js).
import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { World3D } from '../viewer/world3d.js';
import { decodeWorld, encodeWorldLayer, assemble, emptyWorld, LAYERS } from '../format/world.js';
import { loadWorking, saveWorking, dropWorking } from './store.js';
import { History, clone } from './history.js';
import { KINDS, suggestions } from './kinds.js';
import { RoadTx, addRoad, reprofile, deleteEdge, deleteNode } from './roadedit.js';
import { bbox } from '../world/roadworld.js';
import { syncClassWidths, groundSampler } from '../world/roadnet.js';
import { carveRegion } from '../world/carve.js';
import { cumLength, smoothstep } from '../world/geom.js';
import { runTool, TOOL_BY_NAME } from '../mcp/ops.js';
import { runScript, SCRIPT_API } from '../mcp/script.js';
import { GENERATORS, GENERATOR_BY_ID, runGenerator } from '../mcp/generators.js';
import { inspector, h } from './inspector.js';
import { t, getLang, setLang, onLang, applyDom, LANGS } from './i18n.js';

const SRC = '/city/data/vespera.vspb', TILE = 600;
// the sample city: the repo's file on the dev server, a copy next to the page in the web build
const SAMPLE = import.meta.env?.DEV ? SRC : 'samples/vespera.vspb';
// desktop app (app/preload.cjs): the world is a file on disk, saved explicitly; MCP calls arrive here
const host = window.vspbHost ?? null;
const $ = (id) => document.getElementById(id);
const r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- scene
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);
scene.fog = new THREE.Fog(0x0b0f14, 6000, 16000);
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 40000);
camera.up.set(0, 0, 1);
camera.position.set(400, -1900, 1500);
const controls = new MapControls(camera, renderer.domElement);
controls.screenSpacePanning = false;
controls.zoomToCursor = true;
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 5;
controls.maxDistance = 25000;
controls.maxPolarAngle = Math.PI * 0.49;
controls.target.set(0, 0, 0);
controls.update();
const hemi = new THREE.HemisphereLight(0xcfd8e6, 0x2a2f25, 1.1);
const sun = new THREE.DirectionalLight(0xffe2c0, 1.6);
sun.position.set(-3000, -2000, 4000);
scene.add(hemi, sun);

const tickers = [];
const roadGraph = new THREE.Group(); roadGraph.name = 'roadGraph';
const selGroup = new THREE.Group();
const draft = new THREE.Group();
scene.add(roadGraph, selGroup, draft);

// ---------------------------------------------------------------- state
let doc = null, world = null;
// where the open world came from: { kind: 'new' | 'sample' | 'browser', when? } or { kind: 'file', path }
let source = { kind: 'new' };
const sourcePath = () => (source.kind === 'file' ? source.path : null);
function sourceLabel() {
  if (source.kind === 'file') return source.path;
  if (source.kind === 'browser') return t('file.browserEdits', { when: new Date(source.when).toLocaleString() });
  return t(source.kind === 'sample' ? 'file.sample' : 'file.untitled');
}
function renderSource() {
  $('source').textContent = sourceLabel();
  const name = sourceLabel().split(/[\\/]/).pop();
  document.title = `${unsaved ? '● ' : ''}${name} — City Labs`;
  host?.setTitle(document.title);
}
let chunks = {};                       // layer -> encoded VSPB chunks as last saved
const dirty = new Set();               // layers changed since the last save
const roadBoxes = new Map();           // road record -> bbox of its geometry when the meshes were last built
let sel = null;                        // { kind, rec }
let tool = 'select';
let drag = null;                       // active pointer gesture
let draw = null;                       // polyline being drawn by a create tool
let handles = [], hover = null;        // vertex handles of the selection
const hist = new History(onHistory);
const vis = { terrain: true, roads: true, furniture: true, blocks: true, surfaces: true, trees: true, rails: true, wind: true, trains: true, cables: true, roadGraph: true, grid: true };

const OPTS = { snap: true, soft: 40, rCls: 'street', rName: '', bType: 'block', bZone: 'midtown', bMat: 'concrete', bH: 18, sMat: 'plaza', fType: 'lamp', fRot: 0,
  brush: 'raise', radius: 40, strength: 6 };
const opts = { ...OPTS };
try { Object.assign(opts, JSON.parse(localStorage.getItem('vspb-editor-opts') ?? '{}')); } catch { /* private mode */ }
const saveOpts = () => { try { localStorage.setItem('vspb-editor-opts', JSON.stringify(opts)); } catch { /* ignore */ } };

const list = (kind) => KINDS[kind].list(doc.layers);
const ground = (x, y) => Math.max(world?.H?.(x, y) ?? 0, 0);

// ---------------------------------------------------------------- load / save
function busy(text) { $('busy').hidden = !text; $('busy').textContent = text || ''; }


async function boot() {
  busy(t('common.loading'));
  if (host) return bootApp();
  try {
    const w = await loadWorking().catch(() => null);
    if (w) {
      setDoc(await decodeWorld(await assemble(w.meta ?? {}, w.chunks, w.unknown)), w.chunks, { kind: 'browser', when: w.savedAt });
      setSaveState('saved', w.savedAt);
    } else {
      setDoc(emptyWorld(), {}, { kind: 'new' });
      setSaveState('clean');
    }
  } catch (e) {
    console.error(e); busy(t('file.loadFailed', { e: e.message })); return;
  }
  busy('');
  // the dev server can write the world back into the repo (viewer/vite.config.js)
  if (import.meta.env?.DEV) fetch('/__vspb/ping').then((r) => r.json()).then((j) => { $('writeProject').hidden = !j.vspb; }).catch(() => {});
}

// look at the whole map from the south-west, slightly above
function frameWorld() {
  const T = doc.layers.terrain;
  if (!T) return;
  const w = (T.nx - 1) * T.res, cx = T.x0 + w / 2, cy = T.y0 + ((T.ny - 1) * T.res) / 2, z = T.h[(T.ny >> 1) * T.nx + (T.nx >> 1)] ?? 0;
  controls.target.set(cx, cy, z);
  camera.position.set(cx - w * 0.08, cy - w * 0.55, z + w * 0.45);
  controls.update();
}
function setDoc(d, ch, src, { frame = true } = {}) {
  if (world) for (const n of ['terrain', 'roads', 'furniture', 'buildings']) scene.remove(world.groups[n]);
  tickers.length = 0;
  doc = d; chunks = { ...ch }; source = src;
  dirty.clear(); roadBoxes.clear();
  for (const e of doc.layers.roads?.edges ?? []) roadBoxes.set(e, bbox(e.pts));
  world = new World3D(doc, { anisotropy: renderer.capabilities.getMaxAnisotropy(), tileSize: TILE, tickers, grid: vis.grid }).buildAll();
  for (const n of ['terrain', 'roads', 'furniture', 'buildings']) scene.add(world.groups[n]);
  applyVisibility();
  buildRoadGraph();
  hist.done.length = 0; hist.undone.length = 0;
  sel = null; draw = null; drag = null;
  renderSource();
  if (frame) frameWorld();
  updateUndo(); renderDefs(); renderLayers(); renderFind(); renderScript(); renderGen(); select(null); setTool(tool);
}

let saveTimer = 0, saving = false, savedAt = 0, unsaved = false, saveState = 'clean';
function setSaveState(s, at) {
  const el = $('save');
  if (at) savedAt = at;
  el.className = s === 'dirty' ? 'dirty' : '';
  saveState = s;
  const time = new Date(savedAt).toLocaleTimeString();
  el.textContent = s === 'dirty' ? t('save.dirty') : s === 'saving' ? t('save.saving')
    : s === 'clean' ? t('save.clean') : host ? t('save.savedDisk', { time }) : t('save.savedBrowser', { time });
  if (host) { unsaved = s === 'dirty' || (s === 'saving' && unsaved); host.setDirty(unsaved); }
  else unsaved = s === 'dirty';
  if (doc) renderSource();
}
function markDirty(layer) {
  dirty.add(layer); setSaveState('dirty');
  if (host) return;                       // the app saves on Cmd+S, the browser autosaves to IndexedDB
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 2000);
}

// re-encode the layers changed since the last save (encoding is synchronous up to compression: a consistent snapshot)
async function encodeChunks() {
  for (const name of Object.keys(doc.layers)) {
    if (!dirty.has(name) && chunks[name]) continue;
    dirty.delete(name);
    chunks[name] = await encodeWorldLayer(doc, name);
  }
  for (const name of Object.keys(chunks)) if (!doc.layers[name]) delete chunks[name];
}

/** Save: to IndexedDB in the browser, to the file in the app (as: pick a new path). Returns false if nothing was written. */
async function saveNow({ as = false } = {}) {
  clearTimeout(saveTimer);
  if (drag || saving) { if (!host) saveTimer = setTimeout(saveNow, 1000); return false; }
  saving = true; setSaveState('saving');
  let ok = false;
  try {
    await encodeChunks();
    if (host) {
      const bytes = await assembleFile();
      const r = await (as ? host.saveAs(bytes) : host.save(bytes));
      if (r) { source = { kind: 'file', path: r.path }; ok = true; }
      setSaveState(ok ? 'saved' : 'dirty', Date.now());
    } else {
      await saveWorking({ meta: doc.meta ?? {}, chunks, unknown: doc.unknown ?? [], savedAt: Date.now() });
      ok = true;
      setSaveState(dirty.size ? 'dirty' : 'saved', Date.now());
    }
  } catch (e) { console.error(e); $('save').textContent = t('save.failed', { e: e.message }); }
  saving = false;
  if (!host && dirty.size) saveTimer = setTimeout(saveNow, 1000);
  return ok;
}

async function fileBytes() {
  await saveNow();
  return assembleFile();
}
function assembleFile() {
  const ordered = {};
  for (const n of [...LAYERS, ...Object.keys(chunks)]) if (chunks[n] && !ordered[n]) ordered[n] = chunks[n];
  return assemble({ ...(doc.meta ?? {}), editor: 'vespera-editor', saved: new Date().toISOString() }, ordered, doc.unknown);
}

// ---------------------------------------------------------------- new / open / sample / save (browser)
// is there work that switching to another world would lose?
const hasWork = () => (host ? unsaved : hist.done.length > 0 || dirty.size > 0);
async function replaceWorld(load, src) {
  if (hasWork() && !confirm(t('file.replaceWorkConfirm'))) return false;
  busy(t('common.loading'));
  try {
    const d = await load();
    if (!host) await dropWorking().catch(() => {});     // the browser copy follows the new world from its first edit
    setDoc(d, {}, src);
    setSaveState('clean');
    return true;
  } catch (e) { alert(t('file.openFailed', { e: e.message })); return false; } finally { busy(''); }
}
const newWorld = () => replaceWorld(async () => { host?.newFile(); return emptyWorld(); }, { kind: 'new' });
async function openSample() {
  if (host) { const f = await host.openSample(); return f && replaceWorld(() => decodeWorld(f.bytes), { kind: 'file', path: f.path }); }
  return replaceWorld(async () => decodeWorld(await (await fetch(SAMPLE)).arrayBuffer()), { kind: 'sample' });
}
$('new').onclick = () => newWorld();
$('sample').onclick = () => openSample();
$('download').onclick = async () => {
  busy(t('file.building'));
  try {
    const buf = await fileBytes();
    const name = (sourcePath() ?? (source.kind === 'sample' ? 'vespera.vspb' : 'city.vspb')).split(/[\\/]/).pop();
    const a = h('a', { href: URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' })), download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } finally { busy(''); }
};
$('writeProject').onclick = async () => {
  if (!confirm(t('file.writeProjectConfirm'))) return;
  busy(t('file.writingProject'));
  try {
    const r = await fetch('/__vspb/save', { method: 'POST', body: await fileBytes() });
    if (!r.ok) throw new Error(await r.text());
    hint(t('file.writtenTo', { path: SRC }));
  } catch (e) { alert(t('file.writeFailed', { e: e.message })); } finally { busy(''); }
};
$('open').onclick = () => $('file').click();
$('file').onchange = async (ev) => {
  const f = ev.target.files[0]; ev.target.value = '';
  if (f) await replaceWorld(async () => decodeWorld(await f.arrayBuffer()), { kind: 'file', path: f.name });
};
$('undo').onclick = () => hist.undo();
$('redo').onclick = () => hist.redo();

// ---------------------------------------------------------------- desktop app: the file on disk
async function bootApp() {
  try {
    const f = await host.current();
    // no file given (double-click, command line): start with a new empty map
    if (f) setDoc(await decodeWorld(f.bytes), {}, { kind: 'file', path: f.path });
    else setDoc(emptyWorld(), {}, { kind: 'new' });
    setSaveState('clean');
  } catch (e) { console.error(e); busy(t('file.loadFailed', { e: e.message })); return; }
  busy('');
}
async function openFromApp(f, opts = {}) {
  if (!f) return;
  busy(t('common.reading'));
  try { setDoc(await decodeWorld(f.bytes), {}, { kind: 'file', path: f.path }, opts); setSaveState('clean'); }
  catch (e) { alert(t('file.openFailed', { e: e.message })); } finally { busy(''); }
}
const reloadFromDisk = async () => openFromApp(await host.reload(), { frame: false });
if (host) {
  document.body.classList.add('frameless', host.platform === 'darwin' ? 'mac' : 'winlike');
  $('appmenu').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); host.menu(r.left, r.bottom); };
  $('top').addEventListener('dblclick', (e) => { if (e.target === $('top') || e.target.id === 'source' || e.target.tagName === 'B') host.zoom(); });
  // the top bar becomes New / Open / Sample / Save / Save as / Reload; downloads and the dev-server write-back are browser things
  for (const [id, text, title] of [['download', 'common.save', 'top.saveTip'], ['writeProject', 'common.saveAs', 'top.saveAsTip'], ['reset', 'top.reload', 'top.reloadTip']]) {
    $(id).dataset.i18n = text; $(id).dataset.i18nTitle = title;
  }
  $('download').onclick = () => saveNow();
  $('writeProject').hidden = false;
  $('writeProject').onclick = () => saveNow({ as: true });
  $('reset').hidden = false;
  $('reset').onclick = () => { if (!sourcePath()) return; if (!unsaved || confirm(t('file.reloadConfirm'))) reloadFromDisk(); };
  $('open').onclick = async () => { if (!unsaved || confirm(t('file.openOtherConfirm'))) openFromApp(await host.open()); };
  host.on('menu', (what) => {
    if (what === 'new') newWorld();
    else if (what === 'open') $('open').onclick();
    else if (what === 'sample') openSample();
    else if (what === 'save') saveNow();
    else if (what === 'saveAs') saveNow({ as: true });
    else if (what === 'reload') $('reset').onclick();
  });
  // a .vspb opened from the system (double-click, Open With, drag onto the dock icon)
  host.on('file:open-request', async ({ path }) => {
    if (path === sourcePath() && !unsaved) return;
    if (unsaved && !confirm(t('file.openOtherConfirm'))) return;
    openFromApp(await host.openPath(path));
  });
  host.on('file:changed', () => {
    if (!unsaved) { reloadFromDisk(); hint(t('file.changedReloaded')); return; }
    showWarning(t('file.changedOnDisk'), [[t('file.reloadFromDisk'), reloadFromDisk], [t('file.keepMine'), () => {}]]);
  });
  host.on('app:save-and-close', async () => { if (await saveNow()) host.closeNow(); });
  host.on('mcp:call', async ({ id, name, args }) => host.toolResult(id, await mcpCall(name, args)));
  host.on('update', renderUpdate);
  host.info().then((i) => renderUpdate(i.update)).catch(() => {});
}
// update states from the shell: a new code bundle (downloads itself, restart to apply) or a new build (installer)
let lastUpdate = null;
function renderUpdate(st) {
  lastUpdate = st;
  const b = $('update');
  b.hidden = !st || st.kind === 'none' || st.kind === 'error';
  if (b.hidden) return;
  const pct = st.progress != null && st.progress < 1 ? ` ${Math.round(st.progress * 100)}%` : '';
  b.disabled = !!pct;
  if (st.kind === 'asar') {
    b.textContent = pct ? t('update.downloadingCode', { v: st.version, pct }) : t('update.restart', { v: st.version });
    b.title = t('update.restartTip');
    b.onclick = async () => { if (!unsaved || (await saveNow())) host.update('restart'); };
  } else {
    b.textContent = pct ? t('update.downloadingShell', { v: st.version, pct }) : t('update.download', { v: st.version });
    b.title = t('update.downloadTip');
    b.onclick = () => host.update('download');
  }
}

// ---------------------------------------------------------------- MCP session: agent edits go through the same undo history
const mcpSession = {
  get doc() { return doc; },
  kinds: KINDS,
  natural: (x, y) => groundSampler(doc.layers.terrain)(x, y),
  graded: (x, y) => world.H?.(x, y) ?? 0,
  info: () => ({ file: sourcePath() ?? sourceLabel(), unsaved, app: true, selection: sel && { kind: sel.kind, title: KINDS[sel.kind].title(sel.rec) } }),
  edit(kind, rec, fn, label) { const tx = beginEdit(kind, rec); fn(rec); refreshFor(kind, rec)(); tx.commit(label); },
  insert(kind, rec, label) { hist.insert(kind, list(kind), rec, undefined, label, refreshFor(kind, rec)); },
  remove(kind, rec, label) { hist.remove(kind, list(kind), rec, label, refreshFor(kind, rec)); },
  roadTx(tx, label) { commitRoadTx(tx, label); },
  terrain(box, fn, label) {
    const T = doc.layers.terrain, blocks = [];
    for (let bj = Math.floor(box[1] / BLOCK); bj <= Math.floor(box[3] / BLOCK); bj++)
      for (let bi = Math.floor(box[0] / BLOCK); bi <= Math.floor(box[2] / BLOCK); bi++) blocks.push({ bi, bj, before: readBlock(T, bi, bj) });
    fn(T.base);
    carveRegion(T, world.roadWorld.net, box);
    for (const b of blocks) b.after = readBlock(T, b.bi, b.bj);
    world.terrainChanged(box); markDirty('terrain');
    hist.custom(label, 'terrain', () => { writeBlocks(T, blocks, 'before'); world.terrainChanged(box); markDirty('terrain'); },
      () => { writeBlocks(T, blocks, 'after'); world.terrainChanged(box); markDirty('terrain'); });
  },
  setDef(group, name, value) {
    const map = groupObj(group), old = map[name] === undefined ? null : clone(map[name]);
    const apply = (v) => { if (v === null) delete map[name]; else map[name] = clone(v); refreshDefs(group, name); renderDefs(); };
    apply(value);
    hist.custom(t('mcp.type', { name: `${group}.${name}` }), 'def', () => apply(old), () => apply(value));
  },
  async save() { if (!(await saveNow())) throw new Error('not saved (busy or the save dialog was cancelled)'); return { file: sourcePath() ?? sourceLabel() }; },
  batch,
  select(kind, rec) { select(kind, rec); focusSel(); },
  undo() { const c = hist.done.at(-1); if (!c) throw new Error('nothing to undo'); hist.undo(); return { undone: c.label }; },
  redo() { const c = hist.undone.at(-1); if (!c) throw new Error('nothing to redo'); hist.redo(); return { redone: c.label }; },
  // aim the camera, hide the panels and let a couple of frames render; the app grabs the window next
  async view(a) {
    if (a.focus) { select(a.focus.kind, a.focus.id !== undefined ? list(a.focus.kind).find((r) => r.id === a.focus.id) : list(a.focus.kind)[a.focus.index]); focusSel(); }
    if (a.camera && a.target) { camera.position.set(...a.camera); controls.target.set(...a.target); controls.update(); }
    else if (a.target) { controls.target.set(...a.target); controls.update(); }
    document.body.classList.add('shot');
    for (let k = 0; k < 3; k++) await new Promise((r) => requestAnimationFrame(r));
    const f = (v) => v.toArray().map((x) => Math.round(x * 10) / 10);
    return { camera: f(camera.position), target: f(controls.target) };
  },
};
async function mcpCall(name, args) {
  if (name === '__ui') { document.body.classList.toggle('shot', !!args.shot); return { content: [{ type: 'text', text: 'ok' }] }; }
  if (!doc) return { isError: true, content: [{ type: 'text', text: 'no world is open' }] };
  return runTool(mcpSession, name, args);
}

function showWarning(text, actions) {
  const box = h('div', { class: 'warn', style: 'position:fixed;top:46px;left:50%;transform:translateX(-50%);z-index:5;background:#2a2112;max-width:620px' }, text, ' ');
  for (const [label, fn] of actions) box.append(h('button', { style: 'margin-left:6px', onclick: () => { box.remove(); fn(); } }, label));
  document.body.append(box);
}

// ---------------------------------------------------------------- refresh after edits
// road records changed: rebuild their asphalt, the roads around them, owned furniture, graded ground
function refreshRoads(recs, { live = false } = {}) {
  if (deferred && !live) { for (const r of recs) deferred.roads.add(r); return; }
  const change = { edges: [], nodes: [], before: [] };
  for (const r of recs) {
    if (r.pts) change.edges.push(r.id); else if (r.p) change.nodes.push(r.id);
    const b = roadBoxes.get(r); if (b) change.before.push(b);
  }
  world.updateRoads(change, { live });
  if (!live) for (const r of recs) if (r.pts) roadBoxes.set(r, bbox(r.pts));
  buildRoadGraph();
}
const roadGroup = (kind, rec) => [rec, ...(KINDS[kind].related?.(rec, doc.layers) ?? [])];
function refreshView(kind, rec, removed = false, opts = {}) {
  const K = KINDS[kind];
  if (deferred && !opts.live && K.rebuild !== 'roads') { if (!deferred.views.has(kind)) deferred.views.set(kind, new Map()); deferred.views.get(kind).set(rec, removed); return; }
  if (K.rebuild === 'blocks' || K.rebuild === 'surfaces') world.touch(K.rebuild, rec, removed);
  else if (K.rebuild === 'roads') refreshRoads(roadGroup(kind, rec), opts);
  else world['build' + K.rebuild[0].toUpperCase() + K.rebuild.slice(1)]();
}
function markRoadsDirty() { markDirty('roads'); markDirty('furniture'); markDirty('terrain'); }
const refreshFor = (kind, rec) => (removed) => {
  refreshView(kind, rec, removed === true);
  if (KINDS[kind].rebuild === 'roads') markRoadsDirty(); else markDirty(KINDS[kind].layer);
  afterChange();
};
// batches (scripts): many edits, one undo step, every derived rebuild once at the end
let deferred = null;
function flushDeferred(d) {
  for (const [kind, recs] of d.views) {
    const K = KINDS[kind];
    if (K.rebuild === 'blocks' || K.rebuild === 'surfaces') {
      const keys = new Set();
      for (const [rec, removed] of recs) for (const k of world.retile(K.rebuild, rec, removed)) keys.add(k);
      for (const k of keys) world.buildTile(K.rebuild, k);
    } else world['build' + K.rebuild[0].toUpperCase() + K.rebuild.slice(1)]();
  }
  if (d.roads.size) refreshRoads([...d.roads]);
}
function deferredRun(fn) {
  if (deferred) return fn();
  deferred = { views: new Map(), roads: new Set() };
  try { return fn(); } finally { const d = deferred; deferred = null; flushDeferred(d); afterChange(); }
}
async function batch(label, fn) {
  if (deferred) return fn();
  const cmds = [];
  hist.push = (c) => cmds.push(c);            // collect the batch's commands instead of recording each
  deferred = { views: new Map(), roads: new Set() };
  try { await fn(); } finally {
    delete hist.push;
    const d = deferred; deferred = null; flushDeferred(d); afterChange();
    if (cmds.length) hist.push({ label, kind: 'batch', undo: () => deferredRun(() => cmds.slice().reverse().forEach((c) => c.undo())),
      redo: () => deferredRun(() => cmds.forEach((c) => c.redo())) });
  }
}

// an undoable edit of a record (and of the records that must move with it)
function beginEdit(kind, rec) {
  return KINDS[kind].related ? hist.beginGroup(kind, roadGroup(kind, rec), refreshFor(kind, rec)) : hist.begin(kind, rec, refreshFor(kind, rec));
}
// a topology edit (RoadTx) as one undo step
function commitRoadTx(tx, label) {
  const res = tx.finish(), recs = [...res.recs];
  const refresh = () => { refreshRoads(recs); markRoadsDirty(); afterChange(); };
  refresh();
  hist.custom(label, 'roads', () => { res.undo(); refresh(); }, () => { res.redo(); refresh(); });
}
function afterChange() {
  if (deferred) return;
  if (sel && !list(sel.kind).includes(sel.rec)) sel = null;
  drawSelection(); renderProps();
}
function onHistory(cmd, mode) {
  updateUndo();
  if (mode !== 'do') hint(t(mode === 'undo' ? 'hist.undone' : 'hist.redone', { what: cmd.label }));
}
function updateUndo() {
  $('undo').disabled = !hist.done.length; $('redo').disabled = !hist.undone.length;
  $('undo').title = t('hist.undoTip') + (hist.done.length ? ': ' + hist.done.at(-1).label : '');
  $('redo').title = t('hist.redoTip');
}

// live preview while dragging: tiled records leave their tile and are drawn alone until the drop
const live = {
  kind: null, rec: null, obj: null, pending: false,
  start(kind, rec) {
    this.kind = kind; this.rec = rec;
    const K = KINDS[kind];
    if (K.rebuild === 'blocks' || K.rebuild === 'surfaces') { world.hidden.add(rec); world.touch(K.rebuild, rec); }
    this.pending = true;
  },
  flush() {
    if (!this.pending || !this.rec) return;
    this.pending = false;
    const K = KINDS[this.kind];
    if (K.rebuild === 'blocks' || K.rebuild === 'surfaces') {
      this.drop();
      this.obj = K.rebuild === 'blocks' ? world.blockTile([this.rec]) : world.surfaceTile([this.rec]);
      scene.add(this.obj);
    } else refreshView(this.kind, this.rec, false, { live: true });
    drawSelection();
  },
  drop() { if (this.obj) { this.obj.traverse((o) => o.isMesh && o.geometry.dispose()); scene.remove(this.obj); this.obj = null; } },
  end() {
    if (!this.rec) return;
    const K = KINDS[this.kind];
    this.drop();
    if (K.rebuild === 'blocks' || K.rebuild === 'surfaces') world.hidden.delete(this.rec);
    refreshView(this.kind, this.rec);
    this.rec = null; this.kind = null; this.pending = false;
  },
};

// ---------------------------------------------------------------- road graph overlay (pick + edit roads)
function buildRoadGraph() {
  roadGraph.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  roadGraph.clear();
  const R = doc.layers.roads;
  if (!R) return;
  for (const e of R.edges ?? []) {
    if (!(e.pts?.length >= 2)) continue;
    const g = new THREE.BufferGeometry().setFromPoints(e.pts.map((p) => new THREE.Vector3(p[0], p[1], (p[2] ?? 0) + 1.2)));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: doc.layers.defs.roadClasses?.[e.cls]?.color ?? '#cccccc', transparent: true, opacity: 0.7 }));
    line.raycast = () => {};
    roadGraph.add(line);
  }
  const np = (R.nodes ?? []).map((n) => new THREE.Vector3(n.p[0], n.p[1], n.p[2] + 1.2));
  const pts = new THREE.Points(new THREE.BufferGeometry().setFromPoints(np), new THREE.PointsMaterial({ color: 0xffffff, size: 5, sizeAttenuation: false }));
  pts.raycast = () => {};
  roadGraph.add(pts);
}

// ---------------------------------------------------------------- picking
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2(), _v = new THREE.Vector3();
function rayAt(ev) {
  ndc.set(ev.clientX / innerWidth * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.ray;
}
function groundHit(r) {
  if (!world?.H) { const t = -r.origin.z / r.direction.z; return t > 0 ? r.origin.clone().addScaledVector(r.direction, t) : null; }
  const o = r.origin, d = r.direction, f = (s) => o.z + d.z * s - ground(o.x + d.x * s, o.y + d.y * s);
  let prev = 0;
  for (let s = 1; s < 40000; s = s * 1.03 + 0.5) {
    if (f(s) <= 0) {
      let a = prev, b = s;
      for (let k = 0; k < 24; k++) { const m = (a + b) / 2; if (f(m) > 0) a = m; else b = m; }
      return o.clone().addScaledVector(d, b);
    }
    prev = s;
  }
  return null;
}
function planeHit(r, z) {
  if (Math.abs(r.direction.z) < 1e-6) return null;
  const t = (z - r.origin.z) / r.direction.z;
  return t > 0 ? r.origin.clone().addScaledVector(r.direction, t) : null;
}
function toScreen(x, y, z) {
  _v.set(x, y, z).project(camera);
  if (_v.z > 1 || _v.z < -1) return null;
  return [(_v.x + 1) / 2 * innerWidth, (1 - _v.y) / 2 * innerHeight];
}
function segDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L)) : 0;
  return [Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy), t];
}
function nearestRoad(sx, sy, px = 9, nodesOnly = false) {
  const R = doc.layers.roads;
  if (!R) return null;
  let best = null, bd = px;
  for (const n of R.nodes ?? []) {
    const s = toScreen(n.p[0], n.p[1], n.p[2] + 1.2);
    if (s) { const d = Math.hypot(s[0] - sx, s[1] - sy); if (d < bd) { bd = d; best = { kind: 'node', rec: n }; } }
  }
  if (best || nodesOnly) return best;
  for (const e of R.edges ?? []) {
    let prev = null;
    for (const p of e.pts) {
      const s = toScreen(p[0], p[1], p[2] + 1.2);
      if (s && prev) { const [d] = segDist(sx, sy, prev, s); if (d < bd) { bd = d; best = { kind: 'edge', rec: e }; } }
      prev = s;
    }
  }
  return best;
}
const PICK = ['roads', 'blocks', 'surfaces', 'furniture', 'trees', 'rails', 'wind', 'trains'];
function pick(ev) {
  const r = rayAt(ev), g = groundHit(r), gd = g ? g.distanceTo(r.origin) : Infinity;
  if (vis.roadGraph) { const nd = nearestRoad(ev.clientX, ev.clientY, 7, true); if (nd) return { ...nd, point: new THREE.Vector3(...nd.rec.p) }; }
  const targets = PICK.filter((n) => vis[n]).map((n) => world.groups[n]);
  for (const hit of ray.intersectObjects(targets, true)) {
    if (hit.distance > gd + 2) break;
    const ud = hit.object.userData, face = hit.instanceId ?? hit.faceIndex;
    const kind = ud.kindOf ? ud.kindOf(face) : ud.kind;
    if (!ud.owner || !KINDS[kind]) continue;
    const rec = ud.owner(face);
    if (rec) return { kind, rec, point: hit.point };
  }
  if (vis.roadGraph || vis.roads) { const rd = nearestRoad(ev.clientX, ev.clientY); if (rd) return { ...rd, point: g }; }
  return { kind: null, rec: null, point: g };
}

// ---------------------------------------------------------------- selection display
const SEL_MAT = new THREE.LineBasicMaterial({ color: 0x34d5ff, depthTest: false, transparent: true });
const HANDLE_MAT = new THREE.PointsMaterial({ color: 0xffffff, size: 8, sizeAttenuation: false, depthTest: false, transparent: true });
const HOVER_MAT = new THREE.PointsMaterial({ color: 0xffd23f, size: 13, sizeAttenuation: false, depthTest: false, transparent: true });
const ringZ = (ring, i, p) => (ring.z ? ring.z(i) + 0.3 : ground(p[0], p[1]) + 0.4);

function select(kind, rec, { tab = true } = {}) {
  sel = kind && rec ? { kind, rec } : null;
  hover = null;
  drawSelection(); renderProps();
  if (sel && tab) showTab('props');
}
function drawSelection() {
  selGroup.traverse((o) => o.geometry?.dispose());
  selGroup.clear(); handles = [];
  if (!sel) return;
  const { kind, rec } = sel, K = KINDS[kind], segs = [];
  if (kind === 'building') {
    for (const p of rec.parts ?? []) for (const ring of [p.p, ...(p.holes ?? [])]) {
      const z0 = p.z ?? 0, z1 = z0 + (p.h ?? 0);
      ring.forEach((a, i) => {
        const b = ring[(i + 1) % ring.length];
        segs.push(a[0], a[1], z0, b[0], b[1], z0, a[0], a[1], z1, b[0], b[1], z1, a[0], a[1], z0, a[0], a[1], z1);
      });
    }
  } else if (K.rings) {
    for (const ring of K.rings(rec)) {
      const n = ring.pts.length, m = ring.closed ? n : n - 1;
      for (let i = 0; i < m; i++) {
        const a = ring.pts[i], b = ring.pts[(i + 1) % n];
        segs.push(a[0], a[1], ringZ(ring, i, a), b[0], b[1], ringZ(ring, (i + 1) % n, b));
      }
    }
  } else {
    const [x, y, z0] = K.center(rec), z = z0 ?? ground(x, y), R = kind === 'wind' ? 12 : 3;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, b = ((k + 1) / 16) * Math.PI * 2;
      segs.push(x + Math.cos(a) * R, y + Math.sin(a) * R, z + 0.3, x + Math.cos(b) * R, y + Math.sin(b) * R, z + 0.3);
    }
    segs.push(x, y, z, x, y, z + (kind === 'wind' ? 120 : 16));
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
  const lines = new THREE.LineSegments(g, SEL_MAT); lines.renderOrder = 10; selGroup.add(lines);
  if (tool === 'select' && K.rings) {
    for (const ring of K.rings(rec)) ring.pts.forEach((p, i) => handles.push({ ring, i, p, z: ringZ(ring, i, p) }));
    const hp = new THREE.BufferGeometry().setFromPoints(handles.map((hd) => new THREE.Vector3(hd.p[0], hd.p[1], hd.z)));
    const pts = new THREE.Points(hp, HANDLE_MAT); pts.renderOrder = 11; selGroup.add(pts);
    if (hover) {
      const hv = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(hover.p[0], hover.p[1], hover.z)]), HOVER_MAT);
      hv.renderOrder = 12; selGroup.add(hv);
    }
  }
}
function nearestHandle(sx, sy, px = 9) {
  let best = null, bd = px;
  for (const hd of handles) {
    const s = toScreen(hd.p[0], hd.p[1], hd.z);
    if (s) { const d = Math.hypot(s[0] - sx, s[1] - sy); if (d < bd) { bd = d; best = hd; } }
  }
  return best;
}
function nearestSegment(sx, sy, px = 8) {
  if (!sel || !KINDS[sel.kind].rings) return null;
  let best = null, bd = px;
  for (const ring of KINDS[sel.kind].rings(sel.rec)) {
    const n = ring.pts.length, m = ring.closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const a = ring.pts[i], b = ring.pts[(i + 1) % n];
      const sa = toScreen(a[0], a[1], ringZ(ring, i, a)), sb = toScreen(b[0], b[1], ringZ(ring, (i + 1) % n, b));
      if (!sa || !sb) continue;
      const [d, t] = segDist(sx, sy, sa, sb);
      if (d < bd) { bd = d; best = { ring, i, t }; }
    }
  }
  return best;
}
// vertices of other rings (stacked parts) at the same spot move together
function linkedVertices(hd) {
  const out = [[hd.ring.pts, hd.i]];
  if (sel.kind === 'edge' && (hd.i === 0 || hd.i === hd.ring.pts.length - 1)) {
    const id = sel.rec.n?.[hd.i === 0 ? 0 : 1], R = doc.layers.roads, nd = R.nodes.find((n) => n.id === id);
    if (nd) out.push([[nd.p], 0]);
    for (const e of R.edges) if (e !== sel.rec) {
      if (e.n?.[0] === id) out.push([e.pts, 0]);
      if (e.n?.[1] === id) out.push([e.pts, e.pts.length - 1]);
    }
    return out;
  }
  if (!KINDS[sel.kind].linked) return out;
  for (const ring of KINDS[sel.kind].rings(sel.rec)) ring.pts.forEach((p, i) => {
    if (p !== hd.p && Math.abs(p[0] - hd.p[0]) < 0.01 && Math.abs(p[1] - hd.p[1]) < 0.01) out.push([ring.pts, i]);
  });
  return out;
}

// ---------------------------------------------------------------- edits on the selection
function editSel(fn, label) {
  if (!sel) return;
  const { kind, rec } = sel, tx = beginEdit(kind, rec);
  fn(rec);
  if (kind === 'furniture') delete rec.owner;     // touched by hand: the road no longer re-places it
  refreshFor(kind, rec)();
  tx.commit(label);
}
function deleteSel() {
  if (!sel) return;
  const { kind, rec } = sel;
  if (kind === 'edge') commitRoadTx(deleteEdge(doc, rec), t('hist.deleteRoad'));
  else if (kind === 'node') commitRoadTx(deleteNode(doc, rec), t('hist.deleteNode'));
  else hist.remove(kind, list(kind), rec, t('hist.delete', { what: KINDS[kind].label }), refreshFor(kind, rec));
  select(null);
}
function profileSel() {
  if (sel?.kind !== 'edge') return;
  editSel((r) => reprofile(doc, groundSampler(doc.layers.terrain), r), t('hist.profile'));
}
function duplicateSel() {
  if (!sel || sel.kind === 'edge' || sel.kind === 'node') return;
  const { kind, rec } = sel, K = KINDS[kind], copy = clone(rec), arr = list(kind);
  K.move(copy, 12, 12, 0);
  if (kind === 'edge' || kind === 'node') copy.id = Math.max(...arr.map((r) => r.id ?? 0)) + 1;
  hist.insert(kind, arr, copy, arr.indexOf(rec) + 1, t('hist.copy', { what: K.label }), refreshFor(kind, copy));
  select(kind, copy);
}
function rotateSel(deg) {
  if (!sel || !KINDS[sel.kind].rotate) return;
  const K = KINDS[sel.kind], [cx, cy] = K.center(sel.rec);
  editSel((r) => K.rotate(r, (deg * Math.PI) / 180, cx, cy), t('hist.rotate', { deg }));
}
function nudgeSel(dx, dy, dz = 0) { if (sel) editSel((r) => KINDS[sel.kind].move(r, dx, dy, dz, doc.layers), t('hist.nudge')); }
const HAS_Z = new Set(['building', 'furniture', 'tree', 'wind']);
function groundSel() {
  if (!sel || !HAS_Z.has(sel.kind)) return;
  const K = KINDS[sel.kind], [x, y, z] = K.center(sel.rec);
  editSel((r) => K.move(r, 0, 0, ground(x, y) - z, doc.layers), t('hist.ground'));
}
function focusSel() {
  if (!sel) return;
  const [x, y, z0] = KINDS[sel.kind].center(sel.rec), z = z0 ?? ground(x, y);
  const off = camera.position.clone().sub(controls.target).setLength(sel.kind === 'edge' || sel.kind === 'rail' ? 900 : 260);
  controls.target.set(x, y, z); camera.position.copy(controls.target).add(off); controls.update();
}

// ---------------------------------------------------------------- creation
function insertNew(kind, rec, label) {
  hist.insert(kind, list(kind), rec, undefined, label, refreshFor(kind, rec));
  select(kind, rec);
}
function finishDraw() {
  if (!draw) return;
  const pts = draw.pts.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 0.5);
  const kind = draw.kind;
  draw = null; drawDraft();
  if (kind === 'road') {
    if (pts.length < 2) return;
    const res = addRoad(doc, groundSampler(doc.layers.terrain), pts, opts.rCls, opts.rName.trim());
    if (!res) { hint(t('road.layFailed')); return; }
    commitRoadTx(res.tx, t('hist.newRoad'));
    return select('edge', res.edge);
  }
  if (kind === 'rail') {
    if (pts.length < 2) return;
    return insertNew('rail', pts.map((p) => [r2(p[0]), r2(p[1]), r2(p[2])]), t('hist.newRail'));
  }
  if (pts.length < 3) return;
  const p2 = pts.map((p) => [r2(p[0]), r2(p[1])]);
  if (kind === 'building') {
    insertNew('building', { type: opts.bType, zone: opts.bZone,
      parts: [{ p: p2, z: r2(Math.min(...pts.map((p) => p[2]))), h: +opts.bH || 10, m: opts.bMat }] }, t('hist.newBuilding'));
  } else insertNew('surface', { p: p2, m: opts.sMat }, t('hist.newSurface'));
}
function drawDraft() {
  draft.traverse((o) => o.geometry?.dispose()); draft.clear();
  if (draw?.pts.length) {
    const pts = [...draw.pts, ...(draw.cursor ? [draw.cursor] : [])].map((p) => new THREE.Vector3(p[0], p[1], p[2] + 0.6));
    if (draw.kind !== 'rail' && draw.kind !== 'road' && pts.length > 2) pts.push(pts[0]);
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), SEL_MAT); l.renderOrder = 10; draft.add(l);
    const d = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), HANDLE_MAT); d.renderOrder = 11; draft.add(d);
  }
  if (tool === 'terrain' && brushAt) {
    const pts = [];
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI * 2, x = brushAt.x + Math.cos(a) * opts.radius, y = brushAt.y + Math.sin(a) * opts.radius;
      pts.push(new THREE.Vector3(x, y, ground(x, y) + 0.8));
    }
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), SEL_MAT); l.renderOrder = 10; draft.add(l);
  }
}

// ---------------------------------------------------------------- terrain brush
let brushAt = null;
const BLOCK = 32;
// the brush shapes the natural ground (terrain.base); the graded terrain (h) is re-derived under it
function strokeStart(p) {
  const T = doc.layers.terrain;
  drag = { type: 'brush', blocks: new Map(), target: groundSampler(T)(p.x, p.y), box: [Infinity, Infinity, -Infinity, -Infinity], last: performance.now(), T };
}
function strokeApply(dt) {
  const s = drag, T = s.T, { nx, ny, x0, y0, res } = T, h = T.base;
  if (!brushAt) return;
  const R = opts.radius, ci = (brushAt.x - x0) / res, cj = (brushAt.y - y0) / res, rc = R / res;
  const i0 = Math.max(Math.floor(ci - rc), 1), i1 = Math.min(Math.ceil(ci + rc), nx - 2);
  const j0 = Math.max(Math.floor(cj - rc), 1), j1 = Math.min(Math.ceil(cj + rc), ny - 2);
  if (i0 > i1 || j0 > j1) return;
  for (let bj = Math.floor(j0 / BLOCK); bj <= Math.floor(j1 / BLOCK); bj++) for (let bi = Math.floor(i0 / BLOCK); bi <= Math.floor(i1 / BLOCK); bi++) {
    const key = bj * 100000 + bi;
    if (s.blocks.has(key)) continue;
    s.blocks.set(key, { bi, bj, before: readBlock(T, bi, bj) });
  }
  const amt = opts.strength * dt;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const d = Math.hypot(i - ci, j - cj) / rc;
    if (d >= 1) continue;
    const w = (1 - d * d) ** 2, k = j * nx + i;
    if (opts.brush === 'raise') h[k] += amt * w;
    else if (opts.brush === 'lower') h[k] -= amt * w;
    else if (opts.brush === 'flatten') h[k] += (s.target - h[k]) * Math.min(1, amt * w * 0.25);
    else {
      const avg = (h[k - 1] + h[k + 1] + h[k - nx] + h[k + nx] + h[k - nx - 1] + h[k - nx + 1] + h[k + nx - 1] + h[k + nx + 1]) / 8;
      h[k] += (avg - h[k]) * Math.min(1, amt * w * 0.3);
    }
  }
  s.box = [Math.min(s.box[0], i0), Math.min(s.box[1], j0), Math.max(s.box[2], i1), Math.max(s.box[3], j1)];
  carveRegion(T, world.roadWorld.net, [i0, j0, i1, j1]);      // roads keep their cuts and embankments
  world.updateTerrain(i0, j0, i1, j1);
}
// a block of both height grids (natural + graded), for undo
function readBlock(T, bi, bj) {
  const out = { base: new Float32Array(BLOCK * BLOCK), h: new Float32Array(BLOCK * BLOCK) };
  for (let j = 0; j < BLOCK; j++) for (let i = 0; i < BLOCK; i++) {
    const gi = bi * BLOCK + i, gj = bj * BLOCK + j;
    if (gi < T.nx && gj < T.ny) { out.base[j * BLOCK + i] = T.base[gj * T.nx + gi]; out.h[j * BLOCK + i] = T.h[gj * T.nx + gi]; }
  }
  return out;
}
function writeBlocks(T, blocks, which) {
  for (const b of blocks) for (let j = 0; j < BLOCK; j++) for (let i = 0; i < BLOCK; i++) {
    const gi = b.bi * BLOCK + i, gj = b.bj * BLOCK + j;
    if (gi < T.nx && gj < T.ny) { T.base[gj * T.nx + gi] = b[which].base[j * BLOCK + i]; T.h[gj * T.nx + gi] = b[which].h[j * BLOCK + i]; }
  }
}
function strokeEnd() {
  const s = drag, T = s.T;
  if (!s.blocks.size) return;
  const blocks = [...s.blocks.values()];
  for (const b of blocks) b.after = readBlock(T, b.bi, b.bj);
  const box = s.box;
  world.terrainChanged(box);
  markDirty('terrain');
  hist.custom(t('hist.terrain', { mode: opts.brush }), 'terrain',
    () => { writeBlocks(T, blocks, 'before'); world.terrainChanged(box); markDirty('terrain'); },
    () => { writeBlocks(T, blocks, 'after'); world.terrainChanged(box); markDirty('terrain'); });
}

// ---------------------------------------------------------------- pointer
const el = renderer.domElement;
let down = null;
el.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || !doc) return;
  down = { x: ev.clientX, y: ev.clientY, alt: ev.altKey };
  if (tool === 'terrain') {
    const g = groundHit(rayAt(ev));
    if (g && doc.layers.terrain) { controls.enabled = false; brushAt = g; strokeStart(g); }
    return;
  }
  if (tool !== 'select' || !sel) return;
  const K = KINDS[sel.kind];
  const hd = nearestHandle(ev.clientX, ev.clientY);
  if (hd && ev.altKey) {                     // Alt+click a vertex: delete it
    const min = hd.ring.closed ? 3 : 2;
    if (hd.ring.pts.length > min) editSel(() => { for (const [pts, i] of linkedVertices(hd).sort((a, b) => b[1] - a[1])) pts.splice(i, 1); }, t('hist.deleteVertex'));
    down = null; return;
  }
  if (!hd && ev.altKey) {                    // Alt+click an edge of the outline: insert a vertex and drag it
    const sg = nearestSegment(ev.clientX, ev.clientY);
    if (sg) {
      const { ring, i, t } = sg, n = ring.pts.length, a = ring.pts[i], b = ring.pts[(i + 1) % n];
      const tx = beginEdit(sel.kind, sel.rec);
      const p = a.map((v, k) => r2(v + (b[k] - v) * t));
      ring.pts.splice(i + 1, 0, p);
      drawSelection();
      const nh = handles.find((x) => x.p === p);
      controls.enabled = false;
      drag = { type: 'vertex', tx, z: nh.z, links: [[ring.pts, i + 1]], label: t('hist.addVertex') };
      live.start(sel.kind, sel.rec);
      down = null; return;
    }
  }
  if (hd) {
    controls.enabled = false;
    drag = { type: 'vertex', tx: beginEdit(sel.kind, sel.rec), z: hd.z, links: linkedVertices(hd), label: t('hist.vertex') };
    // road axes are dense (4 m): neighbouring samples follow the dragged one with a smooth falloff
    const n = hd.ring.pts.length;
    if (sel.kind === 'edge' && opts.soft > 0 && hd.i > 0 && hd.i < n - 1) {
      drag.soft = { pts: hd.ring.pts, i: hd.i, start: hd.ring.pts.map((q) => [...q]), s: cumLength(hd.ring.pts) };
    }
    live.start(sel.kind, sel.rec);
    return;
  }
  const pk = pick(ev);
  if (pk.rec === sel.rec && pk.point && K.move) {
    controls.enabled = false;
    const [cx, cy] = K.center(sel.rec);
    drag = { type: 'move', tx: beginEdit(sel.kind, sel.rec), z: pk.point.z, last: pk.point.clone(), c0: [cx, cy] };
    if (sel.kind === 'furniture') delete sel.rec.owner;
    live.start(sel.kind, sel.rec);
  }
}, { capture: true });

let moveEv = null;
addEventListener('pointermove', (ev) => { moveEv = ev; });
el.addEventListener('dblclick', () => { if (draw) finishDraw(); });
function onMove(ev) {
  if (!doc) return;
  const r = rayAt(ev);
  if (drag?.type === 'vertex') {
    const p = planeHit(r, drag.z); if (!p) return;
    if (drag.soft) {
      const { pts, i, start, s } = drag.soft, dx = p.x - start[i][0], dy = p.y - start[i][1], n = pts.length;
      for (let j = 1; j < n - 1; j++) {
        const w = 1 - smoothstep(0, opts.soft, Math.abs(s[j] - s[i]));
        pts[j][0] = Math.round((start[j][0] + dx * w) * 1000) / 1000; pts[j][1] = Math.round((start[j][1] + dy * w) * 1000) / 1000;
      }
      live.pending = true;
      return;
    }
    for (const [pts, i] of drag.links) { pts[i][0] = r2(p.x); pts[i][1] = r2(p.y); }
    live.pending = true;
    return;
  }
  if (drag?.type === 'move') {
    const p = planeHit(r, drag.z); if (!p) return;
    const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
    if (Math.abs(dx) + Math.abs(dy) < 0.01) return;
    KINDS[sel.kind].move(sel.rec, dx, dy, 0, doc.layers);
    drag.last = p; live.pending = true;
    return;
  }
  const g = groundHit(r);
  $('coords').textContent = g ? `${g.x.toFixed(1)}, ${g.y.toFixed(1)}, ${g.z.toFixed(1)}` : '';
  if (tool === 'terrain') { brushAt = g; drawDraft(); return; }
  if (draw && g) { draw.cursor = [g.x, g.y, g.z]; drawDraft(); return; }
  if (tool === 'select' && handles.length) {
    const hd = nearestHandle(ev.clientX, ev.clientY);
    if (hd !== hover) { hover = hd; drawSelection(); }
  }
}

addEventListener('pointerup', (ev) => {
  if (ev.button !== 0 || !doc) return;
  const wasDrag = drag;
  if (drag?.type === 'brush') { strokeEnd(); drag = null; controls.enabled = true; return; }
  if (drag?.type === 'vertex' || drag?.type === 'move') {
    const K = KINDS[sel.kind];
    if (drag.type === 'move' && opts.snap && HAS_Z.has(sel.kind)) {
      const [x, y] = K.center(sel.rec);
      K.move(sel.rec, 0, 0, ground(x, y) - ground(drag.c0[0], drag.c0[1]), doc.layers);
    }
    const d = drag; drag = null;
    live.end();
    if (d.tx.commit(d.type === 'move' ? t('hist.move', { what: K.label }) : d.label)) { if (K.rebuild === 'roads') markRoadsDirty(); else markDirty(K.layer); }
    controls.enabled = true;
    drawSelection(); renderProps();
    return;
  }
  if (!down || wasDrag || ev.target !== el) { down = null; return; }
  const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4;
  down = null;
  if (moved) return;
  click(ev);
});

function click(ev) {
  const g = groundHit(rayAt(ev));
  if (tool === 'select') { const pk = pick(ev); select(pk.kind, pk.rec); return; }
  if (!g) return;
  if (tool === 'building' || tool === 'surface' || tool === 'rail' || tool === 'road') {
    draw ??= { kind: tool, pts: [] };
    draw.pts.push([g.x, g.y, g.z]);
    drawDraft();
    return;
  }
  if (tool === 'furniture') insertNew('furniture', { t: opts.fType, p: [r2(g.x), r2(g.y), r2(g.z)], h: Math.round((opts.fRot * Math.PI) / 180 * 1000) / 1000 }, t('hist.newObject'));
  else if (tool === 'tree') insertNew('tree', [r2(g.x), r2(g.y), r2(g.z)], t('hist.newTree'));
  else if (tool === 'wind') insertNew('wind', [r2(g.x), r2(g.y), r2(g.z), 0], t('hist.newWind'));
}

// ---------------------------------------------------------------- keyboard
addEventListener('keydown', (ev) => {
  if (ev.target.closest?.('input, textarea, select')) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.code === 'KeyZ') { ev.preventDefault(); if (ev.shiftKey) hist.redo(); else hist.undo(); return; }
  if (mod && ev.code === 'KeyY') { ev.preventDefault(); hist.redo(); return; }
  if (mod && ev.code === 'KeyS') { ev.preventDefault(); saveNow(); return; }
  if (mod && ev.code === 'KeyD') { ev.preventDefault(); duplicateSel(); return; }
  if (mod) return;
  if (draw) {
    if (ev.code === 'Enter') { finishDraw(); return; }
    if (ev.code === 'Escape') { draw = null; drawDraft(); return; }
    if (ev.code === 'Backspace') { draw.pts.pop(); if (!draw.pts.length) draw = null; drawDraft(); return; }
  }
  const tools = ['select', 'road', 'building', 'surface', 'furniture', 'tree', 'wind', 'rail', 'terrain'];
  if (/^Digit[1-9]$/.test(ev.code)) { setTool(tools[+ev.code.slice(5) - 1]); return; }
  if (ev.code === 'Escape') { select(null); return; }
  if (ev.code === 'Delete' || ev.code === 'Backspace') {
    if (hover && sel) {
      const hd = hover, min = hd.ring.closed ? 3 : 2;
      if (hd.ring.pts.length > min) editSel(() => { for (const [pts, i] of linkedVertices(hd).sort((a, b) => b[1] - a[1])) pts.splice(i, 1); }, t('hist.deleteVertex'));
      hover = null; return;
    }
    deleteSel(); return;
  }
  if (ev.code === 'KeyF') focusSel();
  if (ev.code === 'KeyG') groundSel();
  if (ev.code === 'KeyQ') rotateSel(ev.shiftKey ? 1 : 15);
  if (ev.code === 'KeyE') rotateSel(ev.shiftKey ? -1 : -15);
  const step = ev.shiftKey ? 10 : 1;
  if (ev.code === 'ArrowLeft') nudgeSel(-step, 0); if (ev.code === 'ArrowRight') nudgeSel(step, 0);
  if (ev.code === 'ArrowUp') nudgeSel(0, step); if (ev.code === 'ArrowDown') nudgeSel(0, -step);
  if (ev.code === 'PageUp') nudgeSel(0, 0, step); if (ev.code === 'PageDown') nudgeSel(0, 0, -step);
  if (ev.code === 'KeyN') { const on = !world.night; world.setNight(on); hemi.intensity = on ? 0.18 : 1.1; sun.intensity = on ? 0.08 : 1.6; }
});

// ---------------------------------------------------------------- tools panel
const HINTS = {
  select: 'hint.select',
  building: 'hint.outline',
  surface: 'hint.outline',
  rail: 'hint.rail',
  road: 'hint.road',
  furniture: 'hint.furniture',
  tree: 'hint.tree', wind: 'hint.wind',
  terrain: 'hint.terrain',
};
function hint(text) { $('hint').innerHTML = text ?? t(HINTS[tool]); }
function optSelect(label, key, items) {
  return h('label', {}, label, h('select', { onchange: (e) => { opts[key] = e.target.value; saveOpts(); } },
    items.map((v) => h('option', { value: v, selected: opts[key] === v }, v))));
}
function optNum(label, key, attrs = {}) {
  return h('label', {}, label, h('input', { type: 'number', step: 'any', value: opts[key], ...attrs, onchange: (e) => { opts[key] = +e.target.value; saveOpts(); drawDraft(); } }));
}
function setTool(name) {
  if (draw && name !== tool) { draw = null; drawDraft(); }
  tool = name;
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === name);
  const box = $('toolopts'); box.innerHTML = '';
  const d = doc?.layers.defs ?? {}, keys = (o) => Object.keys(o ?? {}).sort();
  if (name === 'select') box.append(h('label', {}, t('opt.onGround'), h('input', { type: 'checkbox', checked: opts.snap, onchange: (e) => { opts.snap = e.target.checked; saveOpts(); } })),
    optNum(t('opt.softness'), 'soft', { min: 0, title: t('opt.softnessTip') }));
  if (name === 'building') box.append(optSelect(t('opt.type'), 'bType', keys(d.buildingTypes)), optSelect(t('opt.zone'), 'bZone', keys(d.zones)), optSelect(t('opt.material'), 'bMat', keys(d.materials)), optNum(t('opt.height'), 'bH', { min: 1 }));
  if (name === 'surface') box.append(optSelect(t('opt.cover'), 'sMat', keys(d.surfaces)));
  if (name === 'road') box.append(optSelect(t('opt.class'), 'rCls', keys(doc?.layers.roads?.classes)),
    h('label', {}, t('opt.name'), h('input', { type: 'text', value: opts.rName, onchange: (e) => { opts.rName = e.target.value; saveOpts(); } })));
  if (name === 'furniture') box.append(optSelect(t('opt.type'), 'fType', keys(d.furniture)), optNum(t('opt.heading'), 'fRot'));
  if (name === 'terrain') box.append(optSelect(t('opt.mode'), 'brush', ['raise', 'lower', 'smooth', 'flatten']), optNum(t('opt.radius'), 'radius', { min: 6 }), optNum(t('opt.strength'), 'strength', { min: 0.1 }));
  if (name !== 'terrain') brushAt = null;
  drawSelection(); drawDraft(); hint();
}
for (const b of document.querySelectorAll('[data-tool]')) b.onclick = () => setTool(b.dataset.tool);

// ---------------------------------------------------------------- side panel
function showTab(name) {
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.pane')) p.classList.toggle('on', p.id === 'pane-' + name);
}
for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => showTab(b.dataset.tab);

function renderProps() {
  const el = $('pane-props'); el.innerHTML = '';
  if (!doc) return;
  if (!sel) {
    const L = doc.layers, n = (k) => (KINDS[k].list(L) ?? []).length;
    el.append(h('div', { class: 'hdr' }, t('props.none')),
      h('p', { class: 'muted' }, t('props.noneHelp')),
      h('div', { class: 'fields' }, Object.keys(KINDS).map((k) => h('div', { class: 'field' }, h('label', {}, KINDS[k].label), h('span', {}, String(n(k)))))));
    return;
  }
  const { kind, rec } = sel, K = KINDS[kind];
  el.append(h('div', { class: 'hdr' }, `${K.label}`), h('div', { class: 'muted' }, K.title(rec) + ` · №${list(kind).indexOf(rec)}`));
  el.append(h('div', { class: 'actions' },
    h('button', { onclick: focusSel, title: 'F' }, t('props.focus')),
    HAS_Z.has(kind) ? h('button', { onclick: groundSel, title: 'G' }, t('props.toGround')) : null,
    K.rotate ? h('button', { onclick: () => rotateSel(15), title: 'Q' }, '⟲ 15°') : null,
    K.rotate ? h('button', { onclick: () => rotateSel(-15), title: 'E' }, '⟳ 15°') : null,
    kind !== 'edge' && kind !== 'node' ? h('button', { onclick: duplicateSel, title: 'Ctrl+D' }, t('common.copy')) : null,
    h('button', { class: 'danger', onclick: deleteSel, title: 'Del' }, t('common.delete'))));
  if (kind === 'edge') {
    el.querySelector('.actions').prepend(h('button', { onclick: profileSel, title: t('props.profileTip') }, t('props.profile')));
    el.append(h('div', { class: 'muted', style: 'margin-bottom:6px' }, t('props.roadDerived')));
  }
  const box = h('div'); el.append(box);
  inspector(box, rec, {
    kind, edit: (fn, label) => editSel(fn, label),
    subKind: (key) => (key === 'parts' ? 'part' : key),
    sugg: (sub, field) => suggestions(doc, sub, field),
  });
}

// ---------------------------------------------------------------- registry editor (defs)
const DEF_GROUPS = [['materials', 'defs.group.materials'], ['buildingTypes', 'defs.group.buildingTypes'], ['zones', 'defs.group.zones'], ['surfaces', 'defs.group.surfaces'],
  ['furniture', 'defs.group.furniture'], ['roadMaterials', 'defs.group.roadMaterials'], ['roadClasses', 'defs.group.roadClasses'], ['roads.classes', 'defs.group.roads.classes']];
// which record fields point at entries of a group (for rename)
const REFS = {
  materials: () => (doc.layers.buildings?.items ?? []).flatMap((b) => b.parts ?? []).map((p) => [p, 'm', 'building', null]),
  surfaces: () => (doc.layers.buildings?.surfaces ?? []).map((s) => [s, 'm', 'surface', s]),
  buildingTypes: () => (doc.layers.buildings?.items ?? []).map((b) => [b, 'type', 'building', b]),
  zones: () => (doc.layers.buildings?.items ?? []).map((b) => [b, 'zone', 'building', b]),
  furniture: () => (doc.layers.furniture?.items ?? []).map((f) => [f, 't', 'furniture', f]),
  'roads.classes': () => (doc.layers.roads?.edges ?? []).map((e) => [e, 'cls', 'edge', e]),
};
let defGroup = 'materials', defName = null, defFilter = '';
const groupObj = (g) => (g === 'roads.classes' ? (doc.layers.roads.classes ??= {}) : (doc.layers.defs[g] ??= {}));
const groupLayer = (g) => (g === 'roads.classes' ? 'roads' : 'defs');
function refreshDefs(g, name) {
  if (g === 'roads.classes') {
    syncClassWidths(doc.layers.roads.classes);
    refreshRoads(doc.layers.roads.edges.filter((e) => name === undefined || e.cls === name));
    markRoadsDirty();
  }
  if (g === 'materials' || g === 'surfaces' || g === 'roadMaterials') world.refreshMaterials();
  if (g === 'buildingTypes') world.buildBlocks();
  if (g === 'furniture') world.buildFurniture();
  if (g === 'roadClasses' || g === 'roads.classes') buildRoadGraph();
  markDirty(groupLayer(g));
  setTool(tool);                         // tool option lists follow the registry
}
function renameDef(g, from, to) {
  const map = groupObj(g);
  if (!to || to === from || map[to]) return;
  const refs = (REFS[g]?.() ?? []).filter(([o, f]) => o[f] === from);
  const swap = (a, b) => {
    const entries = Object.entries(map);
    for (const k of Object.keys(map)) delete map[k];
    for (const [k, v] of entries) map[k === a ? b : k] = v;
    for (const [o, f] of refs) o[f] = b;
    if (g === 'materials' || g === 'buildingTypes' || g === 'zones') world.buildBlocks();
    if (g === 'surfaces') world.buildSurfaces();
    if (g === 'furniture') world.buildFurniture();
    if (g === 'roads.classes') buildRoadGraph();
    for (const [, , kind] of refs) markDirty(KINDS[kind].layer);
    refreshDefs(g); defName = b; renderDefs(); renderProps();
  };
  swap(from, to);
  hist.custom(t('hist.renameType', { from, to }), 'def', () => swap(to, from), () => swap(from, to));
}
function renderDefs() {
  const el = $('pane-defs'); el.innerHTML = '';
  if (!doc) return;
  const map = groupObj(defGroup);
  el.append(h('select', { style: 'width:100%', onchange: (e) => { defGroup = e.target.value; defName = null; renderDefs(); } },
    DEF_GROUPS.map(([k, label]) => h('option', { value: k, selected: k === defGroup }, t(label)))));
  el.append(h('div', { class: 'row', style: 'margin-top:6px' },
    h('input', { type: 'text', placeholder: t('defs.filter'), value: defFilter, style: 'flex:1', oninput: (e) => { defFilter = e.target.value; renderDefList(); } }),
    h('button', { title: t('defs.newTip'), onclick: () => {
      const name = prompt(t('defs.newPrompt'), defName ? defName + '_2' : '');
      if (!name || map[name]) return;
      const rec = clone(defName ? map[defName] : Object.values(map)[0] ?? {});
      const add = () => { map[name] = rec; refreshDefs(defGroup); defName = name; renderDefs(); };
      const del = () => { delete map[name]; refreshDefs(defGroup); defName = null; renderDefs(); };
      add(); hist.custom(t('hist.newType', { name }), 'def', del, add);
    } }, t('defs.new'))));
  const listEl = h('div', { class: 'list' }); el.append(listEl);
  const detail = h('div', { style: 'margin-top:10px' }); el.append(detail);
  function renderDefList() {
    listEl.innerHTML = '';
    for (const name of Object.keys(map).sort()) {
      if (defFilter && !name.includes(defFilter)) continue;
      const c = map[name]?.color;
      listEl.append(h('div', { class: name === defName ? 'on' : '', onclick: () => { defName = name; renderDefs(); } },
        typeof c === 'string' ? h('span', { class: 'sw', style: `background:${c}` }) : null, name));
    }
  }
  renderDefList();
  if (!defName || !map[defName]) return;
  const g = defGroup, name = defName, rec = map[name];
  detail.append(h('div', { class: 'hdr' }, name),
    h('div', { class: 'actions' },
      h('button', { onclick: () => renameDef(g, name, prompt(t('defs.renamePrompt'), name)?.trim()) }, t('defs.rename')),
      h('button', { class: 'danger', onclick: () => {
        const used = (REFS[g]?.() ?? []).filter(([o, f]) => o[f] === name).length;
        if (used && !confirm(t('defs.deleteUsedConfirm', { name, n: used }))) return;
        const del = () => { delete map[name]; refreshDefs(g); defName = null; renderDefs(); };
        const add = () => { map[name] = rec; refreshDefs(g); defName = name; renderDefs(); };
        del(); hist.custom(t('hist.deleteType', { name }), 'def', add, del);
      } }, t('common.delete'))));
  const box = h('div'); detail.append(box);
  const used = (REFS[g]?.() ?? []).filter(([o, f]) => o[f] === name).length;
  if (REFS[g]) detail.prepend(h('div', { class: 'muted', style: 'margin-bottom:4px' }, t('defs.used', { n: used })));
  inspector(box, rec, {
    kind: g,
    subKind: (key) => (g === 'furniture' && key === 'parts' ? 'fpart' : key),
    sugg: (sub, field) => suggestions(doc, sub, field),
    edit: (fn, label) => hist.edit('def', rec, fn, `${name}: ${label}`, () => { refreshDefs(g, name); renderDefs(); }),
  });
}

// ---------------------------------------------------------------- search
let findText = '', findKind = '';
function renderFind() {
  const el = $('pane-find'); el.innerHTML = '';
  if (!doc) return;
  const results = h('div', { class: 'list' });
  const run = () => {
    results.innerHTML = '';
    const q = findText.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let n = 0;
    for (const [kind, K] of Object.entries(KINDS)) {
      if (findKind && kind !== findKind) continue;
      const arr = K.list(doc.layers) ?? [];
      for (let i = 0; i < arr.length && n < 300; i++) {
        const rec = arr[i], text = ((K.search?.(rec) ?? K.label) + ' ' + K.label).toLowerCase();
        if (q.length && !q.every((w) => text.includes(w))) continue;
        n++;
        results.append(h('div', { onclick: () => { select(kind, rec, { tab: false }); focusSel(); } }, h('span', { class: 'muted' }, K.label), K.title(rec)));
      }
    }
    if (n >= 300) results.append(h('div', { class: 'muted' }, t('find.first300')));
  };
  el.append(h('div', { class: 'row' },
    h('input', { type: 'text', placeholder: t('find.placeholder'), value: findText, style: 'flex:1', oninput: (e) => { findText = e.target.value; run(); } }),
    h('select', { onchange: (e) => { findKind = e.target.value; run(); } }, h('option', { value: '' }, t('find.all')),
      Object.entries(KINDS).map(([k, K]) => h('option', { value: k, selected: k === findKind }, K.label)))), results);
  run();
}

// ---------------------------------------------------------------- generators: parameters in, one undo step out
let genId = 'streets';
const genValues = {};                     // last values per generator (kept while the editor is open)
function renderGen() {
  const el = $('pane-gen'); el.innerHTML = '';
  const g = GENERATOR_BY_ID[genId], vals = (genValues[genId] ??= {});
  const options = (q) => (q.options === 'roadClasses' ? Object.keys(doc.layers.roads?.classes ?? {}).sort() : q.options);
  // area centres default to where the camera looks
  for (const q of g.params) if (q.center && vals[q.name] === undefined) vals[q.name] = Math.round(controls.target[q.center] / 10) * 10;
  const form = h('div', { class: 'fields' });
  for (const q of g.params) {
    const v = vals[q.name] ?? q.default;
    let input;
    if (q.type === 'select') input = h('select', { onchange: (e) => { vals[q.name] = e.target.value; } }, options(q).map((o) => h('option', { value: o, selected: o === v }, o)));
    else if (q.type === 'bool') input = h('input', { type: 'checkbox', checked: !!v, onchange: (e) => { vals[q.name] = e.target.checked; } });
    else input = h('input', { type: 'number', step: q.step ?? 'any', min: q.min, max: q.max, value: v, onchange: (e) => { vals[q.name] = +e.target.value; } });
    form.append(h('div', { class: 'field' }, h('label', { title: q.name }, t(`gen.p.${q.name}`)), input));
  }
  const out = h('pre', { hidden: true });
  const run = async () => {
    out.hidden = false; out.className = ''; out.textContent = t('gen.running');
    await new Promise((r) => setTimeout(r, 30));     // let the label paint before a long run
    try {
      const r = await runGenerator(mcpSession, genId, vals, t('gen.undo', { name: t(`gen.${genId}`) }));
      out.textContent = `${JSON.stringify(r.result)}\n${t('gen.done', { n: r.edits, ms: r.ms })}${r.logs.length ? '\n' + r.logs.slice(0, 20).join('\n') : ''}`;
    } catch (e) { out.className = 'err'; out.textContent = String(e.message ?? e); }
  };
  const hasCenter = g.params.some((q) => q.center);
  el.append(
    h('select', { style: 'width:100%', onchange: (e) => { genId = e.target.value; renderGen(); } },
      GENERATORS.map((x) => h('option', { value: x.id, selected: x.id === genId }, t(`gen.${x.id}`)))),
    h('div', { class: 'help' }, t(`gen.${genId}.help`)),
    form,
    h('div', { class: 'actions' }, h('button', { onclick: run }, t('gen.run')),
      hasCenter ? h('button', { title: t('gen.viewCenterTip'), onclick: () => { for (const q of g.params) if (q.center) vals[q.name] = Math.round(controls.target[q.center] / 10) * 10; renderGen(); } }, t('gen.viewCenter')) : null),
    out);
}

// ---------------------------------------------------------------- scripts: JS over the world (same API as the MCP tool run_script)
const SCRIPT_EXAMPLES = {
  'script.ex.byType': `const n = {};
for (const b of world.list('building')) n[b.type] = (n[b.type] ?? 0) + 1;
return Object.entries(n).sort((a, b) => b[1] - a[1]);`,
  'script.ex.towers': `const t = world.find('building', (b) => b.type === 'tower' && b.zone === 'downtown');
for (const { rec } of t) world.edit('building', rec, (b) => b.parts.forEach((p) => { p.h = Math.round(p.h * 1.1 * 100) / 100; }));
return t.length;`,
  'script.ex.roadLength': `const km = {};
for (const e of world.list('edge')) {
  let L = 0; for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]);
  km[e.cls] = Math.round(((km[e.cls] ?? 0) + L / 1000) * 10) / 10;
}
return km;`,
  'script.ex.trees': `const e = world.get('edge', 18), out = [];
for (let i = 4; i < e.pts.length - 4; i += 6) {
  const [x, y] = e.pts[i], [x2, y2] = e.pts[i + 1], L = Math.hypot(x2 - x, y2 - y), nx = -(y2 - y) / L, ny = (x2 - x) / L;
  for (const s of [1, -1]) { const px = x + nx * s * 14, py = y + ny * s * 14; out.push(world.create('tree', [px, py, world.graded(px, py)])); }
}
return out.length;`,
};
let scriptCode = '';
try { scriptCode = localStorage.getItem('vspb-editor-script') ?? SCRIPT_EXAMPLES['script.ex.byType']; } catch { scriptCode = SCRIPT_EXAMPLES['script.ex.byType']; }
function renderScript() {
  const el = $('pane-script'); el.innerHTML = '';
  const area = h('textarea', { class: 'code', spellcheck: 'false' }); area.value = scriptCode;
  const out = h('pre', { hidden: true });
  const run = async () => {
    scriptCode = area.value;
    try { localStorage.setItem('vspb-editor-script', scriptCode); } catch { /* ignore */ }
    out.hidden = false; out.className = ''; out.textContent = t('script.running');
    try {
      const r = await runScript(mcpSession, scriptCode, {}, t('hist.script'), (ss, t) => TOOL_BY_NAME.terrain_edit.run(ss, t));
      let res = r.result; try { res = JSON.stringify(JSON.parse(r.result), null, 1); } catch { /* keep text */ }
      out.textContent = `${r.logs.length ? r.logs.join('\n') + '\n' : ''}→ ${res}\n\n` + t('script.stats', { n: r.edits, ms: r.ms }) + (r.edits ? t('script.undoHint') : '');
    } catch (e) { out.className = 'err'; out.textContent = String(e.message ?? e); }
  };
  area.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    if (e.key === 'Tab') { e.preventDefault(); area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end'); }
  });
  el.append(h('div', { class: 'row', style: 'margin-bottom:6px' },
    h('button', { onclick: run, title: 'Ctrl+Enter' }, t('script.run')),
    h('select', { style: 'flex:1', onchange: (e) => { if (e.target.value) { area.value = SCRIPT_EXAMPLES[e.target.value]; e.target.value = ''; } } },
      h('option', { value: '' }, t('script.examples')), Object.keys(SCRIPT_EXAMPLES).map((k) => h('option', { value: k }, t(k))))),
  area, out,
  h('details', {}, h('summary', {}, 'API'), h('pre', {}, 'async function (world, args) { … }\n\n' + SCRIPT_API)));
}

// ---------------------------------------------------------------- layers
const LAYER_LABELS = { terrain: 'common.terrain', roads: 'layers.roads', roadGraph: 'layers.roadGraph', furniture: 'layers.furniture', blocks: 'layers.blocks',
  surfaces: 'layers.surfaces', trees: 'layers.trees', rails: 'layers.rails', wind: 'layers.wind', trains: 'layers.trains', cables: 'layers.cables', grid: 'layers.grid' };
function applyVisibility() {
  for (const [k, on] of Object.entries(vis)) { const g = k === 'roadGraph' ? roadGraph : world?.groups[k]; if (g) g.visible = on; }
  world?.setGrid(vis.grid);
}
function renderLayers() {
  const el = $('pane-layers'); el.innerHTML = '';
  const box = h('div', { class: 'layers' });
  for (const [k, label] of Object.entries(LAYER_LABELS)) {
    box.append(h('label', {}, h('input', { type: 'checkbox', checked: vis[k], onchange: (e) => { vis[k] = e.target.checked; applyVisibility(); } }), t(label)));
  }
  el.append(box, h('div', { class: 'actions' },
    h('button', { onclick: () => { const on = !world.night; world.setNight(on); hemi.intensity = on ? 0.18 : 1.1; sun.intensity = on ? 0.08 : 1.6; } }, t('layers.dayNight'))));
  if (doc) {
    const info = Object.entries(doc.layers).map(([k]) => `${k}${chunks[k] ? ' · ' + (chunks[k].length / 1e6).toFixed(2) + ' ' + t('common.mb') : ''}`);
    el.append(h('div', { class: 'muted', style: 'margin-top:10px' }, t('layers.fileLayers'), info.join(', ')),
      h('div', { class: 'muted', style: 'margin-top:4px' }, t('layers.format', { v: `${doc.version?.major ?? 1}.${doc.version?.minor ?? 0}` })));
  }
}

// ---------------------------------------------------------------- WASD: fly the camera over the map
// W/S along the view direction, A/D sideways, on the ground plane; faster the higher the camera, Shift ×3
const held = new Set(), FLY = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);
addEventListener('keydown', (ev) => {
  if (ev.target.closest?.('input, textarea, select') || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (FLY.has(ev.code) || ev.key === 'Shift') held.add(ev.code);
});
addEventListener('keyup', (ev) => held.delete(ev.code));
addEventListener('blur', () => held.clear());
const _fwd = new THREE.Vector3(), _move = new THREE.Vector3();
function fly(dt) {
  const f = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0), r = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
  if (!f && !r) return;
  camera.getWorldDirection(_fwd); _fwd.z = 0;
  if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 1, 0);
  _fwd.normalize();
  const speed = camera.position.distanceTo(controls.target) * 0.9 * (held.has('ShiftLeft') || held.has('ShiftRight') ? 3 : 1);
  _move.set(_fwd.x * f + _fwd.y * r, _fwd.y * f - _fwd.x * r, 0).normalize().multiplyScalar(speed * dt);
  camera.position.add(_move); controls.target.add(_move);
}

// ---------------------------------------------------------------- loop
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
let lastT = performance.now();
renderer.setAnimationLoop((ms) => {
  const dt = Math.min((ms - lastT) / 1000, 0.1); lastT = ms;
  if (moveEv) { onMove(moveEv); moveEv = null; }
  if (drag?.type === 'brush') strokeApply(dt);
  if (held.size) fly(dt);
  live.flush();
  for (const f of tickers) f(ms / 1000);
  controls.update();
  renderer.render(scene, camera);
});
addEventListener('beforeunload', (ev) => { if (dirty.size) { saveNow(); ev.preventDefault(); } });

// scripted access (screenshots, console)
window.editor = {
  setView(px, py, pz, tx, ty, tz) { camera.position.set(px, py, pz); controls.target.set(tx, ty, tz); controls.update(); },
  select: (kind, i) => select(kind, kind ? list(kind)[i] : null), get doc() { return doc; }, get world() { return world; }, get sel() { return sel; },
  hist, setTool, saveNow, focus: focusSel, toScreen, handles: () => handles.map((hd) => toScreen(hd.p[0], hd.p[1], hd.z)),
};

// ---------------------------------------------------------------- language
function renderAll() {
  applyDom();
  hint(); updateUndo(); setSaveState(saveState); if (doc) renderSource();
  if (doc) { renderProps(); renderDefs(); renderLayers(); renderFind(); renderScript(); renderGen(); setTool(tool); }
  if (lastUpdate) renderUpdate(lastUpdate);
}
$('lang').append(...Object.entries(LANGS).map(([k, name]) => h('option', { value: k, selected: k === getLang() }, name)));
$('lang').onchange = (e) => setLang(e.target.value);
onLang((l) => { $('lang').value = l; renderAll(); host?.setLang(l); });
document.documentElement.lang = getLang();
host?.setLang(getLang());
applyDom();

setTool('select');
await boot();
