// Vespera world editor: edits the VSPB world in place, keeps a working copy in IndexedDB,
// downloads / writes back .vspb. Scene code is shared with the viewer (viewer/world3d.js).
import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { World3D } from '../viewer/world3d.js';
import { decodeWorld, loadWorld, encodeWorldLayer, assemble, LAYERS } from '../format/world.js';
import { loadWorking, saveWorking, dropWorking } from './store.js';
import { History, clone } from './history.js';
import { KINDS, suggestions } from './kinds.js';
import { RoadTx, addRoad, reprofile, deleteEdge, deleteNode } from './roadedit.js';
import { bbox } from '../world/roadworld.js';
import { syncClassWidths, groundSampler } from '../world/roadnet.js';
import { carveRegion } from '../world/carve.js';
import { cumLength, smoothstep } from '../world/geom.js';
import { runTool } from '../mcp/ops.js';
import { inspector, h } from './inspector.js';

const SRC = '/city/data/vespera.vspb', TILE = 600;
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
let doc = null, world = null, source = '', baseStamp = null;
let chunks = {};                       // layer -> encoded VSPB chunks as last saved
const dirty = new Set();               // layers changed since the last save
const roadBoxes = new Map();           // road record -> bbox of its geometry when the meshes were last built
let sel = null;                        // { kind, rec }
let tool = 'select';
let drag = null;                       // active pointer gesture
let draw = null;                       // polyline being drawn by a create tool
let handles = [], hover = null;        // vertex handles of the selection
const hist = new History(onHistory);
const vis = { terrain: true, roads: true, furniture: true, blocks: true, surfaces: true, trees: true, rails: true, wind: true, trains: true, cables: true, roadGraph: true };

const OPTS = { snap: true, soft: 40, rCls: 'street', rName: '', bType: 'block', bZone: 'midtown', bMat: 'concrete', bH: 18, sMat: 'plaza', fType: 'lamp', fRot: 0,
  brush: 'raise', radius: 40, strength: 6 };
const opts = { ...OPTS };
try { Object.assign(opts, JSON.parse(localStorage.getItem('vspb-editor-opts') ?? '{}')); } catch { /* private mode */ }
const saveOpts = () => { try { localStorage.setItem('vspb-editor-opts', JSON.stringify(opts)); } catch { /* ignore */ } };

const list = (kind) => KINDS[kind].list(doc.layers);
const ground = (x, y) => Math.max(world?.H?.(x, y) ?? 0, 0);

// ---------------------------------------------------------------- load / save
function busy(text) { $('busy').hidden = !text; $('busy').textContent = text || ''; }

async function serverStamp() {
  try {
    const r = await fetch(SRC, { method: 'HEAD', cache: 'no-store' });
    return r.ok ? `${r.headers.get('etag') ?? ''}|${r.headers.get('last-modified') ?? ''}|${r.headers.get('content-length') ?? ''}` : null;
  } catch { return null; }
}

async function boot() {
  busy('загрузка…');
  if (host) return bootApp();
  try {
    const w = await loadWorking().catch(() => null);
    const stamp = await serverStamp();
    if (w) {
      const d = await decodeWorld(await assemble(w.meta ?? {}, w.chunks, w.unknown));
      setDoc(d, w.chunks, `правки из браузера · ${new Date(w.savedAt).toLocaleString()}`, w.baseStamp);
      setSaveState('saved', w.savedAt);
      if (stamp && w.baseStamp && stamp !== w.baseStamp) showWarning('Файл проекта изменился после начала правок (перегенерация?). Правки из браузера его не содержат.',
        [['Загрузить файл проекта', resetToProject], ['Остаться на правках', () => {}]]);
    } else {
      setDoc(await loadWorld(SRC), {}, SRC, stamp);
      setSaveState('clean');
    }
  } catch (e) {
    console.error(e); busy('Ошибка загрузки: ' + e.message); return;
  }
  busy('');
  fetch('/__vspb/ping').then((r) => r.json()).then((j) => { $('writeProject').hidden = !j.vspb; }).catch(() => {});
}

