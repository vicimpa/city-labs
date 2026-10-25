// Vespera world document on top of VSPB: column types for the known layers, the default type
// registry (`defs` layer) and load/save helpers. A document is { meta, layers, schema }.
import { decode, encode, encodeLayer, assemble, optsFor } from './vspb.js';

export const LAYERS = ['defs', 'terrain', 'roads', 'furniture', 'buildings'];

// compact types for the fields the generator writes; anything else is inferred and kept as is
export const HINTS = {
  'terrain.x0': 'f64', 'terrain.y0': 'f64', 'terrain.res': 'f64', 'terrain.nx': 'u32', 'terrain.ny': 'u32',
  'terrain.sea_level': 'f32', 'terrain.h': 'f32[]!', 'terrain.base': 'f32[]!', 'terrain.bore': 'u32[]!',
  'roads.classes.hw': 'f32', 'roads.classes.hwt': 'f32', 'roads.classes.lanes': 'u8', 'roads.classes.side': 'f32',
  'roads.classes.lane_w': 'f32', 'roads.classes.shoulder': 'f32', 'roads.classes.median': 'f32', 'roads.classes.max_grade': 'f32',
  'roads.nodes.id': 'u32', 'roads.nodes.p': 'f32x3', 'roads.nodes.grad': 'f32x2',
  'roads.edges.id': 'u32', 'roads.edges.n': 'u32x2', 'roads.edges.trim': 'f32x2', 'roads.edges.pts': 'f32x3[]',
  'roads.edges.elev': 'u8[]', 'roads.edges.tunnel': 'u8[]',
  'furniture.items.p': 'f32x3', 'furniture.items.h': 'f32', 'furniture.items.span': 'f32',
  'furniture.items.hgt': 'f32', 'furniture.items.reach': 'f32',
  'buildings.core': 'f32x2', 'buildings.trees': 'f32x3[]', 'buildings.rails': 'f32x3[][]',
  'buildings.cables': 'f32x3[][]', 'buildings.wind': 'f32x4[]',
  'buildings.items.parts.p': 'f32x2[]', 'buildings.items.parts.holes': 'f32x2[][]',
  'buildings.items.parts.z': 'f32', 'buildings.items.parts.h': 'f32',
  'buildings.surfaces.p': 'f32x2[]', 'buildings.surfaces.holes': 'f32x2[][]',
  'buildings.trains.pts': 'f32x3[]',
};
// collections that may be empty (an empty array alone can't tell a list of records from a list of numbers)
export const KINDS = {
  'roads.classes': 'map', 'roads.nodes': 'rows', 'roads.edges': 'rows',
  'furniture.items': 'rows', 'buildings.items': 'rows', 'buildings.items.parts': 'rows',
  'buildings.surfaces': 'rows', 'buildings.trains': 'rows',
  'defs.materials': 'map', 'defs.surfaces': 'map', 'defs.roadMaterials': 'map', 'defs.roadClasses': 'map',
  'defs.buildingTypes': 'map', 'defs.zones': 'map', 'defs.furniture': 'map', 'defs.furniture.parts': 'rows', 'defs.facades': 'map',
};
const OPTS = { hints: HINTS, kinds: KINDS };

