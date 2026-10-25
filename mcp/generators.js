// Standard generators with parameters: terrain, a street grid, buildings along streets, trees.
// Each runs on the world API of mcp/script.js inside session.batch(), so one run is one undo step
// (Ctrl+Z in the editor) and derived geometry is rebuilt once. Used by the editor's Generators
// tab and the MCP tool `generate`.
import { makeWorld } from './script.js';

// ---------------------------------------------------------------- helpers
function rng(seed) {                       // mulberry32
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Smooth value noise in [-1, 1] with fractal octaves. */
function noise2(seed) {
  const hash = (i, j) => { let h = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295 * 2 - 1; };
  const s = (t) => t * t * (3 - 2 * t);
  const one = (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), u = s(x - i), v = s(y - j);
    const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return (x, y, octaves = 4) => { let sum = 0, amp = 1, f = 1, norm = 0; for (let o = 0; o < octaves; o++) { sum += one(x * f, y * f) * amp; norm += amp; amp *= 0.5; f *= 2.03; } return sum / norm; };
}
const r2 = (v) => Math.round(v * 100) / 100;
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length) % arr.length];

/** Point -> distance to the nearest road edge minus its half width (spatial hash over axis samples). */
function roadClearance(world) {
  const cls = world.layers.roads?.classes ?? {}, cell = 40, H = new Map();
  for (const e of world.list('edge')) {
    const c = cls[e.cls] ?? {}, w = c.hwt ?? 6;
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const k = Math.floor(e.pts[i][0] / cell) + ',' + Math.floor(e.pts[i][1] / cell);
      let b = H.get(k); if (!b) H.set(k, b = []); b.push([e.pts[i], e.pts[i + 1], w]);
    }
  }
  return (x, y) => {
    let best = Infinity;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (const [a, b, w] of H.get((gx + dx) + ',' + (gy + dy)) ?? []) {
      const abx = b[0] - a[0], aby = b[1] - a[1], L2 = abx * abx + aby * aby || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * abx + (y - a[1]) * aby) / L2));
      best = Math.min(best, Math.hypot(x - a[0] - abx * t, y - a[1] - aby * t) - w);
    }
    return best;
  };
}
/** Occupancy of building footprints (axis-aligned boxes in a hash), for overlap tests. */
function footprints(world) {
  const cell = 50, H = new Map(), boxes = [];
  const add = (pts) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const b = [x0, y0, x1, y1]; boxes.push(b);
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++) {
      const k = i + ',' + j; let l = H.get(k); if (!l) H.set(k, l = []); l.push(b);
    }
  };
  for (const b of world.list('building')) for (const p of b.parts ?? []) if (p.p?.length) add(p.p);
  const hits = (pts, pad = 0) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    for (let i = Math.floor((x0 - pad) / cell); i <= Math.floor((x1 + pad) / cell); i++) for (let j = Math.floor((y0 - pad) / cell); j <= Math.floor((y1 + pad) / cell); j++) {
      for (const b of H.get(i + ',' + j) ?? []) if (x0 - pad < b[2] && b[0] < x1 + pad && y0 - pad < b[3] && b[1] < y1 + pad) return true;
    }
    return false;
  };
  return { add, hits };
}

// building presets per zone: types, floors, lot (frontage × depth, m), materials
const ZONES = {
  downtown: { types: ['tower', 'podium_tower', 'block'], floors: [10, 34], lot: [40, 34], mats: ['glass_blue', 'glass_teal', 'glass_dark', 'glass_silver', 'concrete'] },
  midtown: { types: ['block', 'l_block', 'stepped'], floors: [5, 12], lot: [30, 28], mats: ['brick', 'brick_dark', 'plaster_beige', 'concrete', 'glass_silver'] },
  residential: { types: ['block', 'house'], floors: [3, 7], lot: [26, 20], mats: ['plaster_white', 'plaster_beige', 'plaster_peach', 'plaster_mint', 'brick'] },
  suburb: { types: ['house'], floors: [1, 2], lot: [20, 12], mats: ['plaster_white', 'plaster_beige', 'plaster_peach', 'plaster_mint'], roofs: ['roof_red', 'roof_brown', 'roof_grey'] },
  industrial: { types: ['warehouse'], floors: [2, 4], lot: [48, 36], mats: ['metal_roof', 'metal_blue', 'concrete'] },
};
const FLOOR = 3.3;