function setDoc(d, ch, src, stamp) {
  if (world) for (const n of ['terrain', 'roads', 'furniture', 'buildings']) scene.remove(world.groups[n]);
  tickers.length = 0;
  doc = d; chunks = { ...ch }; source = src; baseStamp = stamp ?? null;
  dirty.clear(); roadBoxes.clear();
  for (const e of doc.layers.roads?.edges ?? []) roadBoxes.set(e, bbox(e.pts));
  world = new World3D(doc, { anisotropy: renderer.capabilities.getMaxAnisotropy(), tileSize: TILE, tickers }).buildAll();
  for (const n of ['terrain', 'roads', 'furniture', 'buildings']) scene.add(world.groups[n]);
  applyVisibility();
  buildRoadGraph();
  hist.done.length = 0; hist.undone.length = 0;
  sel = null; draw = null; drag = null;
  $('source').textContent = src;
  document.title = 'City Labs — ' + src;
  updateUndo(); renderDefs(); renderLayers(); renderFind(); select(null); setTool(tool);
}

let saveTimer = 0, saving = false, savedAt = 0, unsaved = false;
function setSaveState(s, at) {
  const el = $('save');
  if (at) savedAt = at;
  el.className = s === 'dirty' ? 'dirty' : '';
  const where = host ? 'на диск' : 'в браузере';
  el.textContent = s === 'dirty' ? '● есть несохранённые правки' : s === 'saving' ? 'сохранение…'
    : s === 'clean' ? 'без правок' : `сохранено ${where} ${new Date(savedAt).toLocaleTimeString()}`;
  if (host) {
    unsaved = s === 'dirty' || (s === 'saving' && unsaved);
    host.setDirty(unsaved);
    host.setTitle(`${unsaved ? '● ' : ''}${source.split(/[\\/]/).pop()} — City Labs`);
  }
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
      if (r) { source = r.path; $('source').textContent = source; ok = true; }
      setSaveState(ok ? 'saved' : 'dirty', Date.now());
    } else {
      await saveWorking({ meta: doc.meta ?? {}, chunks, unknown: doc.unknown ?? [], savedAt: Date.now(), baseStamp });
      ok = true;
      setSaveState(dirty.size ? 'dirty' : 'saved', Date.now());
    }
  } catch (e) { console.error(e); $('save').textContent = 'ошибка сохранения: ' + e.message; }
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

