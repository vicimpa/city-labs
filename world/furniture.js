// Roadside furniture placed by the rules in city/docs/ROAD_STANDARDS.md (port of furniture.py).
// Every item carries `owner` ('e<id>' edge / 'n<id>' node) so it can be regenerated when that road
// changes; items without an owner were placed by hand and are never touched.
import { unit, interp, tangents } from './geom.js';
import { URBAN } from './roadnet.js';

const LAMP_RULE = { boulevard: [38, 'both'], avenue: [38, 'stagger'], street: [45, 'one'], lane: [30, 'one'], industrial: [55, 'one'] };
const r = (v, k) => Math.round(v * 10 ** k) / 10 ** k;

/** Stations every `spacing` m inside the trimmed part of an edge (np.arange semantics). */
function walk(e, spacing, start) {
  const s0 = e.trim[0] + 6, s1 = e.L - e.trim[1] - 6;
  if (s1 <= s0) return [];
  const a = s0 + (start ?? spacing / 2), n = Math.max(0, Math.ceil((s1 - a) / spacing)), out = [];
  for (let i = 0; i < n; i++) out.push(a + i * spacing);
  return out;
}
function frame(e, s) {
  const xs = e.xs ??= e.P.map((p) => p[0]), ys = e.ys ??= e.P.map((p) => p[1]);
  const p = [interp(s, e.s, xs), interp(s, e.s, ys)];
  const t = unit([interp(s + 2, e.s, xs) - interp(s - 2, e.s, xs), interp(s + 2, e.s, ys) - interp(s - 2, e.s, ys)]);
  return { p, t, n: [-t[1], t[0]], z: interp(s, e.s, e.z) };
}
const flag = (e, arr, s) => interp(s, e.s, arr) > 0.5;

