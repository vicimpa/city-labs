// Top-down map of a world area as an image, for agents (MCP `map`): shaded terrain and water,
// ground patches, roads (bridges outlined, tunnels dashed), junctions, buildings, rails, power lines, trees,
// a coordinate grid and numbered road markers explained in the returned legend.
// Pure JS (no canvas), so it renders the same in Node and in the editor.

// ---------------------------------------------------------------- raster
class Raster {
  constructor(w, h) { this.w = w; this.h = h; this.px = new Uint8ClampedArray(w * h * 4); }
  put(x, y, c, a = 1) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const k = (y * this.w + x) * 4, p = this.px;
    if (a >= 1) { p[k] = c[0]; p[k + 1] = c[1]; p[k + 2] = c[2]; p[k + 3] = 255; return; }
    p[k] += (c[0] - p[k]) * a; p[k + 1] += (c[1] - p[k + 1]) * a; p[k + 2] += (c[2] - p[k + 2]) * a; p[k + 3] = 255;
  }
  /** Even-odd fill of one or more rings of [px, py] points. */
  polygon(rings, c, a = 1) {
    let y0 = Infinity, y1 = -Infinity;
    for (const r of rings) for (const p of r) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(this.h - 1, Math.ceil(y1));
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      const sy = y + 0.5;
      xs.length = 0;
      for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xa, ya] = r[i], [xb, yb] = r[j];
        if ((ya > sy) !== (yb > sy)) xs.push(xa + ((sy - ya) * (xb - xa)) / (yb - ya));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a0 = Math.max(0, Math.round(xs[k])), a1 = Math.min(this.w - 1, Math.round(xs[k + 1]) - 1);
        for (let x = a0; x <= a1; x++) this.put(x, y, c, a);
      }
    }
  }
  disc(cx, cy, r, c, a = 1) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.put(x, y, c, a);
    }
  }
  /** Polyline of width w px with round joins. dash: [on, off] in px. */
  line(pts, w, c, { a = 1, dash = null } = {}) {
    const hw = Math.max(w / 2, 0.5);
    let walked = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-6) continue;
      if (dash && ((walked % (dash[0] + dash[1])) > dash[0])) { walked += L; continue; }
      walked += L;
      const nx = (-(by - ay) / L) * hw, ny = ((bx - ax) / L) * hw;
      this.polygon([[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]], c, a);
      if (hw > 1.2 && !dash) this.disc(bx, by, hw, c, a);
    }
  }
  /** Digits, '-', '.', '#', ' ' in a 3x5 font scaled by s. */
  text(str, x, y, c, s = 2, halo = [255, 255, 255]) {
    const draw = (col, ox, oy) => {
      let cx = x;
      for (const ch of str) {
        const g = FONT[ch];
        if (g) for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) if (g[r] & (4 >> q)) {
          for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) this.put(cx + q * s + dx + ox, y + r * s + dy + oy, col);
        }
        cx += 4 * s;
      }
    };
    if (halo) for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) draw(halo, ox, oy);
    draw(c, 0, 0);
    return str.length * 4 * s;
  }
}
const FONT = {
  0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [7, 1, 7, 4, 7], 3: [7, 1, 7, 1, 7], 4: [5, 5, 7, 1, 1],
  5: [7, 4, 7, 1, 7], 6: [7, 4, 7, 5, 7], 7: [7, 1, 2, 2, 2], 8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 7],
  '-': [0, 0, 7, 0, 0], '.': [0, 0, 0, 0, 2], '#': [5, 7, 5, 7, 5], ' ': [0, 0, 0, 0, 0],
};

// ---------------------------------------------------------------- colours
const hex = (s, d = [255, 0, 255]) => (typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s) ? [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) : d);
const mul = (c, k) => c.map((v) => Math.max(0, Math.min(255, v * k)));
function ground(z) {               // same palette as the 3D terrain (viewer/world3d.js terrainColor)
  if (z < 0.5) return [140, 128, 97];
  if (z < 40) return [(0.28 + z * 0.002) * 255, (0.34 + z * 0.002) * 255, 0.22 * 255];
  if (z < 160) return [(0.33 + (z - 40) * 0.001) * 255, 0.36 * 255, (0.25 + (z - 40) * 0.0008) * 255];
  return [128, 128, 122];
}
const WATER = [24, 58, 84], SIDEWALK = [168, 164, 155], ASPHALT = [52, 55, 60], DECK = [26, 28, 31], RAIL = [96, 88, 78], POWER = [150, 40, 30], HL = [255, 45, 200];

export const MAP_LAYERS = ['terrain', 'surfaces', 'roads', 'buildings', 'rails', 'power', 'trees', 'furniture', 'grid', 'labels'];

/**
 * Render a map. opts: bbox [x0,y0,x1,y1] in metres (y up), width px, layers (default all but
 * furniture), highlight [{rec, kind}], graded(x,y) height sampler, kinds (for centres).
 * Returns { rgba, width, height, legend }.
 */