$('download').onclick = async () => {
  busy('сборка файла…');
  try {
    const buf = await fileBytes();
    const a = h('a', { href: URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' })), download: 'vespera.vspb' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } finally { busy(''); }
};
$('writeProject').onclick = async () => {
  if (!confirm('Записать текущий мир в city/data/vespera.vspb? Старый файл сохранится как vespera.vspb.bak.')) return;
  busy('запись в проект…');
  try {
    const r = await fetch('/__vspb/save', { method: 'POST', body: await fileBytes() });
    if (!r.ok) throw new Error(await r.text());
    baseStamp = await serverStamp();
    await saveNow();
    hint(`записано в ${SRC}`);
  } catch (e) { alert('Не удалось записать: ' + e.message); } finally { busy(''); }
};
$('open').onclick = () => $('file').click();
$('file').onchange = async (ev) => {
  const f = ev.target.files[0]; ev.target.value = '';
  if (!f) return;
  if (dirty.size && !confirm('Заменить текущий мир файлом ' + f.name + '?')) return;
  busy('чтение ' + f.name + '…');
  try {
    setDoc(await decodeWorld(await f.arrayBuffer()), {}, f.name, baseStamp);
    for (const n of Object.keys(doc.layers)) dirty.add(n);
    await saveNow();
  } catch (e) { alert('Не удалось открыть: ' + e.message); } finally { busy(''); }
};
async function resetToProject() {
  busy('загрузка файла проекта…');
  try {
    await dropWorking();
    const res = await fetch(SRC, { cache: 'no-store' });
    setDoc(await decodeWorld(await res.arrayBuffer()), {}, SRC, await serverStamp());
    setSaveState('clean');
  } catch (e) { alert(e.message); } finally { busy(''); }
}
$('reset').onclick = () => { if (confirm('Выбросить все правки из браузера и загрузить файл проекта?')) resetToProject(); };
$('undo').onclick = () => hist.undo();
$('redo').onclick = () => hist.redo();

// ---------------------------------------------------------------- desktop app: the file on disk
async function bootApp() {
  try {
    const f = await host.current();
    if (!f) { busy('Нет файла мира — откройте .vspb (Cmd+O)'); return; }
    setDoc(await decodeWorld(f.bytes), {}, f.path, null);
    setSaveState('clean');
  } catch (e) { console.error(e); busy('Ошибка загрузки: ' + e.message); return; }
  busy('');
}
async function openFromApp(f) {
  if (!f) return;
  busy('чтение…');
  try { setDoc(await decodeWorld(f.bytes), {}, f.path, null); setSaveState('clean'); } catch (e) { alert('Не удалось открыть: ' + e.message); } finally { busy(''); }
}
const reloadFromDisk = async () => openFromApp(await host.reload());
if (host) {
  // the top bar becomes Save / Save as / Reload; downloads and the dev-server write-back are browser things
  $('download').textContent = 'Сохранить'; $('download').title = 'Сохранить в файл (Cmd+S)';
  $('download').onclick = () => saveNow();
  $('writeProject').hidden = false; $('writeProject').textContent = 'Сохранить как…'; $('writeProject').title = 'Shift+Cmd+S';
  $('writeProject').onclick = () => saveNow({ as: true });
  $('reset').textContent = 'Перечитать'; $('reset').title = 'Загрузить файл с диска заново';
  $('reset').onclick = () => { if (!unsaved || confirm('Выбросить несохранённые правки и перечитать файл?')) reloadFromDisk(); };
  $('open').onclick = async () => { if (!unsaved || confirm('Есть несохранённые правки. Открыть другой файл?')) openFromApp(await host.open()); };
  host.on('menu', (what) => {
    if (what === 'open') $('open').onclick();
    else if (what === 'save') saveNow();
    else if (what === 'saveAs') saveNow({ as: true });
    else if (what === 'reload') $('reset').onclick();
  });
  host.on('file:changed', () => {
    if (!unsaved) { reloadFromDisk(); hint('Файл изменён снаружи — перечитан'); return; }
    showWarning('Файл мира изменён на диске (другой программой).', [['Перечитать с диска', reloadFromDisk], ['Оставить мои правки', () => {}]]);
  });
  host.on('app:save-and-close', async () => { if (await saveNow()) host.closeNow(); });
  host.on('mcp:call', async ({ id, name, args }) => host.toolResult(id, await mcpCall(name, args)));
  host.on('update', renderUpdate);
  host.info().then((i) => renderUpdate(i.update)).catch(() => {});
}
// update states from the shell: a new code bundle (downloads itself, restart to apply) or a new build (installer)
function renderUpdate(st) {
  const b = $('update');
  b.hidden = !st || st.kind === 'none' || st.kind === 'error';
  if (b.hidden) return;
  const pct = st.progress != null && st.progress < 1 ? ` ${Math.round(st.progress * 100)}%` : '';
  b.disabled = !!pct;
  if (st.kind === 'asar') {
    b.textContent = pct ? `Загрузка обновления ${st.version}${pct}` : `Обновление ${st.version} — перезапустить`;
    b.title = 'Новый код редактора загружен; применится после перезапуска';
    b.onclick = async () => { if (!unsaved || (await saveNow())) host.update('restart'); };
  } else {
    b.textContent = pct ? `Скачивание ${st.version}${pct}` : `Новая версия ${st.version} — скачать`;
    b.title = 'Вышла новая сборка приложения: её нужно установить заново';
    b.onclick = () => host.update('download');
  }
}

// ---------------------------------------------------------------- MCP session: agent edits go through the same undo history
const mcpSession = {
  get doc() { return doc; },
  kinds: KINDS,
  natural: (x, y) => groundSampler(doc.layers.terrain)(x, y),
  graded: (x, y) => world.H?.(x, y) ?? 0,
  info: () => ({ file: source, unsaved, app: true, selection: sel && { kind: sel.kind, title: KINDS[sel.kind].title(sel.rec) } }),
  edit(kind, rec, fn, label) { const t = beginEdit(kind, rec); fn(rec); refreshFor(kind, rec)(); t.commit(label); },
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
    hist.custom(`MCP: тип ${group}.${name}`, 'def', () => apply(old), () => apply(value));
  },
  async save() { if (!(await saveNow())) throw new Error('not saved (busy or the save dialog was cancelled)'); return { file: source }; },
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
  if (sel && !list(sel.kind).includes(sel.rec)) sel = null;
  drawSelection(); renderProps();
}
function onHistory(cmd, mode) {
  updateUndo();
  if (mode !== 'do') hint(`${mode === 'undo' ? 'отменено' : 'повторено'}: ${cmd.label}`);
}
function updateUndo() {
  $('undo').disabled = !hist.done.length; $('redo').disabled = !hist.undone.length;
  $('undo').title = 'Отменить (Ctrl+Z)' + (hist.done.length ? ': ' + hist.done.at(-1).label : '');
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
  const { kind, rec } = sel, t = beginEdit(kind, rec);
  fn(rec);
  if (kind === 'furniture') delete rec.owner;     // touched by hand: the road no longer re-places it
  refreshFor(kind, rec)();
  t.commit(label);
}
function deleteSel() {
  if (!sel) return;
  const { kind, rec } = sel;
  if (kind === 'edge') commitRoadTx(deleteEdge(doc, rec), 'удалить дорогу');
  else if (kind === 'node') commitRoadTx(deleteNode(doc, rec), 'удалить узел с дорогами');
  else hist.remove(kind, list(kind), rec, `удалить: ${KINDS[kind].label}`, refreshFor(kind, rec));
  select(null);
}
function profileSel() {
  if (sel?.kind !== 'edge') return;
  editSel((r) => reprofile(doc, groundSampler(doc.layers.terrain), r), 'профиль по рельефу');
}
function duplicateSel() {
  if (!sel || sel.kind === 'edge' || sel.kind === 'node') return;
  const { kind, rec } = sel, K = KINDS[kind], copy = clone(rec), arr = list(kind);
  K.move(copy, 12, 12, 0);
  if (kind === 'edge' || kind === 'node') copy.id = Math.max(...arr.map((r) => r.id ?? 0)) + 1;
  hist.insert(kind, arr, copy, arr.indexOf(rec) + 1, `копия: ${K.label}`, refreshFor(kind, copy));
  select(kind, copy);
}
function rotateSel(deg) {
  if (!sel || !KINDS[sel.kind].rotate) return;
  const K = KINDS[sel.kind], [cx, cy] = K.center(sel.rec);
  editSel((r) => K.rotate(r, (deg * Math.PI) / 180, cx, cy), `поворот ${deg}°`);
}
function nudgeSel(dx, dy, dz = 0) { if (sel) editSel((r) => KINDS[sel.kind].move(r, dx, dy, dz, doc.layers), 'сдвиг'); }
const HAS_Z = new Set(['building', 'furniture', 'tree', 'wind']);
function groundSel() {
  if (!sel || !HAS_Z.has(sel.kind)) return;
  const K = KINDS[sel.kind], [x, y, z] = K.center(sel.rec);
  editSel((r) => K.move(r, 0, 0, ground(x, y) - z, doc.layers), 'на землю');
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
    if (!res) { hint('Не получилось проложить дорогу: слишком коротко или оба конца в одном узле'); return; }
    commitRoadTx(res.tx, 'новая дорога');
    return select('edge', res.edge);
  }
  if (kind === 'rail') {
    if (pts.length < 2) return;
    return insertNew('rail', pts.map((p) => [r2(p[0]), r2(p[1]), r2(p[2])]), 'новый ж/д путь');
  }
  if (pts.length < 3) return;
  const p2 = pts.map((p) => [r2(p[0]), r2(p[1])]);
  if (kind === 'building') {
    insertNew('building', { type: opts.bType, zone: opts.bZone,
      parts: [{ p: p2, z: r2(Math.min(...pts.map((p) => p[2]))), h: +opts.bH || 10, m: opts.bMat }] }, 'новое здание');
  } else insertNew('surface', { p: p2, m: opts.sMat }, 'новая площадка');
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
  hist.custom(`рельеф: ${opts.brush}`, 'terrain',
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
    if (hd.ring.pts.length > min) editSel(() => { for (const [pts, i] of linkedVertices(hd).sort((a, b) => b[1] - a[1])) pts.splice(i, 1); }, 'удалить вершину');
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
      drag = { type: 'vertex', tx, z: nh.z, links: [[ring.pts, i + 1]], label: 'добавить вершину' };
      live.start(sel.kind, sel.rec);
      down = null; return;
    }
  }
  if (hd) {
    controls.enabled = false;
    drag = { type: 'vertex', tx: beginEdit(sel.kind, sel.rec), z: hd.z, links: linkedVertices(hd), label: 'вершина' };
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
    if (d.tx.commit(d.type === 'move' ? `переместить: ${K.label}` : d.label)) { if (K.rebuild === 'roads') markRoadsDirty(); else markDirty(K.layer); }
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
  if (tool === 'furniture') insertNew('furniture', { t: opts.fType, p: [r2(g.x), r2(g.y), r2(g.z)], h: Math.round((opts.fRot * Math.PI) / 180 * 1000) / 1000 }, 'новый объект');
  else if (tool === 'tree') insertNew('tree', [r2(g.x), r2(g.y), r2(g.z)], 'новое дерево');
  else if (tool === 'wind') insertNew('wind', [r2(g.x), r2(g.y), r2(g.z), 0], 'новый ветряк');
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
      if (hd.ring.pts.length > min) editSel(() => { for (const [pts, i] of linkedVertices(hd).sort((a, b) => b[1] - a[1])) pts.splice(i, 1); }, 'удалить вершину');
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
  select: '<b>Клик</b> — выбрать · <b>тянуть выбранное</b> — двигать · <b>тянуть вершину</b> — править контур · <b>Alt+клик</b> по ребру/вершине — добавить/удалить · <b>Q/E</b> поворот · <b>стрелки</b>, PgUp/PgDn сдвиг · <b>G</b> на землю · <b>F</b> фокус · <b>Ctrl+D</b> копия · <b>Del</b> удалить · <b>N</b> ночь',
  building: '<b>Клик</b> — точки контура · <b>двойной клик / Enter</b> — готово · <b>Backspace</b> — убрать точку · <b>Esc</b> — отмена',
  surface: '<b>Клик</b> — точки контура · <b>двойной клик / Enter</b> — готово · <b>Backspace</b> — убрать точку · <b>Esc</b> — отмена',
  rail: '<b>Клик</b> — точки пути · <b>двойной клик / Enter</b> — готово · <b>Esc</b> — отмена',
  road: '<b>Клик</b> — точки оси (углы скругляются радиусом класса) · <b>двойной клик / Enter</b> — готово · концы цепляются к узлам или врезаются в дорогу · <b>Esc</b> — отмена',
  furniture: '<b>Клик</b> — поставить объект выбранного типа',
  tree: '<b>Клик</b> — посадить дерево', wind: '<b>Клик</b> — поставить ветряк',
  terrain: '<b>Тянуть</b> — кисть рельефа · колесо — зум · <b>ПКМ</b> — вращать камеру',
};
function hint(text) { $('hint').innerHTML = text ?? HINTS[tool]; }
function optSelect(label, key, items) {
  return h('label', {}, label, h('select', { onchange: (e) => { opts[key] = e.target.value; saveOpts(); } },
    items.map((v) => h('option', { value: v, selected: opts[key] === v }, v))));
}
function optNum(label, key, attrs = {}) {
  return h('label', {}, label, h('input', { type: 'number', step: 'any', value: opts[key], ...attrs, onchange: (e) => { opts[key] = +e.target.value; saveOpts(); drawDraft(); } }));
}
function setTool(t) {
  if (draw && t !== tool) { draw = null; drawDraft(); }
  tool = t;
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
  const box = $('toolopts'); box.innerHTML = '';
  const d = doc?.layers.defs ?? {}, keys = (o) => Object.keys(o ?? {}).sort();
  if (t === 'select') box.append(h('label', {}, 'по земле', h('input', { type: 'checkbox', checked: opts.snap, onchange: (e) => { opts.snap = e.target.checked; saveOpts(); } })),
    optNum('мягкость оси, м', 'soft', { min: 0, title: 'Насколько далеко за перетаскиваемой точкой дороги тянутся соседние (0 — только она)' }));
  if (t === 'building') box.append(optSelect('тип', 'bType', keys(d.buildingTypes)), optSelect('зона', 'bZone', keys(d.zones)), optSelect('материал', 'bMat', keys(d.materials)), optNum('высота, м', 'bH', { min: 1 }));
  if (t === 'surface') box.append(optSelect('покрытие', 'sMat', keys(d.surfaces)));
  if (t === 'road') box.append(optSelect('класс', 'rCls', keys(doc?.layers.roads?.classes)),
    h('label', {}, 'название', h('input', { type: 'text', value: opts.rName, onchange: (e) => { opts.rName = e.target.value; saveOpts(); } })));
  if (t === 'furniture') box.append(optSelect('тип', 'fType', keys(d.furniture)), optNum('курс, °', 'fRot'));
  if (t === 'terrain') box.append(optSelect('режим', 'brush', ['raise', 'lower', 'smooth', 'flatten']), optNum('радиус, м', 'radius', { min: 6 }), optNum('сила, м/с', 'strength', { min: 0.1 }));
  if (t !== 'terrain') brushAt = null;
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
    el.append(h('div', { class: 'hdr' }, 'Ничего не выбрано'),
      h('p', { class: 'muted' }, 'Кликните объект на карте или найдите его во вкладке «Поиск».'),
      h('div', { class: 'fields' }, Object.keys(KINDS).map((k) => h('div', { class: 'field' }, h('label', {}, KINDS[k].label), h('span', {}, String(n(k)))))));
    return;
  }
  const { kind, rec } = sel, K = KINDS[kind];
  el.append(h('div', { class: 'hdr' }, `${K.label}`), h('div', { class: 'muted' }, K.title(rec) + ` · №${list(kind).indexOf(rec)}`));
  el.append(h('div', { class: 'actions' },
    h('button', { onclick: focusSel, title: 'F' }, 'Фокус'),
    HAS_Z.has(kind) ? h('button', { onclick: groundSel, title: 'G' }, 'На землю') : null,
    K.rotate ? h('button', { onclick: () => rotateSel(15), title: 'Q' }, '⟲ 15°') : null,
    K.rotate ? h('button', { onclick: () => rotateSel(-15), title: 'E' }, '⟳ 15°') : null,
    kind !== 'edge' && kind !== 'node' ? h('button', { onclick: duplicateSel, title: 'Ctrl+D' }, 'Копия') : null,
    h('button', { class: 'danger', onclick: deleteSel, title: 'Del' }, 'Удалить')));
  if (kind === 'edge') {
    el.querySelector('.actions').prepend(h('button', { onclick: profileSel, title: 'Высоты по природному рельефу с привязкой к узлам; эстакады и тоннели по перепаду' }, 'Профиль по рельефу'));
    el.append(h('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Асфальт, разметка, ограждения, опоры, мебель и рельеф вокруг пересчитываются сами. trim и kind узлов — производные.'));
  }
  const box = h('div'); el.append(box);
  inspector(box, rec, {
    kind, edit: (fn, label) => editSel(fn, label),
    subKind: (key) => (key === 'parts' ? 'part' : key),
    sugg: (sub, field) => suggestions(doc, sub, field),
  });
}