// ---------------------------------------------------------------- generators
export const GENERATORS = [
  {
    id: 'terrain',
    params: [
      { name: 'amplitude', type: 'number', default: 40, min: 0, max: 400, step: 5 },
      { name: 'wavelength', type: 'number', default: 900, min: 100, max: 5000, step: 50 },
      { name: 'octaves', type: 'number', default: 5, min: 1, max: 8, step: 1 },
      { name: 'base', type: 'number', default: 12, min: -50, max: 200, step: 1 },
      { name: 'island', type: 'bool', default: true },
      { name: 'mode', type: 'select', default: 'replace', options: ['replace', 'add'] },
      { name: 'seed', type: 'number', default: 1, min: 0, max: 999999, step: 1 },
    ],
    run(world, p) {
      const n = noise2(p.seed | 0);
      world.shapeTerrain((base, t) => {
        const w = (t.nx - 1) * t.res, h = (t.ny - 1) * t.res, cx = t.x0 + w / 2, cy = t.y0 + h / 2;
        for (let j = 0; j < t.ny; j++) for (let i = 0; i < t.nx; i++) {
          const x = t.x0 + i * t.res, y = t.y0 + j * t.res, k = j * t.nx + i;
          // hills rise from the base level (mostly gentle, a few high): no lakes inland, the sea only at an island's edge
          const v = n(x / p.wavelength, y / p.wavelength, p.octaves | 0), relief = ((v + 1) / 2) ** 1.6 * p.amplitude;
          let z = (p.mode === 'add' ? base[k] : p.base) + relief;
          if (p.island) {                     // the land falls into the sea towards the map edges, along a ragged coast
            const d = Math.max(Math.abs(x - cx) / (w / 2), Math.abs(y - cy) / (h / 2)) + n(x / 700 + 31, y / 700 - 17, 3) * 0.12;
            const f = Math.min(1, Math.max(0, (0.92 - d) / 0.22));
            z = z * f - 18 * (1 - f) ** 1.5;
          }
          base[k] = r2(z);
        }
      });
      return { cells: world.layers.terrain.nx * world.layers.terrain.ny };
    },
  },
  {
    id: 'streets',
    params: [
      { name: 'cx', type: 'number', default: 0, step: 10, center: 'x' },
      { name: 'cy', type: 'number', default: 0, step: 10, center: 'y' },
      { name: 'width', type: 'number', default: 900, min: 100, max: 4000, step: 50 },
      { name: 'height', type: 'number', default: 700, min: 100, max: 4000, step: 50 },
      { name: 'block', type: 'number', default: 180, min: 60, max: 600, step: 10 },
      { name: 'angle', type: 'number', default: 0, min: -90, max: 90, step: 1 },
      { name: 'bend', type: 'number', default: 18, min: 0, max: 80, step: 1 },
      { name: 'cls', type: 'select', default: 'street', options: 'roadClasses' },
      { name: 'avenueEvery', type: 'number', default: 3, min: 0, max: 10, step: 1 },
      { name: 'avenueCls', type: 'select', default: 'avenue', options: 'roadClasses' },
      { name: 'seed', type: 'number', default: 7, min: 0, max: 999999, step: 1 },
    ],
    run(world, p) {
      const nx = Math.max(1, Math.round(p.width / p.block)), ny = Math.max(1, Math.round(p.height / p.block));
      const bx = p.width / nx, by = p.height / ny, a = (p.angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
      const n = noise2(p.seed | 0), bend = p.bend;
      // grid points, displaced by smooth noise so the grid bends instead of being ruled straight
      const P = [];
      for (let j = 0; j <= ny; j++) {
        P.push([]);
        for (let i = 0; i <= nx; i++) {
          const u = -p.width / 2 + i * bx + n(i * 0.37, j * 0.37 + 5) * bend, v = -p.height / 2 + j * by + n(i * 0.37 + 9, j * 0.37) * bend;
          P[j].push([r2(p.cx + u * ca - v * sa), r2(p.cy + u * sa + v * ca)]);
        }
      }
      const avenue = (k) => p.avenueEvery > 0 && k % p.avenueEvery === 0;
      let made = 0;
      const lay = (pts, cls, name) => { try { world.addRoad(pts, cls, name); made++; } catch (e) { world.log(`skipped: ${e.message}`); } };
      // each grid line is laid in one go (its corners rounded); crossing lines later split it into junctions
      for (let j = 0; j <= ny; j++) lay(P[j].map((q) => q), avenue(j) ? p.avenueCls : p.cls, `${avenue(j) ? 'Avenue' : 'Street'} ${j + 1}`);
      for (let i = 0; i <= nx; i++) {
        const col = P.map((row) => row[i]);
        // a crossing line is laid block by block, so every crossing becomes a junction (ends snap or split)
        for (let j = 0; j < ny; j++) lay([col[j], col[j + 1]], avenue(i) ? p.avenueCls : p.cls, `${avenue(i) ? 'Avenue' : 'Street'} ${String.fromCharCode(65 + (i % 26))}`);
      }
      return { roads: made, blocks: nx * ny };
    },
  },
  {
    id: 'buildings',
    params: [
      { name: 'cx', type: 'number', default: 0, step: 10, center: 'x' },
      { name: 'cy', type: 'number', default: 0, step: 10, center: 'y' },
      { name: 'radius', type: 'number', default: 500, min: 50, max: 4000, step: 50 },
      { name: 'zone', type: 'select', default: 'midtown', options: Object.keys(ZONES) },
      { name: 'floorsMin', type: 'number', default: 0, min: 0, max: 80, step: 1 },
      { name: 'floorsMax', type: 'number', default: 0, min: 0, max: 80, step: 1 },
      { name: 'density', type: 'number', default: 0.85, min: 0.1, max: 1, step: 0.05 },
      { name: 'setback', type: 'number', default: 3, min: 0, max: 30, step: 0.5 },
      { name: 'seed', type: 'number', default: 3, min: 0, max: 999999, step: 1 },
    ],
    run(world, p) {
      const Z = ZONES[p.zone] ?? ZONES.midtown, rand = rng(p.seed | 0);
      const fmin = p.floorsMin || Z.floors[0], fmax = Math.max(p.floorsMax || Z.floors[1], fmin);
      const [lotW, lotD] = Z.lot, clear = roadClearance(world), occ = footprints(world);
      const cls = world.layers.roads?.classes ?? {};
      let made = 0, skipped = 0;
      for (const e of world.list('edge')) {
        if (/^(fw1|ramp|runway|raceway)/.test(e.cls)) continue;
        const c = cls[e.cls] ?? {}, off = (c.hwt ?? 6) + p.setback;
        if (!e.pts.some((q) => Math.hypot(q[0] - p.cx, q[1] - p.cy) < p.radius)) continue;
        // walk the axis at lot spacing, a lot on each side
        let s = 0;
        const L = [0];
        for (let i = 1; i < e.pts.length; i++) L.push(L[i - 1] + Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]));
        const total = L[L.length - 1], ends = (e.trim?.[0] ?? 0) + lotW, ende = total - (e.trim?.[1] ?? 0) - lotW;
        for (s = ends; s < ende; s += lotW) {
          let i = 1; while (i < L.length - 1 && L[i] < s) i++;
          const a = e.pts[i - 1], b = e.pts[i], u = (s - L[i - 1]) / Math.max(L[i] - L[i - 1], 1e-6);
          const px = a[0] + (b[0] - a[0]) * u, py = a[1] + (b[1] - a[1]) * u, tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const tx = (b[0] - a[0]) / tl, ty = (b[1] - a[1]) / tl, nx = -ty, ny = tx;
          for (const side of [1, -1]) {
            if (rand() > p.density) continue;
            if (Math.hypot(px - p.cx, py - p.cy) > p.radius) continue;
            const w = lotW * (0.7 + rand() * 0.25), d = lotD * (0.8 + rand() * 0.4);
            const cx = px + nx * side * (off + d / 2), cy = py + ny * side * (off + d / 2);
            const corner = (fu, fv) => [r2(cx + tx * fu * w / 2 + nx * side * fv * d / 2), r2(cy + ty * fu * w / 2 + ny * side * fv * d / 2)];
            const poly = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
            const zs = poly.map((q) => world.graded(q[0], q[1]));
            if (Math.min(...zs) < 0.6 || Math.max(...zs) - Math.min(...zs) > 4) { skipped++; continue; }   // water or steep
            if ([...poly, [cx, cy]].some((q) => clear(q[0], q[1]) < 1.5) || occ.hits(poly, 1.5)) { skipped++; continue; }
            const type = pick(rand, Z.types), floors = Math.round(fmin + (fmax - fmin) * rand() ** 1.6);
            const z = r2(Math.min(...zs) - 0.3), m = pick(rand, Z.mats), H = r2(floors * FLOOR + 0.6);
            const parts = [{ p: poly, z, h: H, m }];
            if (type === 'podium_tower' && floors > 6) {        // podium + a slimmer tower on it
              parts[0].h = r2(3 * FLOOR);
              const k = 0.62, inner = poly.map((q) => [r2(cx + (q[0] - cx) * k), r2(cy + (q[1] - cy) * k)]);
              parts.push({ p: inner, z: r2(z + 3 * FLOOR), h: r2(H - 3 * FLOOR), m: pick(rand, Z.mats) });
            }
            if (Z.roofs) parts.push({ p: poly, z: r2(z + H), h: 0.6, m: pick(rand, Z.roofs) });
            world.create('building', { type, zone: p.zone, parts });
            occ.add(poly);
            made++;
          }
        }
      }
      return { buildings: made, skipped };
    },
  },
  {
    id: 'trees',
    params: [
      { name: 'cx', type: 'number', default: 0, step: 10, center: 'x' },
      { name: 'cy', type: 'number', default: 0, step: 10, center: 'y' },
      { name: 'radius', type: 'number', default: 600, min: 20, max: 5000, step: 10 },
      { name: 'perHectare', type: 'number', default: 25, min: 1, max: 400, step: 1 },
      { name: 'patchiness', type: 'number', default: 0.5, min: 0, max: 1, step: 0.05 },
      { name: 'seed', type: 'number', default: 11, min: 0, max: 999999, step: 1 },
    ],
    run(world, p) {
      const rand = rng(p.seed | 0), n = noise2((p.seed | 0) + 101), clear = roadClearance(world), occ = footprints(world);
      const count = Math.round((Math.PI * p.radius * p.radius) / 10000 * p.perHectare);
      let made = 0;
      for (let k = 0; k < count * 3 && made < count; k++) {
        const r = p.radius * Math.sqrt(rand()), a = rand() * Math.PI * 2, x = p.cx + Math.cos(a) * r, y = p.cy + Math.sin(a) * r;
        if (p.patchiness > 0 && (n(x / 220, y / 220, 3) + 1) / 2 < p.patchiness * 0.7) continue;   // forest patches and clearings
        const z = world.graded(x, y);
        if (z < 0.8 || clear(x, y) < 2.5 || occ.hits([[x - 2, y - 2], [x + 2, y + 2]])) continue;
        world.create('tree', [r2(x), r2(y), r2(z)]);
        made++;
      }
      return { trees: made };
    },
  },
];
export const GENERATOR_BY_ID = Object.fromEntries(GENERATORS.map((g) => [g.id, g]));