// numpy.unwrap / numpy.gradient (non-uniform spacing, first-order ends)
function unwrap(a) {
  const out = Float64Array.from(a);
  let corr = 0;
  for (let i = 1; i < a.length; i++) {
    const dd = a[i] - a[i - 1];
    let m = ((dd + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    if (m === -Math.PI && dd > 0) m = Math.PI;
    if (Math.abs(dd) >= Math.PI) corr += m - dd;
    out[i] = a[i] + corr;
  }
  return out;
}
function gradient(f, x) {
  const n = f.length, g = new Float64Array(n);
  if (n < 2) return g;
  g[0] = (f[1] - f[0]) / (x[1] - x[0]);
  g[n - 1] = (f[n - 1] - f[n - 2]) / (x[n - 1] - x[n - 2]);
  for (let i = 1; i < n - 1; i++) {
    const a = x[i] - x[i - 1], b = x[i + 1] - x[i];
    g[i] = (a * a * f[i + 1] - b * b * f[i - 1] + (b * b - a * a) * f[i]) / (a * b * (a + b));
  }
  return g;
}

export function edgeFurniture(e) {
  const out = [], owner = 'e' + e.id;
  const add = (t, p, z, h, kw = {}) => out.push({ t, p: [r(p[0], 2), r(p[1], 2), r(z, 2)], h: r(h, 3), ...kw, owner });
  const c = e.c, cls = e.cls;
  const base = cls.startsWith('fw1') || cls === 'freeway' ? 'freeway' : cls.startsWith('ramp') ? 'ramp' : cls;
  const side = c.side, W = e.hw, WT = e.hwt;
  // street lights and trees in the amenity zone (curb side of the sidewalk)
  if (LAMP_RULE[base]) {
    const [sp, mode] = LAMP_RULE[base];
    walk(e, sp).forEach((s, k) => {
      if (flag(e, e.tunnel, s)) return;
      const { p, n, z } = frame(e, s);
      const sides = mode === 'both' ? [1, -1] : mode === 'stagger' ? [k % 2 ? 1 : -1] : [1];
      for (const sg of sides) {
        const u = W + (side > 0 ? 0.6 : 1.2);
        add('lamp', [p[0] + n[0] * sg * u, p[1] + n[1] * sg * u], z + (side > 0 ? 0.15 : 0), Math.atan2(-n[1] * sg, -n[0] * sg),
          { hgt: base === 'boulevard' || base === 'avenue' ? 11.0 : 8.0 });
      }
    });
    if ((base === 'boulevard' || base === 'avenue') && side >= 4) {
      for (const s of walk(e, 11.0, 5.5)) {
        if (flag(e, e.tunnel, s) || flag(e, e.elev, s)) continue;
        const { p, n, z } = frame(e, s);
        for (const sg of [1, -1]) add('tree', [p[0] + n[0] * sg * (W + 1), p[1] + n[1] * sg * (W + 1)], z + 0.15, 0);
      }
    }
    if (base === 'boulevard') for (const s of walk(e, 12.0)) { const { p, z } = frame(e, s); add('tree', p, z + 0.3, 0); }
    if (base === 'avenue') {
      for (const s of walk(e, 420.0, 200.0)) {
        const { p, t, n, z } = frame(e, s);
        add('bus_stop', [p[0] - n[0] * (WT - 1.2), p[1] - n[1] * (WT - 1.2)], z + 0.15, Math.atan2(t[1], t[0]));
      }
    }
  }
  // freeways: high-mast lights on the outer edge, sign gantries before exits
  if (base === 'freeway') {
    for (const s of walk(e, 60.0)) {
      if (flag(e, e.tunnel, s)) continue;
      const { p, n, z } = frame(e, s);
      add('highmast', [p[0] + n[0] * (W + 0.6), p[1] + n[1] * (W + 0.6)], z, Math.atan2(-n[1], -n[0]));
    }
    for (const s of walk(e, 600.0, 300.0)) {
      if (flag(e, e.tunnel, s)) continue;
      const { p, t, z } = frame(e, s);
      add('gantry', p, z, Math.atan2(t[1], t[0]), { span: r(2 * W + 2, 1) });
    }
  }
  // rural / mountain: delineators, chevrons on tight bends
  if (base === 'rural' || base === 'mountain') {
    for (const s of walk(e, 50.0)) {
      const { p, n, z } = frame(e, s);
      for (const sg of [1, -1]) add('delineator', [p[0] + n[0] * sg * (W + 0.8), p[1] + n[1] * sg * (W + 0.8)], z, 0);
    }
    const tan = tangents(e.P), ang = unwrap(tan.map((q) => Math.atan2(q[1], q[0])));
    const g = gradient(ang, e.s), curv = g.map(Math.abs);
    for (const s of walk(e, 20.0)) {
      if (interp(s, e.s, curv) <= 1 / 80) continue;
      const { p, t, n, z } = frame(e, s), outer = -Math.sign(interp(s, e.s, g));
      add('chevron', [p[0] + n[0] * outer * (W + 1.5), p[1] + n[1] * outer * (W + 1.5)], z, Math.atan2(t[1], t[0]) + Math.PI);
    }
  }
  return out;
}

// junction control: signals where two major roads meet, stop signs on minor arms
export function nodeFurniture(nd) {
  const out = [];
  if (nd.kind !== 'junction') return out;
  const arms = nd.edges.filter(([e]) => URBAN.has(e.cls) || e.cls === 'industrial');
  if (arms.length < 3) return out;
  const prio = arms.map(([e]) => e.c.prio).sort((a, b) => b - a);
  const signal = prio[0] >= 3 && prio[1] >= 3;
  for (const [e, k] of arms) {
    const s = k === 0 ? e.trim[k] + 7 : e.L - e.trim[k] - 7;
    if (!(s > 0 && s < e.L)) continue;
    const { p, t, z } = frame(e, s);
    const inbound = k === 0 ? [-t[0], -t[1]] : t, right = [inbound[1], -inbound[0]];
    const pos = [p[0] + right[0] * (e.hw + 0.7), p[1] + right[1] * (e.hw + 0.7)], head = Math.atan2(-inbound[1], -inbound[0]);
    const it = { p: [r(pos[0], 2), r(pos[1], 2), r(z + 0.15, 2)], h: r(head, 3), owner: 'n' + nd.id };
    if (signal) out.push({ t: 'signal', ...it, reach: r(e.hw * 0.9, 1) });
    else if (e.c.prio < prio[0]) out.push({ t: 'stop_sign', ...it });
  }
  return out;
}

export function allFurniture(net) {
  return [...net.edges.flatMap(edgeFurniture), ...net.nodes.flatMap(nodeFurniture)];
}
