// Undo/redo. Records keep their identity forever: an edit snapshots a record, mutates it in place and
// restores the snapshot on undo, so meshes and selections can hold on to record objects.
export const clone = (v) => structuredClone(v);

export function restore(rec, snap) {
  if (Array.isArray(rec)) { rec.length = 0; rec.push(...clone(snap)); return; }
  for (const k of Object.keys(rec)) delete rec[k];
  Object.assign(rec, clone(snap));
}

export class History {
  constructor(onChange) { this.done = []; this.undone = []; this.onChange = onChange; }
  push(cmd) { this.done.push(cmd); this.undone.length = 0; if (this.done.length > 300) this.done.shift(); this.onChange(cmd, 'do'); }
  undo() { const c = this.done.pop(); if (!c) return; c.undo(); this.undone.push(c); this.onChange(c, 'undo'); }
  redo() { const c = this.undone.pop(); if (!c) return; c.redo(); this.done.push(c); this.onChange(c, 'redo'); }

  /** Start a free-form edit of `rec`; call .commit(label) when done (no-op if nothing changed). */
  begin(kind, rec, refresh) {
    const before = clone(rec);
    return { commit: (label) => {
      const after = clone(rec);
      if (JSON.stringify(before) === JSON.stringify(after)) return false;
      this.push({ label, kind, rec, undo: () => { restore(rec, before); refresh(); }, redo: () => { restore(rec, after); refresh(); } });
      return true;
    }, cancel: () => { restore(rec, before); refresh(); } };
  }
  /** Like begin() over several records that change together (a node and the roads ending at it). */
  beginGroup(kind, recs, refresh) {
    const before = recs.map(clone);
    return { commit: (label) => {
      const after = recs.map(clone);
      if (JSON.stringify(before) === JSON.stringify(after)) return false;
      this.push({ label, kind, rec: recs[0], undo: () => { recs.forEach((r, i) => restore(r, before[i])); refresh(); },
        redo: () => { recs.forEach((r, i) => restore(r, after[i])); refresh(); } });
      return true;
    }, cancel: () => { recs.forEach((r, i) => restore(r, before[i])); refresh(); } };
  }
  /** One-shot edit: fn(rec) mutates. */
  edit(kind, rec, fn, label, refresh) { const t = this.begin(kind, rec, refresh); fn(rec); refresh(); return t.commit(label); }

  insert(kind, list, rec, index, label, refresh) {
    const i = index ?? list.length;
    const add = () => { list.splice(i, 0, rec); refresh(false); }, del = () => { list.splice(list.indexOf(rec), 1); refresh(true); };
    add(); this.push({ label, kind, rec, undo: del, redo: add });
  }
  remove(kind, list, rec, label, refresh) {
    const i = list.indexOf(rec);
    if (i < 0) return;
    const del = () => { list.splice(list.indexOf(rec), 1); refresh(true); }, add = () => { list.splice(i, 0, rec); refresh(false); };
    del(); this.push({ label, kind, rec, undo: add, redo: del });
  }
  /** Generic command with explicit do/undo (already applied). */
  custom(label, kind, undo, redo) { this.push({ label, kind, undo, redo }); }
}