export function renderMap(doc, { bbox, width = 1024, layers, highlight = [], graded, kinds }) {
  const L = doc.layers, on = new Set(layers ?? MAP_LAYERS.filter((l) => l !== 'furniture'));
  const [x0, y0, x1, y1] = bbox, mpp = (x1 - x0) / width, height = Math.max(1, Math.round((y1 - y0) / mpp));
  const R = new Raster(width, height);
  const P = (x, y) => [(x - x0) / mpp, (y1 - y) / mpp];
  const inView = (pts, pad = 0) => pts.some((p) => p[0] >= x0 - pad && p[0] <= x1 + pad && p[1] >= y0 - pad && p[1] <= y1 + pad);

  // terrain: graded heights, hill-shaded, water below sea level
  if (on.has('terrain') && graded) {
    const e = Math.max(mpp, 2), lx = -0.5, ly = 0.5, lz = 0.7071;
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const x = x0 + (i + 0.5) * mpp, y = y1 - (j + 0.5) * mpp, z = graded(x, y);
      if (z < 0) { R.put(i, j, mul(WATER, 1 + Math.max(z, -30) / 60)); continue; }
      const dx = (graded(x + e, y) - graded(x - e, y)) / (2 * e), dy = (graded(x, y + e) - graded(x, y - e)) / (2 * e);
      const n = Math.hypot(dx, dy, 1), shade = Math.max(0, (-dx * lx - dy * ly + lz) / n);
      R.put(i, j, mul(ground(z), 0.55 + 0.6 * shade));
    }
  } else R.px.fill(235);
  const pad = 50;
  if (on.has('surfaces')) for (const s of L.buildings?.surfaces ?? []) {
    if (!(s.p?.length >= 3) || !inView(s.p, pad)) continue;
    R.polygon([s.p, ...(s.holes ?? [])].map((r) => r.map((q) => P(q[0], q[1]))), hex(L.defs?.surfaces?.[s.m]?.color, [150, 150, 140]));
  }
  if (on.has('rails')) for (const r of L.buildings?.rails ?? []) if (inView(r, pad)) R.line(r.map((q) => P(q[0], q[1])), Math.max(4.8 / mpp, 1.2), RAIL);

  // roads: narrow classes first; bridges get a dark edge, tunnels a dashed centre line
  const legend = { bbox, metres_per_pixel: +mpp.toFixed(3), width, height, roads: [] }, markers = [];
  if (on.has('roads') && L.roads) {
    const cls = (c) => ({ lanes: 1, lane_w: 3.5, shoulder: 1, median: 0, side: 0, ...(L.roads.classes?.[c] ?? {}) });
    const hwOf = (c) => { const k = cls(c); return k.oneway ? (k.lanes * k.lane_w) / 2 + k.shoulder : k.lanes * k.lane_w + k.shoulder + k.median / 2; };
    const edges = (L.roads.edges ?? []).filter((e) => e.pts?.length >= 2 && inView(e.pts, pad)).sort((a, b) => hwOf(a.cls) - hwOf(b.cls));
    const runs = (e, flag, want) => {      // split the axis into runs where flag[i] == want
      const out = []; let cur = [];
      e.pts.forEach((q, i) => { if (!!(e[flag]?.[i]) === want) cur.push(P(q[0], q[1])); else if (cur.length) { if (cur.length > 1) out.push(cur); cur = []; } });
      if (cur.length > 1) out.push(cur);
      return out;
    };
    for (const e of edges) {
      const hw = hwOf(e.cls), side = cls(e.cls).side, open = runs(e, 'tunnel', false);
      for (const r of runs(e, 'elev', true)) R.line(r, (2 * (hw + side) + 2.5) / mpp, DECK);
      if (side > 0) for (const r of open) R.line(r, (2 * (hw + side)) / mpp, SIDEWALK);
      for (const r of open) R.line(r, Math.max((2 * hw) / mpp, 1.5), ASPHALT);
      for (const r of runs(e, 'tunnel', true)) R.line(r, Math.max(1.5, 2 / mpp), [60, 60, 66], { dash: [6, 5] });
    }
    for (const n of L.roads.nodes ?? []) {
      if (n.kind !== 'junction' || !inView([n.p], pad)) continue;
      const arms = edges.filter((e) => e.n?.includes(n.id));
      if (!arms.length) continue;
      const [px, py] = P(n.p[0], n.p[1]);
      R.disc(px, py, (Math.max(...arms.map((e) => hwOf(e.cls))) * 1.25) / mpp, ASPHALT);
    }
    // numbered markers for the longest visible roads (legend maps number -> road); drawn last
    if (on.has('labels')) {
      const vis = edges.map((e) => {
        const inside = e.pts.filter((q) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1);
        return { e, inside };
      }).filter((v) => v.inside.length >= 3).sort((a, b) => b.inside.length - a.inside.length).slice(0, 40);
      vis.forEach(({ e, inside }, k) => {
        const q = inside[inside.length >> 1];
        markers.push([P(q[0], q[1]), String(k + 1)]);
        legend.roads.push({ n: k + 1, id: e.id, name: e.name, cls: e.cls, at: [Math.round(q[0]), Math.round(q[1])] });
      });
    }
  }
  if (on.has('trees')) for (const t of L.buildings?.trees ?? []) {
    if (t[0] < x0 || t[0] > x1 || t[1] < y0 || t[1] > y1) continue;
    const [px, py] = P(t[0], t[1]); R.disc(px, py, Math.max(2.4 / mpp, 0.8), [46, 92, 40]);
  }
  if (on.has('buildings')) {
    const items = (L.buildings?.items ?? []).filter((b) => b.parts?.length && inView(b.parts[0].p ?? [], pad));
    // low first, so towers are drawn over their podiums and neighbours
    const top = (b) => Math.max(...b.parts.map((p) => (p.z ?? 0) + (p.h ?? 0)));
    items.sort((a, b) => top(a) - top(b));
    for (const b of items) for (const part of [...b.parts].sort((p, q) => (p.z + p.h) - (q.z + q.h))) {
      if (!(part.p?.length >= 3)) continue;
      const rings = [part.p, ...(part.holes ?? [])].map((r) => r.map((q) => P(q[0], q[1])));
      R.polygon(rings, mul(hex(L.defs?.materials?.[part.m]?.color, [200, 200, 200]), 0.92));
      if (mpp < 3) R.line([...rings[0], rings[0][0]], 1, [25, 25, 28], { a: 0.55 });
    }
  }
  // power lines: the route, a dot per post
  if (on.has('power')) for (const pl of L.buildings?.powerlines ?? []) {
    if (!(pl.pts?.length >= 2) || !inView(pl.pts, pad)) continue;
    const pp = pl.pts.map((q) => P(q[0], q[1]));
    R.line(pp, 1.2, POWER, { a: 0.85 });
    for (const [px, py] of pp) R.disc(px, py, Math.max((pl.type === 'pole' ? 1 : 4) / mpp, 1.6), POWER);
  }
  if (on.has('furniture')) for (const f of L.furniture?.items ?? []) {
    if (f.p[0] < x0 || f.p[0] > x1 || f.p[1] < y0 || f.p[1] > y1) continue;
    const [px, py] = P(f.p[0], f.p[1]); R.disc(px, py, 1.6, [250, 200, 60]);
  }
  // highlighted records: magenta outline + light fill
  for (const { kind, rec } of highlight) {
    const rings = kind === 'building' ? rec.parts.map((p) => p.p) : rec.p?.[0]?.length ? [rec.p] : rec.pts ? [rec.pts] : null;
    if (rings) for (const r of rings) {
      const pp = r.map((q) => P(q[0], q[1]));
      const open = kind === 'edge' || kind === 'rail' || kind === 'train' || kind === 'powerline';
      if (!open) R.polygon([pp], HL, 0.25);
      R.line(open ? pp : [...pp, pp[0]], 3, HL);
    } else if (kinds?.[kind]) {
      const [x, y] = kinds[kind].center(rec), [px, py] = P(x, y);
      R.disc(px, py, 7, HL); R.disc(px, py, 3, [255, 255, 255]);
    }
  }
  for (const [[px, py], label] of markers) {
    R.disc(px, py, 7 + label.length * 2, [255, 255, 255]); R.disc(px, py, 6 + label.length * 2, [30, 34, 40]);
    R.text(label, Math.round(px - label.length * 4 + 1), Math.round(py - 5), [255, 255, 255], 2, null);
  }
  // coordinate grid with labels in metres along the top and left edges
  if (on.has('grid')) {
    const span = Math.max(x1 - x0, y1 - y0), steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
    const step = steps.find((s) => span / s <= 8) ?? 10000;
    legend.grid_step_m = step;
    for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) {
      const [px] = P(gx, 0);
      for (let j = 0; j < height; j++) R.put(Math.round(px), j, [255, 255, 255], 0.35);
      R.text(String(gx), Math.round(px) + 3, 3, [20, 24, 30]);
    }
    for (let gy = Math.ceil(y0 / step) * step; gy <= y1; gy += step) {
      const [, py] = P(0, gy);
      for (let i = 0; i < width; i++) R.put(i, Math.round(py), [255, 255, 255], 0.35);
      R.text(String(gy), 3, Math.round(py) + 3, [20, 24, 30]);
    }
  }
  // scale bar: a round length about a fifth of the width, bottom left
  const bar = [10, 20, 50, 100, 200, 500, 1000, 2000].reverse().find((m) => m / mpp <= width / 5) ?? 10;
  R.polygon([[[10, height - 16], [10 + bar / mpp, height - 16], [10 + bar / mpp, height - 11], [10, height - 11]]], [255, 255, 255]);
  R.line([[10, height - 13.5], [10 + bar / mpp, height - 13.5]], 2, [20, 24, 30]);
  R.text(String(bar), 14 + Math.round(bar / mpp), height - 20, [20, 24, 30]);
  legend.scale_bar_m = bar;
  for (let k = 3; k < R.px.length; k += 4) R.px[k] = 255;
  return { rgba: R.px, width, height, legend };
}

// ---------------------------------------------------------------- PNG
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** RGBA -> base64 PNG. Browser: OffscreenCanvas; Node: zlib. */
export async function encodePng(rgba, w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), w, h), 0, 0);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const zlib = await import(/* @vite-ignore */ 'node:' + 'zlib');
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