// ---------------------------------------------------------------- default type registry
// materials.facade: a facade name (defs.facades) or 'wall' (take the building type's wall facade) or ''
// buildingTypes.wall: a facade name or '' (no facade texture)
// facades: parameters of the procedural wall textures (viewer/facades.js)
// furniture parts: box {s:[w,d,h]} / cyl {r,h,seg} / ico {r} / cone {r,h}; `at` = base centre (ico: centre)
const mat = (color, o = {}) => ({ color, shininess: 5, specular: '#111111', glow: 0, nightGlow: 0, facade: '', ...o });
const glass = (color) => mat(color, { shininess: 90, specular: '#88aacc', facade: 'curtain' });
const ad = (color) => mat(color, { glow: 0.55, nightGlow: 1.6 });
export const DEFAULT_DEFS = {
  layer: 'defs',
  materials: {
    glass_blue: glass('#4a6f8f'), glass_teal: glass('#3f8a8c'), glass_dark: glass('#2d3640'), glass_silver: glass('#9fb0bd'),
    brick: mat('#9a5a44', { facade: 'brick' }), brick_dark: mat('#6b3e33', { facade: 'brick' }),
    concrete: mat('#a09d96', { facade: 'wall' }), plaster_beige: mat('#d8c6a3', { facade: 'wall' }),
    plaster_white: mat('#e4e2dc', { facade: 'wall' }), plaster_peach: mat('#e0a98a', { facade: 'wall' }),
    plaster_mint: mat('#a9c9b0', { facade: 'wall' }),
    metal: mat('#777d84'), metal_roof: mat('#8b9096', { facade: 'ribs' }), metal_blue: mat('#5f7fa6', { facade: 'ribs' }),
    deck: mat('#8d8b86'), roof_white: mat('#f2f2f0'), roof_red: mat('#9c3f2e'), roof_grey: mat('#5c6066'), roof_brown: mat('#6e4a33'),
    canopy_red: mat('#c8102e'), steel: mat('#8d949b'), wood: mat('#5b4632'), stone: mat('#cfc6b0'), bronze: mat('#8a6a3a'),
    crane_yellow: mat('#f2b705'), crane_red: mat('#c8341f'), crane_blue: mat('#2d5fa8'), hull: mat('#26303a'), deck_red: mat('#8a2f22'),
    cont_orange: mat('#d9692b'), cont_blue: mat('#2c5a9e'), cont_green: mat('#2f7d4f'), cont_red: mat('#a8322a'),
    cont_grey: mat('#8a9096'), cont_white: mat('#d7d9db'),
    lamp: ad('#fff2b0'), helipad: mat('#3a3c40'), spray: mat('#d8f0ff'), wheel_white: mat('#f4f4f4'), metro_red: ad('#e0262f'),
    ad_red: ad('#ff3b30'), ad_yellow: ad('#ffcc00'), ad_blue: ad('#2f7bff'), ad_green: ad('#30d158'),
    ad_magenta: ad('#ff2d92'), ad_white: ad('#f5f5f5'),
  },
  surfaces: {
    grass: { color: '#4d7a34', lift: 0.12 }, pond: { color: '#1d4a66', lift: 0.16 }, path: { color: '#b9ab8c', lift: 0.2 },
    plaza: { color: '#b7b2a6', lift: 0.14 }, parking: { color: '#3a3c40', lift: 0.1 }, pitch: { color: '#3f9a3a', lift: 0.18 },
    gravel: { color: '#8a8478', lift: 0.12 }, apron: { color: '#8e8f8c', lift: 0.16 }, runway: { color: '#3b3d40', lift: 0.2 },
    track: { color: '#b5523b', lift: 0.16 }, pool: { color: '#3fb6d6', lift: 0.3 },
  },
  roadMaterials: {
    asphalt: { color: '#2c2f33' }, concrete: { color: '#8a8780' }, curb: { color: '#9b9890' }, sidewalk: { color: '#a8a49b' },
    paint_white: { color: '#e9e9e2', paint: true }, paint_yellow: { color: '#e0a51e', paint: true }, grass: { color: '#4f6b33' },
    barrier: { color: '#b5b3ab' }, guardrail: { color: '#c9ced4' }, metal: { color: '#6d7277' }, tunnel: { color: '#77746e' },
    tunnel_light: { color: '#ffd79a', unlit: true }, wall: { color: '#9c968b' },
  },
  roadClasses: {
    fw13: { color: '#f2a93b' }, fw12: { color: '#f2a93b' }, ramp1: { color: '#e0863a' }, boulevard: { color: '#eeeeee' },
    avenue: { color: '#dedede' }, street: { color: '#bdbdbd' }, lane: { color: '#a8a8a8' }, industrial: { color: '#9a9fa8' },
    mountain: { color: '#e87a5e' }, rural: { color: '#c9a27a' }, raceway: { color: '#5fe08a' }, runway: { color: '#8c8c99' },
  },
  buildingTypes: Object.fromEntries([
    ...['tower', 'podium_tower', 'stepped', 'round_tower', 'landmark', 'block', 'l_block', 'courtyard', 'hospital', 'school',
      'mall', 'terminal', 'station', 'warehouse', 'hangar', 'pavilion', 'power_plant'].map((t) => [t, { wall: 'office' }]),
    ...['house', 'shop'].map((t) => [t, { wall: 'house' }]),
    ...['rail_pier', 'level_crossing', 'substation', 'pylon', 'control_tower', 'airliner', 'quay', 'containers', 'gantry_crane',
      'ship', 'lighthouse', 'tv_tower', 'billboard', 'footbridge', 'metro', 'arch', 'ferris_wheel', 'mast', 'stadium',
      'water_tower', 'fountain', 'construction', 'garage', 'church', 'gas_station', 'pole'].map((t) => [t, { wall: '' }]),
  ]),
  facades: {
    curtain: { style: 'curtain', bay: 3, floor: 3.3, window: [0.9, 0.82], wallColor: '#e8ecef', frame: '#e8ecef', glass: '#9aa6b4', lit: 0.38, warm: 0.75, shutters: false, sparse: 0, seed: 7 },
    office: { style: 'windows', bay: 4, floor: 3.3, window: [0.62, 0.56], wallColor: '#f2f0ea', frame: '#c9c6bf', glass: '#3c4a5a', lit: 0.38, warm: 0.75, shutters: false, sparse: 0, seed: 6 },
    brick: { style: 'brick', bay: 3.6, floor: 3.3, window: [0.44, 0.53], wallColor: '#ebd1c3', frame: '#e6e1d8', glass: '#323c46', lit: 0.38, warm: 0.75, shutters: false, sparse: 0, seed: 5 },
    house: { style: 'windows', bay: 5, floor: 3.3, window: [0.5, 0.44], wallColor: '#f6f4ef', frame: '#ffffff', glass: '#41505e', lit: 0.38, warm: 0.75, shutters: true, sparse: 0.25, seed: 4 },
    ribs: { style: 'ribs', bay: 2, floor: 3.3, window: [0, 0], wallColor: '#ffffff', frame: '#d4d6d8', glass: '#888888', lit: 0, warm: 0, shutters: false, sparse: 0, seed: 3 },
  },
  zones: {
    downtown: { color: '#ff6b6b' }, midtown: { color: '#ffa94d' }, commercial: { color: '#ffd43b' }, residential: { color: '#69db7c' },
    suburb: { color: '#38d9a9' }, industrial: { color: '#868e96' }, port: { color: '#4dabf7' }, civic: { color: '#9775fa' },
    landmark: { color: '#f783ac' }, infra: { color: '#adb5bd' }, ad: { color: '#e64980' }, rural: { color: '#a9e34b' },
  },
  furniture: {
    lamp: { parts: [{ k: 'cyl', r: 0.12, h: 9, at: [0, 0, 0], c: '#55595e' }, { k: 'box', s: [2.2, 0.2, 0.15], at: [1.1, 0, 9], c: '#55595e' },
      { k: 'box', s: [0.7, 0.35, 0.18], at: [2.1, 0, 8.85], c: '#fff0c8' }] },
    highmast: { parts: [{ k: 'cyl', r: 0.25, h: 14, at: [0, 0, 0], c: '#6d7277' }, { k: 'box', s: [3, 0.3, 0.3], at: [1.5, 0, 14], c: '#6d7277' },
      { k: 'box', s: [0.9, 0.5, 0.25], at: [2.8, 0, 13.75], c: '#fff0c8' }] },
    tree: { parts: [{ k: 'cyl', r: 0.2, h: 3, at: [0, 0, 0], c: '#5a4330' }, { k: 'ico', r: 2.4, at: [0, 0, 4.6], c: '#3f6b2f' }] },
    signal: { parts: [{ k: 'cyl', r: 0.15, h: 6.5, at: [0, 0, 0], c: '#3d4044' }, { k: 'box', s: [0.2, 0.2, 0.2], at: [0, 0, 6.3], c: '#3d4044' },
      { k: 'box', s: [0.4, 0.4, 1.1], at: [0, 0, 5.2], c: '#1d1f22' }, { k: 'box', s: [0.25, 0.1, 0.25], at: [0, -0.25, 5.9], c: '#ff3b30' }] },
    stop_sign: { parts: [{ k: 'cyl', r: 0.05, h: 2.2, at: [0, 0, 0], c: '#9aa0a6' }, { k: 'box', s: [0.75, 0.05, 0.75], at: [0, 0, 2.1], c: '#c8102e' }] },
    gantry: { parts: [{ k: 'cyl', r: 0.3, h: 7.5, at: [0, -1, 0], c: '#7e848a' }, { k: 'box', s: [0.6, 0.6, 0.6], at: [0, 0, 7.2], c: '#7e848a' },
      { k: 'box', s: [0.15, 1, 2.2], at: [0, 0, 5.4], c: '#1f6f3f' }] },
    delineator: { parts: [{ k: 'cyl', r: 0.06, h: 1.1, at: [0, 0, 0], c: '#eeeeee', seg: 4 }, { k: 'box', s: [0.07, 0.07, 0.15], at: [0, 0, 0.9], c: '#ff9500' }] },
    chevron: { parts: [{ k: 'cyl', r: 0.05, h: 1.6, at: [0, 0, 0], c: '#9aa0a6', seg: 4 }, { k: 'box', s: [0.6, 0.05, 0.75], at: [0, 0, 1.5], c: '#ffcc00' }] },
    bus_stop: { parts: [{ k: 'box', s: [4, 1.6, 0.1], at: [0, 0, 2.6], c: '#8fa3b0' }, { k: 'box', s: [4, 0.1, 2.4], at: [0, 0.75, 0.2], c: '#9fc6dd' },
      { k: 'box', s: [1.2, 0.1, 1.8], at: [2.0, 0.75, 0.4], c: '#ffffff' }] },
  },
};

