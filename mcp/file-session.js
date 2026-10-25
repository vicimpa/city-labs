// Headless session for mcp/ops.js: the world loaded from a .vspb file, derived data kept up to
// date by world/roadworld.js, written back on save(). Reloads when the file changes on disk and
// nothing here is unsaved.
import fs from 'node:fs';
import path from 'node:path';
import { decode } from '../format/vspb.js';
import { withDefaults, encodeWorld, emptyWorld } from '../format/world.js';
import { RoadWorld, bbox } from '../world/roadworld.js';
import { groundSampler, syncClassWidths } from '../world/roadnet.js';
import { carveRegion } from '../world/carve.js';
import { KINDS } from '../editor/kinds.js';

export class FileSession {
  constructor(file) { this.file = path.resolve(file); this.kinds = KINDS; this.dirty = new Set(); this.doc = null; }

  async ready() {
    const st = fs.statSync(this.file);
    if (this.doc && (this.dirty.size || st.mtimeMs === this.mtime)) return this;
    this.doc = withDefaults(await decode(fs.readFileSync(this.file)));
    this.roads = new RoadWorld(this.doc);
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
  async batch(_label, fn) {
    if (this.deferred) return fn();
    this.deferred = { recs: new Set(), before: [] };
    try { await fn(); } finally {
      const d = this.deferred;
      this.deferred = null;
      if (d.recs.size) this.roadsChanged([...d.recs], d.before);
    }
  }
  // road records changed: derived geometry, owned furniture and graded terrain follow
  roadsChanged(recs, before) {
    if (this.deferred) { for (const r of recs) this.deferred.recs.add(r); this.deferred.before.push(...before); return; }
    const change = { edges: [], nodes: [], before };
    for (const r of recs) if (r.pts) change.edges.push(r.id); else if (r.p) change.nodes.push(r.id);
    this.roads.update(change);
    for (const l of ['roads', 'furniture', 'terrain']) this.dirty.add(l);
  }
  edit(kind, rec, fn, label) {
    const K = this.kinds[kind];
    if (K.rebuild !== 'roads') { fn(rec); this.dirty.add(K.layer); return; }
    const group = [rec, ...(K.related?.(rec, this.doc.layers) ?? [])];
    const before = group.filter((r) => r.pts).map((r) => bbox(r.pts));
    fn(rec);
    this.roadsChanged(group, before);
  }
  insert(kind, rec) { this.kinds[kind].list(this.doc.layers).push(rec); this.dirty.add(this.kinds[kind].layer); }
  remove(kind, rec) { const arr = this.kinds[kind].list(this.doc.layers); arr.splice(arr.indexOf(rec), 1); this.dirty.add(this.kinds[kind].layer); }
  roadTx(tx) {
    const before = [...tx.before.entries()].filter(([, s]) => s.pts).map(([, s]) => bbox(s.pts));
    const res = tx.finish();
    for (const r of res.recs) if (r.pts && !tx.before.has(r)) before.push(bbox(r.pts));
    this.roadsChanged([...res.recs], before);
  }
  terrain(box, fn) {
    const t = this.doc.layers.terrain;
    fn(t.base);
    carveRegion(t, this.roads.net, box);
    this.dirty.add('terrain');
  }
  setDef(group, name, value) {
    const L = this.doc.layers, map = group === 'roads.classes' ? (L.roads.classes ??= {}) : ((L.defs[group] ??= {}));
    if (value === null) delete map[name]; else map[name] = value;
    if (group === 'roads.classes') {
      syncClassWidths(map);
      this.roadsChanged(L.roads.edges.filter((e) => e.cls === name), L.roads.edges.filter((e) => e.cls === name).map((e) => bbox(e.pts)));
    }
    this.dirty.add(group === 'roads.classes' ? 'roads' : 'defs');
  }
  newWorld(opts, force) {
    if (this.dirty.size && !force) throw new Error('there are unsaved changes: save them or pass force: true');
    this.doc = emptyWorld(opts);
    this.roads = new RoadWorld(this.doc);
    for (const l of Object.keys(this.doc.layers)) this.dirty.add(l);
  }
  async save() {
    const buf = await encodeWorld(this.doc), tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, this.file);
    this.mtime = fs.statSync(this.file).mtimeMs;
    this.dirty.clear();
    return { file: this.file, bytes: buf.length };
  }
  view() { throw new Error('screenshots need the Vespera Editor app (npm run app) with this file open'); }
  select() { throw new Error('selection needs the Vespera Editor app (npm run app)'); }
  undo() { throw new Error('undo needs the Vespera Editor app; headless edits are applied directly (re-open the file to drop unsaved ones)'); }
  redo() { return this.undo(); }
}