// ---------------------------------------------------------------- registry editor (defs)
const DEF_GROUPS = [['materials', 'Материалы зданий'], ['buildingTypes', 'Типы зданий'], ['zones', 'Зоны'], ['surfaces', 'Покрытия площадок'],
  ['furniture', 'Объекты (префабы)'], ['roadMaterials', 'Материалы дорог'], ['roadClasses', 'Цвета классов дорог'], ['roads.classes', 'Классы дорог (генератор)']];
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
  hist.custom(`переименовать ${from} → ${to}`, 'def', () => swap(to, from), () => swap(from, to));
}
function renderDefs() {
  const el = $('pane-defs'); el.innerHTML = '';
  if (!doc) return;
  const map = groupObj(defGroup);
  el.append(h('select', { style: 'width:100%', onchange: (e) => { defGroup = e.target.value; defName = null; renderDefs(); } },
    DEF_GROUPS.map(([k, label]) => h('option', { value: k, selected: k === defGroup }, label))));
  el.append(h('div', { class: 'row', style: 'margin-top:6px' },
    h('input', { type: 'text', placeholder: 'фильтр', value: defFilter, style: 'flex:1', oninput: (e) => { defFilter = e.target.value; renderDefList(); } }),
    h('button', { title: 'Новый тип (копия выбранного)', onclick: () => {
      const name = prompt('Имя нового типа (латиница, без пробелов):', defName ? defName + '_2' : '');
      if (!name || map[name]) return;
      const rec = clone(defName ? map[defName] : Object.values(map)[0] ?? {});
      const add = () => { map[name] = rec; refreshDefs(defGroup); defName = name; renderDefs(); };
      const del = () => { delete map[name]; refreshDefs(defGroup); defName = null; renderDefs(); };
      add(); hist.custom(`новый тип ${name}`, 'def', del, add);
    } }, '+ новый')));
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
      h('button', { onclick: () => renameDef(g, name, prompt('Новое имя:', name)?.trim()) }, 'Переименовать'),
      h('button', { class: 'danger', onclick: () => {
        const used = (REFS[g]?.() ?? []).filter(([o, f]) => o[f] === name).length;
        if (used && !confirm(`Тип «${name}» используется ${used} раз. Удалить всё равно? (объекты станут пурпурными)`)) return;
        const del = () => { delete map[name]; refreshDefs(g); defName = null; renderDefs(); };
        const add = () => { map[name] = rec; refreshDefs(g); defName = name; renderDefs(); };
        del(); hist.custom(`удалить тип ${name}`, 'def', add, del);
      } }, 'Удалить')));
  const box = h('div'); detail.append(box);
  const used = (REFS[g]?.() ?? []).filter(([o, f]) => o[f] === name).length;
  if (REFS[g]) detail.prepend(h('div', { class: 'muted', style: 'margin-bottom:4px' }, `используется: ${used}`));
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
    if (n >= 300) results.append(h('div', { class: 'muted' }, 'показаны первые 300'));
  };
  el.append(h('div', { class: 'row' },
    h('input', { type: 'text', placeholder: 'например: tower downtown', value: findText, style: 'flex:1', oninput: (e) => { findText = e.target.value; run(); } }),
    h('select', { onchange: (e) => { findKind = e.target.value; run(); } }, h('option', { value: '' }, 'все'),
      Object.entries(KINDS).map(([k, K]) => h('option', { value: k, selected: k === findKind }, K.label)))), results);
  run();
}