// road classes of a new world (lanes per direction; widths in metres; grades as fractions)
export const DEFAULT_ROAD_CLASSES = {"avenue":{"lanes":2,"lane_w":3.4,"shoulder":2.4,"median":0.6,"side":4.5,"sigma":60,"r":60,"prio":3,"corner":9,"oneway":false,"max_grade":0.08,"k_min":22},"boulevard":{"lanes":3,"lane_w":3.5,"shoulder":0.6,"median":7,"side":5,"sigma":80,"r":200,"prio":4,"corner":12,"oneway":false,"max_grade":0.07,"k_min":25},"fw12":{"lanes":2,"lane_w":3.6,"shoulder":1.8,"median":0,"side":0,"sigma":90,"r":300,"prio":6,"corner":12,"oneway":true,"max_grade":0.06,"k_min":60},"fw13":{"lanes":3,"lane_w":3.6,"shoulder":1.8,"median":0,"side":0,"sigma":90,"r":300,"prio":6,"corner":12,"oneway":true,"max_grade":0.06,"k_min":60},"industrial":{"lanes":1,"lane_w":4.2,"shoulder":1.6,"median":0.3,"side":0,"sigma":50,"r":40,"prio":2,"corner":12,"oneway":false,"max_grade":0.07,"k_min":15},"lane":{"lanes":1,"lane_w":3.1,"shoulder":0.4,"median":0,"side":2.2,"sigma":25,"r":15,"prio":1,"corner":5,"oneway":false,"max_grade":0.12,"k_min":6},"mountain":{"lanes":1,"lane_w":3.6,"shoulder":1,"median":0.3,"side":0,"sigma":22,"r":30,"prio":2,"corner":8,"oneway":false,"max_grade":0.115,"k_min":6},"raceway":{"lanes":1,"lane_w":6,"shoulder":2,"median":0,"side":0,"sigma":40,"r":40,"prio":3,"corner":12,"oneway":false,"max_grade":0.06,"k_min":15},"ramp1":{"lanes":1,"lane_w":3.8,"shoulder":0.6,"median":0,"side":0,"sigma":30,"r":60,"prio":5,"corner":10,"oneway":true,"max_grade":0.07,"k_min":18},"runway":{"lanes":1,"lane_w":22,"shoulder":0,"median":0,"side":0,"sigma":200,"r":500,"prio":3,"corner":12,"oneway":false,"max_grade":0.01,"k_min":100},"rural":{"lanes":1,"lane_w":3.6,"shoulder":1.4,"median":0.3,"side":0,"sigma":30,"r":60,"prio":2,"corner":10,"oneway":false,"max_grade":0.1,"k_min":15},"street":{"lanes":1,"lane_w":3.6,"shoulder":2.3,"median":0.3,"side":3.5,"sigma":45,"r":30,"prio":2,"corner":7,"oneway":false,"max_grade":0.1,"k_min":12}};

