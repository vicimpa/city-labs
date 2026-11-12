// Three.js scene for a Vespera world document (format/world.js). Shared by the viewer and the editor.
// Buildings and ground surfaces are merged per material inside square tiles, so an edit rebuilds one
// tile; every pickable mesh carries userData.kind + userData.owner(faceIndex | instanceId) -> record.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { facadeTextures } from './facades.js';
import { buildingGeometries } from './buildings.js';
import { TerrainChunks } from './terrain.js';
import { disposeRenderObjects } from './resources.js';
import { buildingMatrix, buildingCenter, ensureLocalBuilding, objectMatrix } from '../format/transforms.js';
import { facadeFor } from '../format/world.js';
import { RoadWorld } from '../world/roadworld.js';
import { railPiers, elevatedRuns, PIER, GIRDER } from '../world/rail.js';
import { powerLayout, POWER_TYPES } from '../world/power.js';

const MISSING = 0xff00ff;
const color = (c) => new THREE.Color(c ?? MISSING);

export function heightAt(t) {
  const { nx, ny, x0, y0, res, h } = t;
  return (x, y) => {
    const fx = Math.min(Math.max((x - x0) / res, 0), nx - 1.001), fy = Math.min(Math.max((y - y0) / res, 0), ny - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, k = j * nx + i;
    return h[k] * (1 - u) * (1 - v) + h[k + 1] * u * (1 - v) + h[k + nx] * (1 - u) * v + h[k + nx + 1] * u * v;
  };
}

export const shapeOf = (p, holes) => {
  const s = new THREE.Shape(p.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const hl of holes ?? []) s.holes.push(new THREE.Path(hl.map(([x, y]) => new THREE.Vector2(x, y))));
  return s;
};

export function ribbon(pts, hwid, lift) {
  const n = pts.length, pos = new Float32Array(n * 6), idx = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, n - 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
    const nx = -ty * hwid, ny = tx * hwid, p = pts[i];
    pos.set([p[0] + nx, p[1] + ny, p[2] + lift, p[0] - nx, p[1] - ny, p[2] + lift], i * 6);
    if (i < n - 1) { const k = i * 2; idx.push(k, k + 1, k + 3, k, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// a box beam hanging under a polyline: sides and bottom, from dz0 down to dz1 below it
function girder(pts, hw, dz0, dz1) {
  const n = pts.length, pos = new Float32Array(n * 12), idx = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, n - 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
    const nx = -ty * hw, ny = tx * hw, p = pts[i], zt = p[2] - dz0, zb = p[2] - dz1;
    pos.set([p[0] + nx, p[1] + ny, zt, p[0] + nx, p[1] + ny, zb, p[0] - nx, p[1] - ny, zb, p[0] - nx, p[1] - ny, zt], i * 12);
    if (i < n - 1) for (let f = 0; f < 3; f++) { const k = i * 4 + f, m = k + 4; idx.push(k, m, k + 1, k + 1, m, m + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// split triangles until no edge exceeds `maxEdge` (terrain grid is 6 m), then lay every vertex on the ground
function drape(geo, H, lift, maxEdge = 5) {
  const src = geo.index ? geo.toNonIndexed() : geo, p = src.attributes.position.array, out = [];
  const tri = (a, b, c) => {
    const ab = Math.hypot(a[0] - b[0], a[1] - b[1]), bc = Math.hypot(b[0] - c[0], b[1] - c[1]), ca = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const m = Math.max(ab, bc, ca);
    if (m <= maxEdge) { out.push(...a, ...b, ...c); return; }
    const mid = (u, v) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2, 0];
    if (m === ab) { const d = mid(a, b); tri(a, d, c); tri(d, b, c); }
    else if (m === bc) { const d = mid(b, c); tri(a, b, d); tri(a, d, c); }
    else { const d = mid(c, a); tri(a, b, d); tri(d, b, c); }
  };
  for (let i = 0; i < p.length; i += 9) tri([p[i], p[i + 1], 0], [p[i + 3], p[i + 4], 0], [p[i + 6], p[i + 7], 0]);
  for (let i = 0; i < out.length; i += 3) out[i + 2] = Math.max(H(out[i], out[i + 1]), 0) + lift;
  geo.dispose(); if (src !== geo) src.dispose();
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return g;
}

// merged mesh whose faces map back to records: owners = [{rec, end}] sorted by end triangle
function ownedMesh(entries, material, kind) {
  const g = mergeGeometries(entries.map((e) => e.g));
  entries.forEach((e) => e.g.dispose());
  if (!g.attributes.normal) g.computeVertexNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, material);
  mesh.castShadow = kind === 'building'; mesh.receiveShadow = true;
  const ends = [], recs = [];
  let n = 0;
  for (const e of entries) { n += e.g.attributes.position.count / 3; ends.push(n); recs.push(e.rec); }
  mesh.userData = { kind, owner(face) {
    let lo = 0, hi = ends.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ends[mid] > face) hi = mid; else lo = mid + 1; }
    return recs[lo];
  } };
  return mesh;
}

function terrainColor(z, c) {
  if (z < 0.5) c.setRGB(0.55, 0.5, 0.38);
  else if (z < 40) c.setRGB(0.28 + z * 0.002, 0.34 + z * 0.002, 0.22);
  else if (z < 160) c.setRGB(0.33 + (z - 40) * 0.001, 0.36, 0.25 + (z - 40) * 0.0008);
  else c.setRGB(0.5, 0.5, 0.48);
}

// Terrain inside a tunnel tube (the heightfield slopes down through the bore at the portals and
// wherever the cover is thin) is discarded per fragment, so the hillside meets the tube shell
// exactly instead of along 6 m grid triangles. Tube axes go to the shader as a segment texture,
// grouped into runs with bounding boxes so most fragments skip the test.
const TUBE_H = 7.3, MAX_RUNS = 32;
function tunnelClip(material, roads, then = null) {
  const seg = [], runs = [];
  for (const ed of roads.edges) {
    const W = (roads.classes[ed.cls]?.hw ?? 4) + 0.8;
    let run = null;
    for (let k = 0; k + 1 < ed.pts.length; k++) {
      if (!ed.tunnel?.[k] && !ed.tunnel?.[k + 1]) { run = null; continue; }
      if (!run) runs.push(run = { start: seg.length / 8, n: 0, box: [Infinity, Infinity, -Infinity, -Infinity] });
      const [ax, ay, az] = ed.pts[k], [bx, by, bz] = ed.pts[k + 1];
      seg.push(ax, ay, az, W, bx, by, bz, 0);
      run.n++;
      run.box = [Math.min(run.box[0], ax - W, bx - W), Math.min(run.box[1], ay - W, by - W),
        Math.max(run.box[2], ax + W, bx + W), Math.max(run.box[3], ay + W, by + W)];
    }
  }
  if (!runs.length) { if (then) material.onBeforeCompile = then; return; }
  if (runs.length > MAX_RUNS) console.warn(`tunnelClip: ${runs.length} runs, only ${MAX_RUNS} clipped`);
  const n = seg.length / 4, tw = 1024, th = Math.ceil(n / tw);
  const data = new Float32Array(tw * th * 4); data.set(seg);
  const tex = new THREE.DataTexture(data, tw, th, THREE.RGBAFormat, THREE.FloatType);
  tex.needsUpdate = true;
  (material.userData.ownedTextures ??= []).push(tex);
  const box = [], range = [];
  for (let r = 0; r < MAX_RUNS; r++) {
    const R = runs[r];
    box.push(R ? new THREE.Vector4(...R.box) : new THREE.Vector4(1, 1, -1, -1));
    range.push(new THREE.Vector2(R ? R.start : 0, R ? R.n : 0));
  }
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { tubeSeg: { value: tex }, tubeBox: { value: box }, tubeRange: { value: range } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTubeW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTubeW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vTubeW;
uniform highp sampler2D tubeSeg;
uniform vec4 tubeBox[${MAX_RUNS}];
uniform vec2 tubeRange[${MAX_RUNS}];
vec4 tubeTexel(int i) { return texelFetch(tubeSeg, ivec2(i % ${tw}, i / ${tw}), 0); }
bool inTube(vec3 p) {
  for (int r = 0; r < ${MAX_RUNS}; r++) {
    vec4 b = tubeBox[r];
    if (p.x < b.x || p.y < b.y || p.x > b.z || p.y > b.w) continue;
    int s0 = int(tubeRange[r].x), sn = int(tubeRange[r].y);
    for (int k = 0; k < sn; k++) {
      vec4 A = tubeTexel((s0 + k) * 2), B = tubeTexel((s0 + k) * 2 + 1);
      vec2 d = B.xy - A.xy;
      float u = dot(p.xy - A.xy, d) / max(dot(d, d), 1e-6);
      if (u < 0.0 || u > 1.0) continue;
      float zr = mix(A.z, B.z, u);
      if (length(p.xy - A.xy - u * d) < A.w && p.z > zr + 0.1 && p.z < zr + ${TUBE_H.toFixed(1)} + 0.5) return true;
    }
  }
  return false;
}`)
      .replace('void main() {', 'void main() {\n  if (inTube(vTubeW)) discard;');
    then?.(sh);
  };
}

// Ground grid in the terrain shader: follows the heightfield and brush edits for free. Lines are
// anti-aliased with screen-space derivatives and fade out where they would crowd into moiré.
function groundGrid(sh, on) {
  sh.uniforms.gridOn = on;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vGridW;')
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGridW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
varying vec3 vGridW;
uniform float gridOn;
float gridLine(vec2 p, float step) {
  vec2 c = p / step, w = fwidth(c);
  vec2 g = abs(fract(c - 0.5) - 0.5) / max(w, vec2(1e-4));
  float fade = 1.0 - smoothstep(0.15, 0.45, max(w.x, w.y));
  return (1.0 - min(min(g.x, g.y), 1.0)) * fade;
}`)
    .replace('#include <opaque_fragment>', `#include <opaque_fragment>
if (gridOn > 0.5) {
  float minor = gridLine(vGridW.xy, 100.0), major = gridLine(vGridW.xy, 500.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.94, 0.96, 1.0), max(minor * 0.22, major * 0.45));
}`);
}

export class World3D {
  /** @param doc world document; opts.tileSize in metres (Infinity disables spatial batching). */
  constructor(doc, { anisotropy = 4, tileSize = 600, roadTileSize = 1200, tickers = [], grid = false, detail = 'medium', quality = 'medium', detailDistance = 650, showTrains = false, animateTrains = false } = {}) {
    this.doc = doc;
    this.detail = detail; this.quality = quality; this.detailDistance = detailDistance;
    this.showTrains = showTrains; this.animateTrains = animateTrains; this.disposed = false;
    this.tileSize = tileSize; this.roadTileSize = roadTileSize;
    this.tickers = tickers;
    this.anisotropy = anisotropy;
    this.facades = facadeTextures(doc.layers.defs?.facades, anisotropy);
    this.hidden = new Set();                // records left out of the merged meshes (being edited live)
    this.night = false;
    this.mats = new Map();                  // building material cache  'm|facade' -> material
    this.propMats = new Map();              // separately owned PBR descriptors for furniture
    this.smats = new Map();                 // surface materials
    this.groups = {};
    for (const n of ['terrain', 'roads', 'furniture', 'buildings']) this.groups[n] = new THREE.Group();
    for (const n of ['blocks', 'surfaces', 'trees', 'rails', 'wind', 'trains', 'cables']) {
      this.groups[n] = new THREE.Group(); this.groups.buildings.add(this.groups[n]);
    }
    this.tiles = { blocks: new Map(), surfaces: new Map() };   // key -> {recs:Set, obj}
    this.tileOf = new Map();                // rec -> key
    this.rmats = new Map();                 // road material cache
    this.roadTiles = new Map();             // key -> {recs: Set(owner key), obj}
    this.roadTileOf = new Map();            // owner key -> tile key
    this.gridOn = { value: grid ? 1 : 0 };  // uniform shared by every terrain material
  }
  get L() { return this.doc.layers; }
  get defs() { return this.doc.layers.defs; }

  buildAll() {
    const { terrain, roads } = this.L;
    if (terrain) { this.H = heightAt(terrain); this.buildTerrain(); }
    if (roads) this.buildRoads();
    if (this.L.furniture) this.buildFurniture();
    if (this.L.buildings) {
      this.buildBlocks(); this.buildSurfaces(); this.buildTrees(); this.buildRails(); this.buildWind(); this.buildTrains(); this.buildCables();
    }
    return this;
  }

  // ---------------------------------------------------------------- terrain
  buildTerrain() {
    this.clearGroup(this.groups.terrain);
    this.terrainGeo?.dispose();
    const t = this.L.terrain, { nx, ny, x0, y0, res, h } = t;
    const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3), nrm = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = (j * nx + i) * 3; pos[k] = x0 + i * res; pos[k + 1] = y0 + j * res; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    // Full authoring/export attributes stay CPU-only; chunk-local meshes own GPU buffers.
    this.terrainGeo = g;
    this.updateTerrain(0, 0, nx - 1, ny - 1, false);
    g.computeBoundingSphere(); g.computeBoundingBox();
    this.terrainRenderMaterial = this.terrainMaterial();
    this.terrainChunks = new TerrainChunks(t, g, this.terrainRenderMaterial, { roads: this.L.roads, surfaces: this.L.buildings?.surfaces, quality: this.quality });
    const mesh = this.terrainMesh = this.terrainChunks.group;
    mesh.userData = { kind: 'terrain' };
    const water = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000),
      new THREE.MeshPhongMaterial({ color: 0x0d2233, shininess: 80, transparent: true, opacity: 0.92 }));
    water.position.z = -0.3;                // keep off the shoreline (z-fighting)
    water.raycast = () => {};
    this.groups.terrain.clear();
    this.groups.terrain.add(mesh, water);
  }

  terrainMaterial() {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const grid = (sh) => groundGrid(sh, this.gridOn);
    if (this.L.roads) tunnelClip(mat, this.L.roads, grid); else mat.onBeforeCompile = grid;
    return mat;
  }
  /** Coordinate grid drawn on the ground (100 m lines, 500 m major lines). */
  setGrid(on) { this.gridOn.value = on ? 1 : 0; }

  /** Re-read heights of grid cells [i0..i1]x[j0..j1] into the mesh (after a brush stroke). */
  updateTerrain(i0, j0, i1, j1, upload = true) {
    const { nx, ny, h } = this.L.terrain, res = this.L.terrain.res, g = this.terrainGeo;
    i0 = Math.max(i0 - 1, 0); j0 = Math.max(j0 - 1, 0); i1 = Math.min(i1 + 1, nx - 1); j1 = Math.min(j1 + 1, ny - 1);
    const pos = g.attributes.position.array, col = g.attributes.color.array, nrm = g.attributes.normal.array, c = new THREE.Color();
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const v = j * nx + i, k = v * 3, z = h[v];
      pos[k + 2] = z;
      terrainColor(z, c); col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      const dx = (h[j * nx + Math.min(i + 1, nx - 1)] - h[j * nx + Math.max(i - 1, 0)]) / (2 * res);
      const dy = (h[Math.min(j + 1, ny - 1) * nx + i] - h[Math.max(j - 1, 0) * nx + i]) / (2 * res);
      const L = Math.hypot(dx, dy, 1); nrm[k] = -dx / L; nrm[k + 1] = -dy / L; nrm[k + 2] = 1 / L;
    }
    if (upload) this.terrainChunks?.updateRegion(i0, j0, i1, j1);
  }

  // ---------------------------------------------------------------- roads (built from the graph by world/roadworld.js)
  roadMaterial(name) {
    let m = this.rmats.get(name);
    if (!m) {
      const d = this.defs.roadMaterials?.[name] ?? {};
      m = d.unlit ? new THREE.MeshBasicMaterial({ color: color(d.color) }) : new THREE.MeshLambertMaterial({ color: color(d.color), side: THREE.DoubleSide });
      m.userData = { name };
      this.rmats.set(name, m);
    }
    return m;
  }
  buildRoads() {
    this.roadWorld = new RoadWorld(this.doc);
    for (const t of this.roadTiles.values()) this.disposeTile(t);
    this.roadTiles.clear(); this.roadTileOf.clear(); this.groups.roads.clear();
    for (const key of this.roadWorld.bufs.keys()) this.placeRoad(key);
    for (const key of this.roadTiles.keys()) this.buildRoadTile(key);
    this.buildBents(); this.terrainChunks?.setRoads(this.L.roads);
  }
  placeRoad(key) {
    const o = this.roadWorld.owner(key);
    if (!o) return null;
    const tk = this.roadTileSize === Infinity ? '0' : Math.floor(o.at[0] / this.roadTileSize) + ',' + Math.floor(o.at[1] / this.roadTileSize);
    if (!this.roadTiles.has(tk)) this.roadTiles.set(tk, { recs: new Set(), obj: null });
    this.roadTiles.get(tk).recs.add(key); this.roadTileOf.set(key, tk);
    return tk;
  }
  // one mesh per material per tile; faces map back to the edge / node record that made them
  buildRoadTile(tk) {
    const t = this.roadTiles.get(tk);
    if (!t) return;
    this.disposeTile(t);
    const grp = new THREE.Group(), byMat = new Map();
    for (const key of t.recs) {
      const B = this.roadWorld.bufs.get(key), o = this.roadWorld.owner(key);
      if (!B || !o || this.hidden.has(o.rec)) continue;
      for (const [mat, b] of Object.entries(B.m)) if (b.i.length) { if (!byMat.has(mat)) byMat.set(mat, []); byMat.get(mat).push([b, o]); }
    }
    for (const [mat, parts] of byMat) {
      let nv = 0, ni = 0;
      for (const [b] of parts) { nv += b.v.length; ni += b.i.length; }
      const v = new Float32Array(nv), idx = new Uint32Array(ni), ends = [], owners = [];
      let ov = 0, oi = 0;
      for (const [b, o] of parts) {
        v.set(b.v, ov);
        for (let k = 0; k < b.i.length; k++) idx[oi + k] = b.i[k] + ov / 3;
        ov += b.v.length; oi += b.i.length; ends.push(oi / 3); owners.push(o);
      }
      // The generator sweeps tunnel faces toward the bore. DoubleSide hides the
      // winding visually, but shadow normalBias then offsets roof receivers INTO
      // the shell, causing acne. Orient only the render shell outward; DoubleSide
      // keeps both views and all shadows. Face order/positions/owner ranges stay intact.
      if (mat === 'tunnel') for (let k = 0; k < idx.length; k += 3) { const b = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = b; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(v, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, this.roadMaterial(mat));
      mesh.castShadow = mesh.receiveShadow = true;
      // log depth writes gl_FragDepth, so polygonOffset no longer applies: lift paint a few cm instead
      if (this.defs.roadMaterials?.[mat]?.paint) { mesh.position.z = 0.05; mesh.renderOrder = 1; }
      const find = (face) => { let lo = 0, hi = ends.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (ends[m] > face) hi = m; else lo = m + 1; } return owners[lo]; };
      mesh.userData = { kind: 'road', material: mat, owner: (face) => find(face).rec, kindOf: (face) => find(face).kind };
      grp.add(mesh);
    }
    t.obj = grp;
    this.groups.roads.add(grp);
  }
  buildBents() {
    this.bentObj?.traverse((o) => o.isMesh && o.geometry.dispose());
    this.bentObj?.removeFromParent();
    const grp = new THREE.Group();
    for (const [mat, b] of Object.entries(this.roadWorld.bents.m)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.v), 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(b.i), 1));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, this.roadMaterial(mat));
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.raycast = () => {};
      grp.add(mesh);
    }
    this.bentObj = grp;
    this.groups.roads.add(grp);
  }
  /** Road records changed (see RoadWorld.update): rebuild their meshes, furniture and the ground under them. */
  updateRoads(change, opts = {}) {
    const { owners, box } = this.roadWorld.update(change, opts);
    const tiles = new Set();
    for (const key of owners) {
      const old = this.roadTileOf.get(key);
      if (old !== undefined) { this.roadTiles.get(old)?.recs.delete(key); this.roadTileOf.delete(key); tiles.add(old); }
      if (this.roadWorld.bufs.has(key)) { const tk = this.placeRoad(key); if (tk) tiles.add(tk); }
    }
    for (const tk of tiles) this.buildRoadTile(tk);
    if (!opts.live) this.buildBents();
    if (!opts.live && opts.furniture !== false) this.buildFurniture();
    if (box) this.terrainChanged(box, true);
    return { owners, box };
  }
  /** Terrain heights changed in a cell box: refresh the mesh and re-drape the ground surfaces on it. */
  terrainChanged(box, tunnels = false) {
    const t = this.L.terrain, [i0, j0, i1, j1] = box;
    this.updateTerrain(i0, j0, i1, j1);
    if (tunnels) {
      const m = this.terrainRenderMaterial; this.terrainRenderMaterial = this.terrainMaterial();
      this.terrainChunks.setMaterial(this.terrainRenderMaterial); this.terrainChunks.setRoads(this.L.roads);
      disposeRenderObjects([], { extra: [m] });
    }
    this.buildRails(); this.buildCables();         // piers and power posts stand on the ground
    if (this.tileSize === Infinity) { this.buildSurfaces(); return; }
    const xa = t.x0 + i0 * t.res, ya = t.y0 + j0 * t.res, xb = t.x0 + i1 * t.res, yb = t.y0 + j1 * t.res, pad = 400;
    for (let tx = Math.floor((xa - pad) / this.tileSize); tx <= Math.floor((xb + pad) / this.tileSize); tx++)
      for (let ty = Math.floor((ya - pad) / this.tileSize); ty <= Math.floor((yb + pad) / this.tileSize); ty++) this.buildTile('surfaces', tx + ',' + ty);
  }

  // ---------------------------------------------------------------- furniture (instanced prefabs from defs.furniture)
  prefab(t) {
    const P = [];
    for (const p of this.defs.furniture?.[t]?.parts ?? [{ k: 'box', s: [1, 1, 1], at: [0, 0, 0], c: '#ff00ff' }]) {
      const [x, y, z] = p.at ?? [0, 0, 0];
      let g;
      if (p.k === 'box') { const [w, d, hh] = p.s ?? [1, 1, 1]; g = new THREE.BoxGeometry(w, d, hh); g.translate(x, y, z + hh / 2); }
      else if (p.k === 'cyl' || p.k === 'cone') {
        g = p.k === 'cyl' ? new THREE.CylinderGeometry(p.r ?? 0.2, p.r ?? 0.2, p.h ?? 1, p.seg ?? 6) : new THREE.ConeGeometry(p.r ?? 1, p.h ?? 1, p.seg ?? 8);
        g.rotateX(Math.PI / 2); g.translate(x, y, z + (p.h ?? 1) / 2);
      } else if (p.k === 'ico') { g = new THREE.IcosahedronGeometry(p.r ?? 1, 0); g.translate(x, y, z); }
      else { g = new THREE.BoxGeometry(1, 1, 1); g.translate(x, y, z + 0.5); }
      P.push([g, p.c, p.m]);
    }
    return P;
  }
  propMaterial(d = {}) {
    const glows = (d.glow || d.nightGlow) > 0;
    const pbr = { roughness: d.roughness ?? (d.shininess === undefined ? 0.8 : this.legacyRoughness(d)),
      metalness: d.metalness ?? 0, opacity: d.opacity ?? 1,
      emissive: new THREE.Color(d.emissive ?? (glows ? d.color ?? MISSING : 0x000000)).getHex(),
      day: d.emissiveIntensity ?? (glows ? d.glow ?? 0 : 0), night: d.emissiveIntensity ?? (glows ? d.nightGlow ?? 0 : 0) };
    const key = JSON.stringify(pbr);
    let mat = this.propMats.get(key);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: pbr.roughness, metalness: pbr.metalness,
        opacity: pbr.opacity, transparent: pbr.opacity < 1, depthWrite: pbr.opacity >= 1, emissive: pbr.emissive });
      mat.userData.pbr = pbr; mat.emissiveIntensity = this.night ? pbr.night : pbr.day; this.propMats.set(key, mat);
    }
    return mat;
  }
  buildFurniture() {
    const grp = this.groups.furniture, batches = new Map(), usedMaterials = new Set();
    // Props retain cached PBR materials across rebuilds. They never borrow building materials.
    disposeRenderObjects([grp], { materials: false }); grp.clear();
    for (const it of this.L.furniture?.items ?? []) if (!this.hidden.has(it)) {
      const key = JSON.stringify([this.keyOf(...it.p), it.t, it.material ?? null]);
      if (!batches.has(key)) batches.set(key, { type: it.t, override: it.material, items: [] });
      batches.get(key).items.push(it);
    }
    const prefabs = new Map(), matrix = new THREE.Matrix4();
    for (const { type, override, items } of batches.values()) {
      const prefabKey = JSON.stringify([type, override ?? null]);
      if (!prefabs.has(prefabKey)) {
        const byMaterial = new Map();
        for (const [g, col, partMaterial] of this.prefab(type)) {
          const resource = override ?? partMaterial, d = resource === undefined ? {} : this.defs.materials?.[resource] ?? {};
          const material = this.propMaterial(d), c = resource === undefined ? color(col) : color(d.color);
          const nonindexed = g.index ? g.toNonIndexed() : g;
          if (nonindexed !== g) g.dispose();
          const colors = new Float32Array(nonindexed.attributes.position.count * 3);
          for (let i = 0; i < colors.length; i += 3) { colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b; }
          nonindexed.setAttribute('color', new THREE.BufferAttribute(colors, 3));
          if (!byMaterial.has(material)) byMaterial.set(material, []); byMaterial.get(material).push(nonindexed);
        }
        prefabs.set(prefabKey, [...byMaterial].map(([material, parts]) => {
          const geometry = mergeGeometries(parts); parts.forEach((g) => g.dispose()); return [geometry, material];
        }));
      }
      for (const [geometry, material] of prefabs.get(prefabKey)) {
        usedMaterials.add(material);
        if (material.transparent) {
          // Three sorts objects, not instances. Share prefab buffers/materials but
          // give each transparent record its own render object and world transform.
          // Self/intersecting surfaces still have ordinary alpha-sorting limits.
          for (const it of items) {
            const mesh = new THREE.Mesh(geometry, material);
            mesh.matrixAutoUpdate = false; mesh.matrix.fromArray(objectMatrix('furniture', it)); mesh.matrixWorldNeedsUpdate = true;
            mesh.castShadow = mesh.receiveShadow = true;
            mesh.userData = { kind: 'furniture', owner: () => it }; grp.add(mesh);
          }
        } else {
          const im = new THREE.InstancedMesh(geometry, material, items.length);
          items.forEach((it, i) => im.setMatrixAt(i, matrix.fromArray(objectMatrix('furniture', it))));
          im.castShadow = im.receiveShadow = true;
          im.instanceMatrix.needsUpdate = true; im.computeBoundingBox(); im.computeBoundingSphere();
          im.userData = { kind: 'furniture', owner: (i) => items[i] }; grp.add(im);
        }
      }
    }
    for (const [key, material] of this.propMats) if (!usedMaterials.has(material)) { material.dispose(); this.propMats.delete(key); }
  }

  // ---------------------------------------------------------------- building materials (from defs.materials)
  material(m, fac) {
    const d = this.defs.materials?.[m] ?? {};
    // Colour lives in vertices, so ordinary palette variants share a draw call.
    // Emissive colour/intensity and opacity remain part of the material descriptor.
    const key = JSON.stringify([fac ?? '', d.roughness ?? this.legacyRoughness(d), d.metalness ?? 0,
      d.opacity ?? 1, d.emissive ?? '', d.emissiveIntensity ?? 0, d.glow ?? 0, d.nightGlow ?? 0,
      d.glow || d.nightGlow ? d.color : '']);
    let mat = this.mats.get(key);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ vertexColors: true });
      mat.userData = { m, fac }; this.styleMaterial(mat); this.mats.set(key, mat);
    }
    return mat;
  }
  legacyRoughness(d) { return Math.max(0.12, Math.min(1, Math.sqrt(2 / ((d.shininess ?? 5) + 2)))); }
  styleMaterial(mat) {
    const { m, fac } = mat.userData, d = this.defs.materials?.[m] ?? {};
    const tx = fac ? this.facades[fac] : null, glows = (d.glow || d.nightGlow) > 0;
    mat.color.set(0xffffff);
    mat.roughness = d.roughness ?? this.legacyRoughness(d); mat.metalness = d.metalness ?? 0;
    mat.opacity = d.opacity ?? 1; mat.transparent = mat.opacity < 1; mat.depthWrite = !mat.transparent;
    mat.map = tx?.map ?? null;
    mat.bumpMap = this.quality === 'low' ? null : tx?.bumpMap ?? null;
    mat.bumpScale = 0.075;
    mat.emissiveMap = tx?.emissiveMap ?? null;
    mat.emissive.set(d.emissive ?? (glows ? d.color ?? MISSING : tx?.emissiveMap ? 0xffffff : 0x000000));
    mat.emissiveIntensity = d.emissiveIntensity ?? (glows ? (this.night ? d.nightGlow : d.glow) ?? 0 : tx?.emissiveMap && this.night ? 1 : 0);
    mat.needsUpdate = true;
  }
  /** Regenerate shared canvas textures; do not recreate a texture for each building. */
  refreshFacades() {
    facadeTextures(this.defs.facades, this.anisotropy, this.facades);
    // Facade names/styles may also have changed the material assignment.
    this.refreshMaterials();
  }
  refreshMaterials() {
    const old = [...new Set(this.mats.values())]; this.mats.clear();
    if (this.L.buildings) this.buildBlocks();
    disposeRenderObjects([], { extra: old });
    if (this.L.furniture) this.buildFurniture();
    for (const [m, mat] of this.smats) mat.color.set(this.defs.surfaces?.[m]?.color ?? MISSING);
    for (const [name, m] of this.rmats) m.color.set(this.defs.roadMaterials?.[name]?.color ?? MISSING);
  }
  setNight(on) {
    this.night = on; for (const mat of this.mats.values()) this.styleMaterial(mat);
    for (const mat of this.propMats.values()) mat.emissiveIntensity = on ? mat.userData.pbr.night : mat.userData.pbr.day;
  }
  setQuality(quality) {
    if (!['low', 'medium', 'high'].includes(quality)) throw new Error('quality must be low, medium or high');
    this.quality = quality; this.buildBlocks();
    for (const mat of this.mats.values()) this.styleMaterial(mat);
  }
  /** Cheap distance LOD for relief geometry; shell and picking remain present. */
  update(camera) {
    if (!camera) return;
    this.terrainChunks?.update(camera, this.quality);
    const at = camera.getWorldPosition(new THREE.Vector3());
    for (const t of this.tiles.blocks.values()) {
      if (!t.obj) continue;
      const bounds = t.obj.userData.bounds;
      const range = this.detailDistance * (this.quality === 'high' ? 2 : 1);
      const threshold = range * (t.obj.userData.detailVisible === false ? 0.85 : 1.15);
      const near = this.quality !== 'low' && (!bounds || bounds.distanceToPoint(at) < threshold);
      t.obj.userData.detailVisible = near;
      t.obj.traverse((o) => { if (o.userData.detail) o.visible = near; });
    }
  }
  /** Structural counts; renderer.info is still authoritative for visible GPU draws. */
  stats() {
    const stats = { meshes: 0, instances: 0, triangles: 0, materials: new Set(), buildingMeshes: 0, cells: this.tiles.blocks.size };
    for (const name of ['terrain', 'roads', 'furniture', 'buildings']) this.groups[name].traverse((o) => {
      if (!o.isMesh) return;
      stats.meshes++; if (o.userData.kind === 'building') stats.buildingMeshes++;
      const n = o.isInstancedMesh ? o.count : 1; stats.instances += o.isInstancedMesh ? n : 0;
      stats.triangles += (o.geometry.index?.count ?? o.geometry.attributes.position?.count ?? 0) / 3 * n;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) stats.materials.add(m);
    });
    stats.materials = stats.materials.size;
    return stats;
  }
  clearGroup(grp) { disposeRenderObjects([grp]); grp.clear(); }
  removeTicker(key) {
    const index = this.tickers.indexOf(this[key]); if (index >= 0) this.tickers.splice(index, 1);
    this[key] = null;
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.removeTicker('trainTick'); this.removeTicker('windTick');
    const roots = ['terrain', 'roads', 'furniture', 'buildings'].map((n) => this.groups[n]);
    const extra = [this.terrainGeo, ...this.mats.values(), ...this.propMats.values(), ...this.smats.values(), ...this.rmats.values(), ...Object.values(this.facades).flatMap(Object.values)];
    disposeRenderObjects(roots, { textures: true, extra });
    for (const root of roots) root.removeFromParent();
    for (const group of Object.values(this.groups)) group.clear();
    this.mats.clear(); this.propMats.clear(); this.smats.clear(); this.rmats.clear(); this.facades = {};
    for (const tiles of Object.values(this.tiles)) tiles.clear();
    this.roadTiles.clear(); this.roadTileOf.clear(); this.tileOf.clear(); this.hidden.clear();
    this.terrainMesh = this.terrainGeo = this.terrainChunks = this.terrainRenderMaterial = this.roadWorld = this.bentObj = null;
  }

  // ---------------------------------------------------------------- tiles
  keyOf(x, y) { return this.tileSize === Infinity ? '0' : Math.floor(x / this.tileSize) + ',' + Math.floor(y / this.tileSize); }
  recKey(kind, rec) {
    const p = kind === 'blocks' ? buildingCenter(rec) : rec.p?.[0];
    return p ? this.keyOf(p[0], p[1]) : '0';
  }
  buildTiled(kind, recs, build) {
    const tiles = this.tiles[kind];
    for (const t of tiles.values()) { this.disposeTile(t); for (const rec of t.recs) this.tileOf.delete(rec); }
    tiles.clear(); this.groups[kind].clear();
    for (const rec of recs) this.place(kind, rec);
    for (const key of tiles.keys()) this.buildTile(kind, key, build);
  }
  place(kind, rec) {
    const key = this.recKey(kind, rec), tiles = this.tiles[kind];
    if (!tiles.has(key)) tiles.set(key, { recs: new Set(), obj: null });
    tiles.get(key).recs.add(rec); this.tileOf.set(rec, key);
    return key;
  }
  disposeTile(t) { if (t.obj) { disposeRenderObjects([t.obj], { materials: false }); t.obj.removeFromParent(); t.obj = null; } }
  buildTile(kind, key, build = kind === 'blocks' ? this.blockTile : this.surfaceTile) {
    const t = this.tiles[kind].get(key);
    if (!t) return;
    this.disposeTile(t);
    if (!t.recs.size) { this.tiles[kind].delete(key); return; }
    t.obj = build.call(this, [...t.recs].filter((r) => !this.hidden.has(r)));
    this.groups[kind].add(t.obj);
  }
  /** Move a changed/added/removed record to its tile; returns the tile keys that need a rebuild. */
  retile(kind, rec, removed = false) {
    const old = this.tileOf.get(rec), tiles = this.tiles[kind];
    if (old !== undefined) { tiles.get(old)?.recs.delete(rec); this.tileOf.delete(rec); }
    const keys = new Set(old !== undefined ? [old] : []);
    if (!removed) keys.add(this.place(kind, rec));
    return keys;
  }
  /** A record was changed/added/removed: re-tile it and rebuild the affected tiles. */
  touch(kind, rec, removed = false) {
    for (const k of this.retile(kind, rec, removed)) this.buildTile(kind, k);
    if (kind === 'surfaces') this.terrainChunks?.setSurfaces(this.L.buildings.surfaces);
  }

  blockTile(recs, { local = false } = {}) {
    const grp = new THREE.Group(), byMat = new Map();
    const mode = this.quality === 'low' ? 'none' : this.quality === 'high' && this.detail !== 'none' ? 'high' : this.detail;
    for (const it of recs) {
      ensureLocalBuilding(it);
      const matrix = new THREE.Matrix4().fromArray(buildingMatrix(it));
      let pieces;
      try { pieces = buildingGeometries(it, { detail: mode }); }
      catch (error) { console.warn('Skipping invalid building geometry', it.id ?? it.type, error); continue; }
      for (const { g, m, role } of pieces) {
        const fac = role === 'wall' ? facadeFor(this.defs, m, it.type) : null;
        const material = this.material(m, fac), detail = role === 'detail';
        if (!byMat.has(material)) byMat.set(material, new Map());
        const owners = byMat.get(material), ownerKey = material.transparent ? it : null;
        if (!owners.has(ownerKey)) owners.set(ownerKey, [[], []]);
        const c = color(this.defs.materials?.[m]?.color), count = g.attributes.position.count, colors = new Float32Array(count * 3);
        for (let i = 0; i < colors.length; i += 3) { colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b; }
        g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        if (!local) g.applyMatrix4(matrix);
        owners.get(ownerKey)[detail ? 1 : 0].push({ g, rec: it });
      }
    }
    // Opaque geometry remains tile/material merged. Transparent geometry is merged
    // only within one authored building, enabling Three's per-object depth sort.
    // This is object sorting, not order-independent transparency for self/intersections.
    for (const [material, owners] of byMat) for (const levels of owners.values()) levels.forEach((entries, detail) => {
      if (!entries.length) return;
      const mesh = ownedMesh(entries, material, 'building'); mesh.userData.detail = !!detail; grp.add(mesh);
    });
    grp.userData.bounds = new THREE.Box3().setFromObject(grp);
    return grp;
  }
  /** Standalone local preview: update its matrix during transform drags, no geometry rebuild. */
  buildingPreview(rec) {
    const group = this.blockTile([rec], { local: true });
    group.matrixAutoUpdate = false; group.matrix.fromArray(buildingMatrix(rec)); group.updateMatrixWorld(true);
    return group;
  }
  buildBlocks() { this.buildTiled('blocks', this.L.buildings.items ?? []); }

  // ground surfaces: triangulated, densified and draped on the terrain
  surfaceTile(recs) {
    const grp = new THREE.Group(), byMat = new Map(), H = this.H ?? (() => 0);
    for (const s of recs) {
      if (!(s.p?.length >= 3)) continue;
      let g;
      try { g = drape(new THREE.ShapeGeometry(shapeOf(s.p, s.holes)), H, this.defs.surfaces?.[s.m]?.lift ?? 0.15); } catch { continue; }
      if (!byMat.has(s.m)) byMat.set(s.m, []);
      byMat.get(s.m).push({ g, rec: s });
    }
    for (const [m, entries] of byMat) {
      if (!this.smats.has(m)) this.smats.set(m, new THREE.MeshLambertMaterial({ color: color(this.defs.surfaces?.[m]?.color), side: THREE.DoubleSide }));
      const mesh = ownedMesh(entries, this.smats.get(m), 'surface');
      mesh.renderOrder = 1; grp.add(mesh);
    }
    return grp;
  }
  buildSurfaces() {
    this.buildTiled('surfaces', this.L.buildings.surfaces ?? []);
    this.terrainChunks?.setSurfaces(this.L.buildings.surfaces);
  }

  // ---------------------------------------------------------------- trees: two crown shapes, random scale and tint
  buildTrees() {
    const grp = this.groups.trees; this.clearGroup(grp);
    const cells = new Map();
    (this.L.buildings.trees ?? []).forEach((rec, index) => {
      if (this.hidden.has(rec)) return;
      const key = this.keyOf(...rec);
      if (!cells.has(key)) cells.set(key, []); cells.get(key).push({ rec, index });
    });
    if (!cells.size) return;
    const trunk = new THREE.CylinderGeometry(0.18, 0.25, 3, 5); trunk.rotateX(Math.PI / 2); trunk.translate(0, 0, 1.5);
    const crowns = [new THREE.IcosahedronGeometry(2.6, 0), new THREE.ConeGeometry(2.2, 6, 6).rotateX(Math.PI / 2)];
    crowns[0].translate(0, 0, 4.6); crowns[1].translate(0, 0, 5.5);
    const wood = new THREE.MeshLambertMaterial({ color: 0x5a4330 }), leaves = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
    for (const T of cells.values()) {
      const tm = new THREE.InstancedMesh(trunk, wood, T.length);
      const cm = crowns.map((c) => new THREE.InstancedMesh(c, leaves, T.length));
      const cnt = [0, 0], who = [[], []];
      T.forEach(({ rec: [x, y, z], rec, index: i }, slot) => {
        const s = 0.7 + ((i * 7919) % 100) / 160, k = (i * 31) % 3 === 0 ? 1 : 0;
        m4.compose(v.set(x, y, z - 0.3), q, sc.set(s, s, s)); tm.setMatrixAt(slot, m4);
        who[k].push(rec); cm[k].setMatrixAt(cnt[k], m4);
        cm[k].setColorAt(cnt[k]++, col.setHSL(0.24 + ((i * 13) % 10) / 100, 0.45, 0.22 + ((i * 17) % 10) / 100));
      });
      cm.forEach((c, k) => { c.count = cnt[k]; if (c.instanceColor) c.instanceColor.needsUpdate = true; c.userData = { kind: 'tree', owner: (i) => who[k][i] }; });
      tm.userData = { kind: 'tree', owner: (i) => T[i].rec };
      for (const im of [tm, ...cm]) { im.castShadow = im.receiveShadow = true; im.instanceMatrix.needsUpdate = true; im.computeBoundingBox(); im.computeBoundingSphere(); }
      grp.add(tm, ...cm);
    }
  }

  // ---------------------------------------------------------------- railway: ballast bed + two rails
  buildRails() {
    const grp = this.groups.rails;
    this.clearGroup(grp);
    const bed = new THREE.MeshLambertMaterial({ color: 0x6b645a, side: THREE.DoubleSide });
    const steel = new THREE.MeshPhongMaterial({ color: 0xb8bcc0, shininess: 80, side: THREE.DoubleSide });
    const concrete = new THREE.MeshLambertMaterial({ color: 0xa8a59e, side: THREE.DoubleSide });
    const H = this.H ?? (() => 0), piers = [];
    for (const pts of this.L.buildings.rails ?? []) {
      if (this.hidden.has(pts) || pts.length < 2) continue;
      const own = { kind: 'rail', owner: () => pts };
      const b = new THREE.Mesh(ribbon(pts, 2.4, 0.15), bed); b.userData = own; grp.add(b);
      // above the ground the track is a viaduct: a girder under the bed, carried by piers
      for (const [i0, i1] of elevatedRuns(pts, H)) {
        const g = new THREE.Mesh(girder(pts.slice(i0, i1 + 1), GIRDER.hw, -0.1, GIRDER.depth), concrete); g.userData = own; grp.add(g);
      }
      for (const q of railPiers(pts, H)) piers.push({ q, pts });
      for (const off of [-0.75, 0.75]) {
        const rp = pts.map((p, i) => {
          const a = pts[Math.max(i - 1, 0)], c = pts[Math.min(i + 1, pts.length - 1)];
          const tx = c[0] - a[0], ty = c[1] - a[1], L = Math.hypot(tx, ty) || 1;
          return [p[0] - ty / L * off, p[1] + tx / L * off, p[2]];
        });
        const r = new THREE.Mesh(ribbon(rp, 0.09, 0.35), steel); r.userData = own; grp.add(r);
      }
    }
    if (piers.length) {
      const box = new THREE.BoxGeometry(PIER.d, PIER.w, 1); box.translate(0, 0, 0.5);
      const im = new THREE.InstancedMesh(box, concrete, piers.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), Z = new THREE.Vector3(0, 0, 1);
      piers.forEach(({ q: p }, i) => im.setMatrixAt(i, m4.compose(v.set(p.x, p.y, p.z0), q.setFromAxisAngle(Z, p.a), sc.set(1, 1, p.z1 - p.z0))));
      im.castShadow = im.receiveShadow = true; im.computeBoundingSphere();
      im.userData = { kind: 'rail', owner: (i) => piers[i].pts };
      grp.add(im);
    }
    grp.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  }

  // ---------------------------------------------------------------- wind turbines: rotors spun by a ticker
  buildWind() {
    const grp = this.groups.wind;
    this.clearGroup(grp);
    this.removeTicker('windTick');
    const WT = (this.L.buildings.wind ?? []).filter((w) => !this.hidden.has(w));
    if (!WT.length) return;
    const tower = new THREE.CylinderGeometry(1.4, 2.4, 80, 10); tower.rotateX(Math.PI / 2); tower.translate(0, 0, 40);
    const nac = new THREE.BoxGeometry(10, 3.6, 3.6); nac.translate(-2, 0, 81);
    const blade = new THREE.BoxGeometry(0.6, 1.8, 42); blade.translate(0, 0, 21);
    const white = new THREE.MeshLambertMaterial({ color: 0xf2f3f4 });
    const tm = new THREE.InstancedMesh(tower, white, WT.length), nm = new THREE.InstancedMesh(nac, white, WT.length);
    const bm = new THREE.InstancedMesh(blade, white, WT.length * 3);
    const m4 = new THREE.Matrix4(), v = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI * 0.85);
    WT.forEach(([x, y, z], i) => { m4.compose(v.set(x, y, z), yaw, sc); tm.setMatrixAt(i, m4); nm.setMatrixAt(i, m4); });
    for (const im of [tm, nm]) { im.computeBoundingSphere(); im.userData = { kind: 'wind', owner: (i) => WT[i] }; }
    bm.userData = { kind: 'wind', owner: (i) => WT[(i / 3) | 0] };
    for (const im of [tm, nm, bm]) im.castShadow = im.receiveShadow = true;
    grp.add(tm, nm, bm);
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(yaw), qb = new THREE.Quaternion(), hubOff = new THREE.Vector3(3.5, 0, 81).applyQuaternion(yaw);
    const spin = (t) => {
      WT.forEach(([x, y, z], i) => {
        for (let k = 0; k < 3; k++) {
          qb.setFromAxisAngle(axis, t * 1.1 + i * 0.7 + k * 2.0944).multiply(yaw);
          m4.compose(v.set(x + hubOff.x, y + hubOff.y, z + hubOff.z), qb, sc);
          bm.setMatrixAt(i * 3 + k, m4);
        }
      });
      bm.instanceMatrix.needsUpdate = true;
    };
    spin(0); bm.computeBoundingSphere();
    this.tickers.push(this.windTick = spin);
  }

  // ---------------------------------------------------------------- trains: loco + coaches following route polylines (closed = loop, open = shuttle)
  buildTrains() {
    const grp = this.groups.trains;
    this.clearGroup(grp);
    this.removeTicker('trainTick');
    if (!this.showTrains) return;
    const routes = (this.L.buildings.trains ?? []).filter((r) => r.pts?.length >= 2 && !this.hidden.has(r));
    if (!routes.length) return;
    const CARS = 7, LEN = 23, body = new THREE.BoxGeometry(21.5, 3.1, 3.8); body.translate(0, 0, 2.3);
    const roof = new THREE.BoxGeometry(21, 2.6, 0.5); roof.translate(0, 0, 4.4);
    const trains = [];
    for (const r of routes) {
      const P = r.pts, S = [0];
      for (let i = 1; i < P.length; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
      const L = S[S.length - 1], n = r.closed ? 3 : 2;
      for (let k = 0; k < n; k++) trains.push({ r, P, S, L, closed: r.closed, phase: k / n, speed: 28 + k * 4 });
    }
    const total = trains.length * CARS;
    const coach = new THREE.MeshPhongMaterial({ color: 0xc7ccd1, shininess: 60 });
    const mBody = new THREE.InstancedMesh(body, coach, total), mRoof = new THREE.InstancedMesh(roof, new THREE.MeshLambertMaterial({ color: 0x55595e }), total);
    const col = new THREE.Color();
    for (let i = 0; i < total; i++) mBody.setColorAt(i, col.set(i % CARS === 0 ? 0xd0312d : 0xffffff));
    for (const im of [mBody, mRoof]) { im.userData = { kind: 'train', owner: (i) => trains[(i / CARS) | 0].r }; im.frustumCulled = false; }
    grp.add(mBody, mRoof);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), Z = new THREE.Vector3(0, 0, 1);
    const at = (t, s) => {                  // position + heading at arc length s
      let lo = 0, hi = t.S.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t.S[mid] < s) lo = mid; else hi = mid; }
      const a = t.P[lo], b = t.P[hi], u = (s - t.S[lo]) / Math.max(t.S[hi] - t.S[lo], 1e-6);
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, Math.atan2(b[1] - a[1], b[0] - a[0])];
    };
    const animate = (sec) => {
      trains.forEach((t, ti) => {
        let head, dir = 1;
        if (t.closed) head = (sec * t.speed + t.phase * t.L) % t.L;
        else {                              // shuttle: run, turn back at the ends
          const span = Math.max(t.L - CARS * LEN, 1), x = (sec * t.speed + t.phase * span * 2) % (span * 2);
          dir = x < span ? 1 : -1; head = (x < span ? x : span * 2 - x) + CARS * LEN;
        }
        for (let c = 0; c < CARS; c++) {
          let s = head - dir * c * LEN; if (t.closed) s = (s + t.L) % t.L; else s = Math.min(Math.max(s, 0), t.L);
          const [x, y, z, h] = at(t, s);
          m4.compose(v.set(x, y, z + 0.4), q.setFromAxisAngle(Z, h), one);
          mBody.setMatrixAt(ti * CARS + c, m4); mRoof.setMatrixAt(ti * CARS + c, m4);
        }
      });
      mBody.instanceMatrix.needsUpdate = mRoof.instanceMatrix.needsUpdate = true;
    };
    animate(0);
    if (this.animateTrains) this.tickers.push(this.trainTick = animate);
  }

  // ---------------------------------------------------------------- power lines: posts + wires derived from the route; loose cables as stored
  postGeometry(type) {
    const T = POWER_TYPES[type], parts = [];
    const box = (w, d, h, z) => { const g = new THREE.BoxGeometry(w, d, h); g.translate(0, 0, z + h / 2); return g; };
    if (type === 'pole') {
      const c = new THREE.CylinderGeometry(0.13, 0.17, T.h, 6); c.rotateX(Math.PI / 2); c.translate(0, 0, T.h / 2);
      parts.push(c, ...T.arms.map(([h, l]) => box(0.15, l * 2, 0.15, h)));
    } else {
      // a tower: four legs leaning in to a slim mast, cross-arms tapering to the wire ends, an earth-wire peak
      const s = T.h / 38, leg = (x0, y0, x1, y1, z0, z1, r) => {
        const d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0), L = d.length(), g = new THREE.CylinderGeometry(r, r, L, 4);
        g.translate(0, L / 2, 0);              // along +Y from the origin, then turned onto the leg
        g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
        g.translate(x0, y0, z0);
        return g;
      };
      const B = 4.2 * s, W = 1.1 * s, z1 = 26 * s;
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) parts.push(leg(sx * B, sy * B, sx * W, sy * W, 0, z1, 0.32), leg(sx * W, sy * W, sx * 0.5, sy * 0.5, z1, T.h - 1, 0.22));
      for (const z of [7, 14, 20].map((v) => v * s)) {           // horizontal bracing between the legs
        const w = B + (W - B) * (z / z1);
        parts.push(box(0.25, w * 2, 0.25, z), box(w * 2, 0.25, 0.25, z));
      }
      for (const [h, l] of T.arms) for (const sy of [1, -1]) parts.push(leg(0, sy * 1, 0, sy * l, h, h + 0.6, 0.35), leg(0, sy * 1, 0, sy * l, h + 2.6, h + 0.6, 0.18));
    }
    const flat = parts.map((g) => { if (!g.index) return g; const n = g.toNonIndexed(); g.dispose(); return n; });
    const merged = mergeGeometries(flat); flat.forEach((g) => g.dispose()); return merged;
  }
  buildCables() {
    const grp = this.groups.cables;
    this.clearGroup(grp);
    const cab = [], H = this.H ?? (() => 0), posts = {};
    for (const rec of this.L.buildings.powerlines ?? []) {
      if (this.hidden.has(rec)) continue;
      const { posts: P, wires } = powerLayout(rec, H);
      for (const p of P) (posts[POWER_TYPES[rec.type] ? rec.type : 'tower'] ??= []).push({ p, rec });
      for (const w of wires) for (let i = 0; i + 1 < w.length; i++) cab.push(...w[i], ...w[i + 1]);
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), Z = new THREE.Vector3(0, 0, 1);
    for (const [type, list] of Object.entries(posts)) {
      const im = new THREE.InstancedMesh(this.postGeometry(type), new THREE.MeshLambertMaterial({ color: type === 'pole' ? 0x6b5640 : 0x8d9296 }), list.length);
      list.forEach(({ p }, i) => im.setMatrixAt(i, m4.compose(v.set(p.x, p.y, p.z), q.setFromAxisAngle(Z, p.a), one)));
      im.castShadow = im.receiveShadow = true; im.computeBoundingSphere();
      im.userData = { kind: 'powerline', owner: (i) => list[i].rec };
      grp.add(im);
    }
    for (const c of this.L.buildings.cables ?? []) if (!this.hidden.has(c)) for (let i = 0; i + 1 < c.length; i++) cab.push(...c[i], ...c[i + 1]);
    const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(cab, 3));
    const lines = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0x2a2d30 }));
    lines.raycast = () => {};
    grp.add(lines);
  }
}
