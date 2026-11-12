// Headless session for mcp/ops.js: the world loaded from a .vspb file, derived data kept up to
// date by world/roadworld.js, written back on save(). Reloads when the file changes on disk and
// nothing here is unsaved.
import fs from 'node:fs';
import path from 'node:path';
import { decodeWorld, encodeWorld, emptyWorld } from '../format/world.js';
import { RoadWorld, bbox } from '../world/roadworld.js';
import { groundSampler, syncClassWidths } from '../world/roadnet.js';
import { carveRegion } from '../world/carve.js';
import { KINDS } from '../editor/kinds.js';
import { History, clone } from '../editor/history.js';
import { prepareRecord, finalizeRecordEdit } from '../editor/commands.js';
import { validateRecord, validateDefChange } from '../format/validate.js';
import { terrainPatch } from '../world/terrain-edit.js';

export class FileSession {
  constructor(file) { this.file = path.resolve(file); this.kinds = KINDS; this.dirty = new Set(); this.doc = null; this.history = new History(); this.revision = 0; this.loading = null; }
  changed(layer) { this.dirty.add(layer); this.revision++; }

  async ready() {
    if (this.loading) return this.loading;
    this.loading = this.load();
    try { return await this.loading; } finally { this.loading = null; }
  }
  async load() {
    const st = fs.statSync(this.file);
    if (this.doc && (this.dirty.size || st.mtimeMs === this.mtime)) return this;
    const revision = this.revision, loaded = await decodeWorld(fs.readFileSync(this.file));
    if (this.doc && this.revision !== revision) return this;
    this.doc = loaded;
    this.roads = new RoadWorld(this.doc);
    this.history.done.length = this.history.undone.length = 0;
    this.mtime = st.mtimeMs;
    return this;
  }
  info() { return { file: this.file, unsaved: [...this.dirty], app: false }; }
  natural = (x, y) => groundSampler(this.doc.layers.terrain)(x, y);
  graded = (x, y) => {
    const t = this.doc.layers.terrain;
    return t ? groundSampler({ ...t, base: t.h })(x, y) : 0;
  };