export const MAX_CELLS = 4_200_000;          // heightfield cells a browser still handles (two Float32 grids + the mesh)
const AUTO_CELLS = 1_100_000;                // what 'auto' aims for: light enough to edit smoothly
/** Grid step for a map: the requested one if it fits MAX_CELLS, else (and for 'auto') the finest of
 *  1, 2, 4, 6, 8, 12, 16… m within the budget. */
export function gridStep(width, depth, res = 'auto') {
  const cells = (r) => (Math.round(width / r) + 1) * (Math.round(depth / r) + 1);
  if (res !== 'auto' && cells(+res) <= MAX_CELLS) return +res;
  const budget = res === 'auto' ? AUTO_CELLS : MAX_CELLS;
  return [1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64].find((r) => r >= (res === 'auto' ? 2 : +res) && cells(r) <= budget) ?? 64;
}

/**
 * A new, empty world: flat land of width × depth metres at `ground` metres, no roads or buildings,
 * the default registry. `size` sets both sides; `res` is the grid step in metres (or 'auto').
 */
export function emptyWorld({ size, width = size ?? 4000, depth = width, res = 'auto', ground, height } = {}) {
  const step = gridStep(width, depth, res), z = ground ?? height ?? 10;
  const nx = Math.round(width / step) + 1, ny = Math.round(depth / step) + 1;
  const classes = structuredClone(DEFAULT_ROAD_CLASSES);
  for (const c of Object.values(classes)) {
    const hw = c.oneway ? (c.lanes * c.lane_w) / 2 + c.shoulder : c.lanes * c.lane_w + c.shoulder + c.median / 2;
    c.hw = Math.round(hw * 100) / 100; c.hwt = Math.round((hw + c.side) * 100) / 100;
  }
  return withDefaults({
    meta: { created: new Date().toISOString(), generator: 'city-labs' },
    layers: {
      terrain: { layer: 'terrain', x0: -((nx - 1) * step) / 2, y0: -((ny - 1) * step) / 2, res: step, nx, ny, sea_level: 0,
        base: new Float32Array(nx * ny).fill(z), h: new Float32Array(nx * ny).fill(z), bore: new Uint32Array(0) },
      roads: { layer: 'roads', classes, nodes: [], edges: [] },
      furniture: { layer: 'furniture', items: [] },
      buildings: { layer: 'buildings', items: [], surfaces: [], trees: [], rails: [], cables: [], wind: [], trains: [] },
    },
    schema: { hints: { ...HINTS }, kinds: { ...KINDS } },
  });
}

