// Generic property form for any record: every field of the record is shown and editable, including
// fields the editor has never heard of, so new types and attributes need no editor changes.
//   inspector(el, rec, { kind, sugg(sub, field), edit(fn, label) })
// edit(fn) must run fn(rec) inside an undoable command and re-render.

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);
const isColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const isVec = (v) => Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every((x) => typeof x === 'number');

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}
export { h };

let uid = 0;
function numInput(value, onSet, title) {
  return h('input', { type: 'number', step: 'any', value: String(value), title, onchange: (ev) => {
    const v = parseFloat(ev.target.value); if (Number.isFinite(v)) onSet(v); else ev.target.value = String(value);
  } });
}
function jsonBox(value, onSet) {
  const text = JSON.stringify(value);
  const area = h('textarea', { spellcheck: 'false', rows: Math.min(8, Math.max(2, Math.ceil(text.length / 60))) });
  area.value = text.length > 400 ? JSON.stringify(value, null, 1) : text;
  area.addEventListener('change', () => {
    try { onSet(JSON.parse(area.value)); area.classList.remove('bad'); } catch { area.classList.add('bad'); }
  });
  if (text.length <= 4000) return area;
  const n = Array.isArray(value) ? `${value.length} эл.` : `${Object.keys(value).length} полей`;
  const wrap = h('div', {}, h('button', { class: 'link', onclick: () => wrap.replaceWith(area) }, `${n}, ${(text.length / 1024).toFixed(0)} КБ — открыть JSON`));
  return wrap;
}

function valueEditor(obj, key, ctx, sub) {
  const v = obj[key];
  const set = (nv, label = key) => ctx.edit(() => { obj[key] = nv; }, label);
  if (ArrayBuffer.isView(v)) return h('span', { class: 'muted' }, `${v.constructor.name}(${v.length}) — только чтение`);
  if (typeof v === 'boolean') return h('input', { type: 'checkbox', checked: v, onchange: (e) => set(e.target.checked) });
  if (typeof v === 'number') return numInput(v, set);
  if (isColor(v)) {
    return h('span', { class: 'row' },
      h('input', { type: 'color', value: v, onchange: (e) => set(e.target.value) }),
      h('input', { type: 'text', value: v, class: 'short', onchange: (e) => set(e.target.value) }));
  }
  if (typeof v === 'string') {
    const list = ctx.sugg?.(sub, key), id = list ? 'dl' + uid++ : undefined;
    return h('span', { class: 'row grow' },
      h('input', { type: 'text', value: v, list: id, onchange: (e) => set(e.target.value) }),
      list ? h('datalist', { id }, list.map((o) => h('option', { value: o }))) : null);
  }
  if (isVec(v)) return h('span', { class: 'row vec' }, v.map((x, i) => numInput(x, (nx) => { const c = [...v]; c[i] = nx; set(c); }, 'xyzw'[i])));
  if (Array.isArray(v) && v.length && v.every(isRecord)) return recordList(obj, key, ctx);
  return jsonBox(v, set);
}

function recordList(obj, key, ctx) {
  const arr = obj[key], sub = ctx.subKind?.(key) ?? key;
  const box = h('div', { class: 'sublist' });
  arr.forEach((r, i) => {
    box.append(h('div', { class: 'subrec' },
      h('div', { class: 'subhead' }, `${key}[${i}]`,
        h('button', { class: 'mini', title: 'Копия', onclick: () => ctx.edit(() => arr.splice(i + 1, 0, structuredClone(r)), `${key}: копия`) }, '⧉'),
        h('button', { class: 'mini danger', title: 'Удалить', onclick: () => ctx.edit(() => arr.splice(i, 1), `${key}: удалить`) }, '×')),
      fields(r, ctx, sub)));
  });
  return box;
}

function fields(obj, ctx, sub) {
  const box = h('div', { class: 'fields' });
  for (const key of Object.keys(obj)) {
    const v = obj[key], nested = Array.isArray(v) && v.length && v.every(isRecord);
    box.append(h('div', { class: nested ? 'field nested' : 'field' },
      h('label', { title: key }, key,
        h('button', { class: 'mini ghost', title: 'Удалить поле', onclick: () => ctx.edit(() => { delete obj[key]; }, `удалить поле ${key}`) }, '×')),
      valueEditor(obj, key, ctx, sub)));
  }
  // add a field of any name; the value is JSON (number, "text", [1,2], {...})
  const name = h('input', { type: 'text', placeholder: 'новое поле', class: 'short' });
  const val = h('input', { type: 'text', placeholder: 'значение (JSON)' });
  box.append(h('div', { class: 'field add' }, name, h('span', { class: 'row grow' }, val,
    h('button', { class: 'mini', onclick: () => {
      const k = name.value.trim(); if (!k) return;
      let v; try { v = JSON.parse(val.value); } catch { v = val.value; }
      ctx.edit(() => { obj[k] = v; }, `поле ${k}`);
    } }, '+'))));
  return box;
}

export function inspector(el, rec, ctx) {
  el.innerHTML = '';
  if (Array.isArray(rec)) {
    // array records: a point [x,y,z,...] or a polyline [[x,y,z],...]
    if (rec.every((x) => typeof x === 'number')) {
      el.append(h('div', { class: 'fields' }, rec.map((x, i) => h('div', { class: 'field' }, h('label', {}, 'xyzw'[i] ?? i),
        numInput(x, (nv) => ctx.edit((r) => { r[i] = nv; }, 'xyzw'[i] ?? String(i)))))));
    } else {
      el.append(h('div', { class: 'field' }, h('label', {}, 'точки'), jsonBox(rec, (nv) => ctx.edit((r) => { r.length = 0; r.push(...nv); }, 'точки'))));
    }
    return;
  }
  el.append(fields(rec, ctx, ctx.kind));
}