  /** Run fn with road rebuilds deferred to one update at the end (scripts, bulk edits). */
  async batch(label, fn) {
    if (this.deferred) return fn();
    const commands = [], push = this.history.push;
    const dirtyBefore = new Set(this.dirty);
    this.history.push = (c) => commands.push(c);
    this.deferred = { recs: new Set(), before: [] };
    let failed = false;
    try { await fn(); } catch (error) {
      failed = true; for (const c of commands.slice().reverse()) c.undo(); throw error;
    } finally {
      this.history.push = push;
      const d = this.deferred;
      this.deferred = null;
      if (d.recs.size) this.roadsChanged([...d.recs], d.before);
      if (failed) { this.dirty.clear(); for (const layer of dirtyBefore) this.dirty.add(layer); }
      if (commands.length && !failed) this.history.custom(label, 'batch',
        () => { for (const c of commands.slice().reverse()) c.undo(); },
        () => { for (const c of commands) c.redo(); });
    }
  }
  // road records changed: derived geometry, owned furniture and graded terrain follow
  roadsChanged(recs, before) {
    if (this.deferred) { for (const r of recs) this.deferred.recs.add(r); this.deferred.before.push(...before); return; }
    const change = { edges: [], nodes: [], before };
    for (const r of recs) if (r.pts) change.edges.push(r.id); else if (r.p) change.nodes.push(r.id);
    this.roads.update(change);
    for (const l of ['roads', 'furniture', 'terrain']) this.changed(l);
  }
  edit(kind, rec, fn, label) {
    const K = this.kinds[kind];
    const group = [rec, ...(K.related?.(rec, this.doc.layers) ?? [])];
    const before = group.filter((r) => r.pts).map((r) => bbox(r.pts));
    let after = [];
    const refresh = () => { if (K.rebuild === 'roads') this.roadsChanged(group, [...before, ...after]); else this.changed(K.layer); };
    const tx = this.history.beginGroup(kind, group, refresh);
    const original = clone(rec);
    let refreshing = false;
    try {
      fn(rec); finalizeRecordEdit(this.doc, kind, rec, original); after = group.filter((r) => r.pts).map((r) => bbox(r.pts));
      if (kind === 'furniture') delete rec.owner;
      refreshing = true; refresh(); tx.commit(label ?? `Edit ${kind}`);
    } catch (error) { tx.cancel(refreshing); throw error; }
  }
  insert(kind, rec, label) {
    prepareRecord(kind, rec, this.doc);
    this.history.insert(kind, this.kinds[kind].list(this.doc.layers), rec, undefined, label ?? `Create ${kind}`, () => this.changed(this.kinds[kind].layer));
  }
  remove(kind, rec, label) {
    this.history.remove(kind, this.kinds[kind].list(this.doc.layers), rec, label ?? `Delete ${kind}`, () => this.changed(this.kinds[kind].layer));
  }
  roadTx(tx, label) {
    const before = [...tx.before.entries()].filter(([, s]) => s.pts).map(([, s]) => bbox(s.pts));
    const res = tx.finish();
    for (const r of res.recs) if (r.pts && !tx.before.has(r)) before.push(bbox(r.pts));
    const refresh = () => this.roadsChanged([...res.recs], before);
    refresh(); this.history.custom(label ?? 'Road topology', 'roads', () => { res.undo(); refresh(); }, () => { res.redo(); refresh(); });
  }
  terrain(box, fn, label = 'Terrain edit') {
    const t = this.doc.layers.terrain;
    const { before, after, write } = terrainPatch(t, box, fn);
    const apply = (values) => { write(values); carveRegion(t, this.roads.net, box); this.changed('terrain'); };
    apply(after); this.history.custom(label, 'terrain', () => apply(before), () => apply(after));
  }
  setDef(group, name, value) {
    validateDefChange(this.doc, group, name, value);
    const L = this.doc.layers, map = group === 'roads.classes' ? (L.roads.classes ??= {}) : ((L.defs[group] ??= {}));
    const before = Object.hasOwn(map, name) ? clone(map[name]) : null, after = value === null ? null : clone(value);
    const apply = (v) => {
      if (v === null) delete map[name]; else map[name] = clone(v);
      if (group === 'roads.classes') {
        syncClassWidths(map);
        this.roadsChanged(L.roads.edges.filter((e) => e.cls === name), L.roads.edges.filter((e) => e.cls === name).map((e) => bbox(e.pts)));
      }
      this.changed(group === 'roads.classes' ? 'roads' : 'defs');
    };
    apply(after); this.history.custom(`Resource ${group}.${name}`, 'def', () => apply(before), () => apply(after));
  }
  newWorld(opts, force) {
    if (this.dirty.size && !force) throw new Error('there are unsaved changes: save them or pass force: true');
    this.doc = emptyWorld(opts);
    this.roads = new RoadWorld(this.doc);
    this.history.done.length = this.history.undone.length = 0;
    for (const l of Object.keys(this.doc.layers)) this.changed(l);
  }
  async save() {
    if (this.saving) throw new Error('a save is already in progress');
    if (this.deferred) throw new Error('finish the current transaction before saving');
    this.saving = true;
    const revision = this.revision;
    try {
    const buf = await encodeWorld(this.doc), tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, this.file);
    this.mtime = fs.statSync(this.file).mtimeMs;
    if (revision === this.revision) this.dirty.clear();
    return { file: this.file, bytes: buf.length };
    } finally { this.saving = false; }
  }
  view() { throw new Error('screenshots need the Vespera Editor app (npm run app) with this file open'); }
  select() { throw new Error('selection needs the Vespera Editor app (npm run app)'); }
  undo() { const c = this.history.done.at(-1); if (!c) throw new Error('nothing to undo'); this.history.undo(); return { undone: c.label }; }
  redo() { const c = this.history.undone.at(-1); if (!c) throw new Error('nothing to redo'); this.history.redo(); return { redone: c.label }; }
}
