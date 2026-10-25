// What the editor knows about each kind of record: where it lives, how it moves, which outlines it has.
// `rebuild` names the World3D part to redraw: 'blocks' / 'surfaces' are tiled (per-record rebuild),
// the rest are rebuilt whole.
import { edgesAt, followEnd } from './roadedit.js';
import { t } from './i18n.js';

const bbox2 = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return [x0, y0, x1, y1];
};
const mid = (pts) => { const b = bbox2(pts); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; };
const rot = (p, a, cx, cy) => {
  const c = Math.cos(a), s = Math.sin(a), x = p[0] - cx, y = p[1] - cy;
  p[0] = cx + x * c - y * s; p[1] = cy + x * s + y * c;
};
const r2 = (v) => Math.round(v * 100) / 100;
const movePts = (pts, dx, dy, dz = 0) => { for (const p of pts) { p[0] = r2(p[0] + dx); p[1] = r2(p[1] + dy); if (p.length > 2 && dz) p[2] = r2(p[2] + dz); } };
const roundPts = (pts) => { for (const p of pts) { p[0] = r2(p[0]); p[1] = r2(p[1]); } };

const polyKind = (o) => ({ ...o, closed: true });
export const KINDS = {
  building: {
    get label() { return t('kind.building'); }, layer: 'buildings', rebuild: 'blocks', list: (L) => L.buildings.items,
    title: (r) => `${r.type ?? '?'} · ${r.zone ?? ''} · ` + t('kind.building.parts', { n: r.parts?.length ?? 0 }),
    center(r) {
      const all = (r.parts ?? []).flatMap((p) => p.p ?? []);
      const [x, y] = mid(all.length ? all : [[0, 0]]);
      return [x, y, r.parts?.length ? Math.min(...r.parts.map((p) => p.z ?? 0)) : 0];
    },
    move(r, dx, dy, dz) { for (const p of r.parts ?? []) { movePts(p.p, dx, dy); for (const h of p.holes ?? []) movePts(h, dx, dy); p.z = r2((p.z ?? 0) + dz); } },
    rotate(r, a, cx, cy) { for (const p of r.parts ?? []) { for (const q of p.p) rot(q, a, cx, cy); roundPts(p.p); for (const h of p.holes ?? []) { for (const q of h) rot(q, a, cx, cy); roundPts(h); } } },
    rings: (r) => (r.parts ?? []).flatMap((p) => [p.p, ...(p.holes ?? [])].map((pts) => ({ pts, closed: true, z: () => (p.z ?? 0) + (p.h ?? 0) }))),
    linked: true,                         // a vertex shared by stacked parts moves in all of them
    search: (r) => `${r.type} ${r.zone}`,
  },
  surface: polyKind({
    get label() { return t('kind.surface'); }, layer: 'buildings', rebuild: 'surfaces', list: (L) => L.buildings.surfaces,
    title: (r) => `${r.m ?? '?'} · ` + t('kind.surface.vertices', { n: r.p?.length ?? 0 }),
    center: (r) => [...mid(r.p), null],
    move(r, dx, dy) { movePts(r.p, dx, dy); for (const h of r.holes ?? []) movePts(h, dx, dy); },
    rotate(r, a, cx, cy) { for (const q of r.p) rot(q, a, cx, cy); roundPts(r.p); for (const h of r.holes ?? []) { for (const q of h) rot(q, a, cx, cy); roundPts(h); } },
    rings: (r) => [r.p, ...(r.holes ?? [])].map((pts) => ({ pts, closed: true, z: null })),
    search: (r) => `surface ${r.m}`,
  }),
  furniture: {
    get label() { return t('kind.furniture'); }, layer: 'furniture', rebuild: 'furniture', list: (L) => L.furniture.items,
    title: (r) => `${r.t ?? '?'}`,
    center: (r) => [r.p[0], r.p[1], r.p[2]],
    move(r, dx, dy, dz) { r.p = [r2(r.p[0] + dx), r2(r.p[1] + dy), r2(r.p[2] + dz)]; },
    rotate(r, a) { r.h = Math.round(((r.h ?? 0) + a) * 1000) / 1000; },
    search: (r) => `furniture ${r.t}`,
  },
  tree: {
    get label() { return t('kind.tree'); }, layer: 'buildings', rebuild: 'trees', list: (L) => L.buildings.trees,
    title: () => t('kind.tree.title'), center: (r) => [r[0], r[1], r[2]],
    move(r, dx, dy, dz) { r[0] = r2(r[0] + dx); r[1] = r2(r[1] + dy); r[2] = r2(r[2] + dz); },
  },
  wind: {
    get label() { return t('kind.wind'); }, layer: 'buildings', rebuild: 'wind', list: (L) => L.buildings.wind,
    title: () => t('kind.wind.title'), center: (r) => [r[0], r[1], r[2]],
    move(r, dx, dy, dz) { r[0] = r2(r[0] + dx); r[1] = r2(r[1] + dy); r[2] = r2(r[2] + dz); },
  },
  rail: {
    get label() { return t('kind.rail'); }, layer: 'buildings', rebuild: 'rails', list: (L) => L.buildings.rails,
    title: (r) => t('kind.rail.title', { n: r.length }), center: (r) => [...mid(r), null],
    move(r, dx, dy, dz) { movePts(r, dx, dy, dz); },
    rings: (r) => [{ pts: r, closed: false, z: (i) => r[i][2] }],
  },
  train: {
    get label() { return t('kind.train'); }, layer: 'buildings', rebuild: 'trains', list: (L) => L.buildings.trains,
    title: (r) => t(r.closed ? 'kind.train.loop' : 'kind.train.shuttle', { n: r.pts.length }), center: (r) => [...mid(r.pts), null],
    move(r, dx, dy, dz) { movePts(r.pts, dx, dy, dz); },
    rings: (r) => [{ pts: r.pts, closed: !!r.closed, z: (i) => r.pts[i][2] }],
  },
  edge: {
    get label() { return t('kind.edge'); }, layer: 'roads', rebuild: 'roads', list: (L) => L.roads.edges,
    title: (r) => `${r.name ?? ''} · ${r.cls} · #${r.id}`, center: (r) => [...mid(r.pts), null],
    // the whole road moves with its end nodes; other roads at those nodes bend to follow
    move(r, dx, dy, dz, L) {
      movePts(r.pts, dx, dy, dz);
      for (const id of new Set(r.n ?? [])) {
        const nd = L.roads.nodes.find((n) => n.id === id);
        if (nd) nd.p = [r2(nd.p[0] + dx), r2(nd.p[1] + dy), r2(nd.p[2] + dz)];
        for (const e of edgesAt(L.roads, id)) if (e !== r) followEnd(e, e.n[0] === id ? 0 : 1, [dx, dy, dz]);
      }
    },
    related(r, L) {
      const ids = new Set(r.n ?? []);
      return [...L.roads.nodes.filter((n) => ids.has(n.id)), ...L.roads.edges.filter((e) => e !== r && (ids.has(e.n?.[0]) || ids.has(e.n?.[1])))];
    },
    rings: (r) => [{ pts: r.pts, closed: false, z: (i) => r.pts[i][2] }],
    search: (r) => `road ${r.name} ${r.cls} #${r.id}`,
  },
  node: {
    get label() { return t('kind.node'); }, layer: 'roads', rebuild: 'roads', list: (L) => L.roads.nodes,
    title: (r) => t('kind.node.title', { kind: r.kind, id: r.id }), center: (r) => [...r.p],
    move(r, dx, dy, dz, L) {
      r.p = [r2(r.p[0] + dx), r2(r.p[1] + dy), r2(r.p[2] + dz)];
      for (const e of edgesAt(L.roads, r.id)) {
        if (e.n[0] === r.id) followEnd(e, 0, [dx, dy, dz]);
        if (e.n[1] === r.id) followEnd(e, 1, [dx, dy, dz]);
      }
    },
    related: (r, L) => edgesAt(L.roads, r.id),
    search: (r) => `node ${r.kind} #${r.id}`,
  },
};

// fields whose values come from a registry, for suggestions in the inspector
export function suggestions(doc, kind, field) {
  const d = doc.layers.defs ?? {};
  const k = (o) => Object.keys(o ?? {});
  const S = {
    'building.type': k(d.buildingTypes), 'building.zone': k(d.zones), 'part.m': k(d.materials),
    'surface.m': k(d.surfaces), 'furniture.t': k(d.furniture), 'edge.cls': k(doc.layers.roads?.classes),
    'node.kind': ['end', 'transition', 'junction', 'joint'],
    'materials.facade': ['', 'wall', ...k(d.facades)], 'buildingTypes.wall': ['', ...k(d.facades)],
    'facades.style': ['curtain', 'windows', 'brick', 'ribs'],
    'edge.name': [...new Set((doc.layers.roads?.edges ?? []).map((e) => e.name))].slice(0, 400),
    'fpart.k': ['box', 'cyl', 'ico', 'cone'],
  };
  return S[kind + '.' + field];
}

export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