/** Fill registry entries the document lacks (old files, new built-in types); never overwrites. */
export function withDefaults(doc) {
  // natural ground the roads are graded into; files from before it existed start from the graded one
  const t = doc.layers.terrain;
  if (t?.h && !t.base) t.base = Float32Array.from(t.h);
  const d = (doc.layers.defs ??= {});
  for (const [k, v] of Object.entries(DEFAULT_DEFS)) {
    if (typeof v !== 'object') { d[k] ??= v; continue; }
    d[k] ??= {};
    for (const [name, def] of Object.entries(v)) d[k][name] ??= structuredClone(def);
  }
  return doc;
}

// ---------------------------------------------------------------- load / save
export async function decodeWorld(buf) { return withDefaults(await decode(buf)); }

export async function loadWorld(url = '/city/data/vespera.vspb') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ': ' + res.status);
  return decodeWorld(await res.arrayBuffer());
}

export const encodeWorld = (doc) => encode(doc, OPTS);
export const encodeWorldLayer = (doc, name) => encodeLayer(name, doc.layers[name], optsFor(doc, OPTS));
export { assemble };

// ---------------------------------------------------------------- registry lookups for renderers
export function facadeFor(defs, material, type) {
  const wall = defs.buildingTypes?.[type]?.wall;
  if (!wall) return null;
  const f = defs.materials?.[material]?.facade, name = f === 'wall' ? wall : f;
  return name && defs.facades?.[name] ? name : null;
}