// ---------------------------------------------------------------- layers
const LAYER_LABELS = { terrain: 'Рельеф', roads: 'Дороги (меш)', roadGraph: 'Граф дорог', furniture: 'Объекты', blocks: 'Здания',
  surfaces: 'Площадки', trees: 'Деревья', rails: 'Ж/д пути', wind: 'Ветряки', trains: 'Поезда', cables: 'ЛЭП' };
function applyVisibility() {
  for (const [k, on] of Object.entries(vis)) { const g = k === 'roadGraph' ? roadGraph : world?.groups[k]; if (g) g.visible = on; }
}
function renderLayers() {
  const el = $('pane-layers'); el.innerHTML = '';
  const box = h('div', { class: 'layers' });
  for (const [k, label] of Object.entries(LAYER_LABELS)) {
    box.append(h('label', {}, h('input', { type: 'checkbox', checked: vis[k], onchange: (e) => { vis[k] = e.target.checked; applyVisibility(); } }), label));
  }
  el.append(box, h('div', { class: 'actions' },
    h('button', { onclick: () => { const on = !world.night; world.setNight(on); hemi.intensity = on ? 0.18 : 1.1; sun.intensity = on ? 0.08 : 1.6; } }, 'День / ночь (N)')));
  if (doc) {
    const info = Object.entries(doc.layers).map(([k]) => `${k}${chunks[k] ? ' · ' + (chunks[k].length / 1e6).toFixed(2) + ' МБ' : ''}`);
    el.append(h('div', { class: 'muted', style: 'margin-top:10px' }, 'Слои файла: ', info.join(', ')),
      h('div', { class: 'muted', style: 'margin-top:4px' }, `Формат VSPB ${doc.version?.major ?? 1}.${doc.version?.minor ?? 0}`));
  }
}

// ---------------------------------------------------------------- loop
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
let lastT = performance.now();
renderer.setAnimationLoop((ms) => {
  const dt = Math.min((ms - lastT) / 1000, 0.1); lastT = ms;
  if (moveEv) { onMove(moveEv); moveEv = null; }
  if (drag?.type === 'brush') strokeApply(dt);
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

setTool('select');
await boot();