/** Parameters with defaults filled in and numbers clamped. */
export function generatorParams(g, given = {}) {
  const out = {};
  for (const q of g.params) {
    let v = given[q.name] ?? q.default;
    if (q.type === 'number') { v = Number(v); if (!Number.isFinite(v)) v = q.default; if (q.min != null) v = Math.max(q.min, v); if (q.max != null) v = Math.min(q.max, v); }
    if (q.type === 'bool') v = v === true || v === 'true' || v === 1;
    out[q.name] = v;
  }
  return out;
}

/** Run a generator as one batch (one undo step). Returns { id, params, result, edits, ms, logs }. */
export async function runGenerator(s, id, given, label) {
  const g = GENERATOR_BY_ID[id];
  if (!g) throw new Error(`unknown generator ${id}; one of ${GENERATORS.map((x) => x.id).join(', ')}`);
  const params = generatorParams(g, given), logs = [], counter = { edits: 0 }, t0 = Date.now();
  let result;
  await s.batch(label ?? id, async () => { result = await g.run(makeWorld(s, label ?? id, logs, counter), params); });
  return { id, params, result, edits: counter.edits, ms: Date.now() - t0, logs };
}

/** A plain-text description of the generators and their parameters (for MCP). */
export function describeGenerators() {
  return GENERATORS.map((g) => `- ${g.id}: ` + g.params.map((q) => `${q.name}${q.type === 'select' ? `=${Array.isArray(q.options) ? q.options.join('|') : 'a road class'}` : ''} (default ${q.default})`).join(', ')).join('\n');
}
