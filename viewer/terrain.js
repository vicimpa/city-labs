// Chunk-local terrain buffers, independent from the authoritative full CPU grid.
// Coarse blocks bordering a dense block or a chunk boundary retain every border
// sample. A triangle fan stitches those edges without cracks, even across LODs.
import * as THREE from 'three';

function roadMask(t, roads) {
  const mask = new Uint8Array(t.nx * t.ny), pad = t.res * 2;
  for (const edge of roads?.edges ?? []) {
    const width = (roads.classes?.[edge.cls]?.hwt ?? roads.classes?.[edge.cls]?.hw ?? 5) + pad;
    for (let n = 0; n + 1 < (edge.pts?.length ?? 0); n++) {
      const a = edge.pts[n], b = edge.pts[n + 1], dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
      const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - width - t.x0) / t.res));
      const x1 = Math.min(t.nx - 1, Math.ceil((Math.max(a[0], b[0]) + width - t.x0) / t.res));
      const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - width - t.y0) / t.res));
      const y1 = Math.min(t.ny - 1, Math.ceil((Math.max(a[1], b[1]) + width - t.y0) / t.res));
      for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
        const x = t.x0 + i * t.res, y = t.y0 + j * t.res;
        const u = length2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length2)) : 0;
        if ((x - a[0] - dx * u) ** 2 + (y - a[1] - dy * u) ** 2 <= width * width) mask[j * t.nx + i] = 1;
      }
    }
  }
  return mask;
}

function inside(x, y, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

// Draped parks/plazas have centimetre lifts. Coarse terrain must not interpolate
// through those surfaces; preserve their underlying triangulation and a border.
function protectSurfaces(mask, t, surfaces) {
  const pad = t.res * 2;
  for (const s of surfaces ?? []) {
    if (!s.p?.length) continue;
    const xs = s.p.map((p) => p[0]), ys = s.p.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - pad - t.x0) / t.res)), i1 = Math.min(t.nx - 1, Math.ceil((Math.max(...xs) + pad - t.x0) / t.res));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - pad - t.y0) / t.res)), j1 = Math.min(t.ny - 1, Math.ceil((Math.max(...ys) + pad - t.y0) / t.res));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * t.nx + i; if (mask[k]) continue;
      const x = t.x0 + i * t.res, y = t.y0 + j * t.res;
      let hit = inside(x, y, s.p) && !(s.holes ?? []).some((r) => inside(x, y, r));
      if (!hit) for (const ring of [s.p, ...(s.holes ?? [])]) {
        for (let n = 0; n < ring.length; n++) {
          const a = ring[n], b = ring[(n + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
          const u = len2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
          if ((x - a[0] - dx * u) ** 2 + (y - a[1] - dy * u) ** 2 <= pad * pad) { hit = true; break; }
        }
        if (hit) break;
      }
      if (hit) mask[k] = 1;
    }
  }
  return mask;
}

/** The material is shared/owned by World3D; this class owns each chunk geometry. */
export class TerrainChunks {
  constructor(t, source, material, { roads, surfaces = [], chunkCells = 256, quality = 'medium' } = {}) {
    this.t = t; this.source = source; this.material = material; this.chunkCells = chunkCells;
    this.roads = roads; this.roadStamp = this.stampRoads(roads); this.surfaces = surfaces; this.surfaceStamp = this.stamp(surfaces);
    this.mask = protectSurfaces(roadMask(t, roads), t, surfaces); this.quality = quality; this.group = new THREE.Group(); this.chunks = [];
    this.position = new THREE.Vector3(); this.disposed = false;
    for (let j = 0; j < t.ny - 1; j += chunkCells) for (let i = 0; i < t.nx - 1; i += chunkCells) {
      const chunk = { i0: i, j0: j, i1: Math.min(t.nx - 1, i + chunkCells), j1: Math.min(t.ny - 1, j + chunkCells), step: 4, mesh: null };
      chunk.mesh = new THREE.Mesh(this.geometry(chunk, chunk.step), material);
      chunk.mesh.receiveShadow = true;
      chunk.mesh.userData = { kind: 'terrain', terrainChunk: [i, j] };
      chunk.mesh.raycast = () => {}; // Editor picking uses the authoritative heightfield.
      this.chunks.push(chunk); this.group.add(chunk.mesh);
    }
  }

  geometry(chunk, step) {
    const { t, source, mask } = this, pos = [], color = [], normal = [], index = [], samples = [], vertices = new Map();
    const { i0, j0, i1, j1 } = chunk, nx = Math.ceil((i1 - i0) / step), ny = Math.ceil((j1 - j0) / step);
    const dense = new Uint8Array(nx * ny), blocks = [];
    for (let by = 0; by < ny; by++) for (let bx = 0; bx < nx; bx++) {
      const x0 = i0 + bx * step, y0 = j0 + by * step, x1 = Math.min(i1, x0 + step), y1 = Math.min(j1, y0 + step);
      let lo = Infinity, hi = -Infinity, protectedRoad = false;
      for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
        const k = j * t.nx + i, z = t.h[k]; lo = Math.min(lo, z); hi = Math.max(hi, z); protectedRoad ||= !!mask[k];
      }
      // Preserve the exact shoreline and all road cuts, including tunnel mouths.
      const shore = lo <= 1 && hi >= -1;
      dense[by * nx + bx] = step === 1 || protectedRoad || shore ? 1 : 0;
      blocks.push({ bx, by, x0, y0, x1, y1, shore });
    }
    const sample = (i, j) => {
      const key = i + ',' + j;
      if (vertices.has(key)) return vertices.get(key);
      const x = Math.floor(i), y = Math.floor(j), u = i - x, v = j - y;
      const x1 = Math.min(x + 1, t.nx - 1), y1 = Math.min(y + 1, t.ny - 1), ks = [y * t.nx + x, y * t.nx + x1, y1 * t.nx + x, y1 * t.nx + x1];
      const weights = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
      for (const [name, out] of [['position', pos], ['color', color], ['normal', normal]]) {
        const data = source.attributes[name].array;
        for (let c = 0; c < 3; c++) out.push(ks.reduce((sum, k, n) => sum + data[k * 3 + c] * weights[n], 0));
      }
      const id = pos.length / 3 - 1; samples.push(i, j); vertices.set(key, id); return id;
    };
    const quad = (x, y, xx, yy) => {
      const a = sample(x, y), b = sample(xx, y), c = sample(xx, yy), d = sample(x, yy);
      index.push(a, b, c, a, c, d);
    };
    for (const b of blocks) {
      const { bx, by, x0, y0, x1, y1 } = b;
      if (dense[by * nx + bx]) {
        for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) quad(i, j, i + 1, j + 1);
        continue;
      }
      const edges = [by === 0 || dense[(by - 1) * nx + bx], bx === nx - 1 || dense[by * nx + bx + 1],
        by === ny - 1 || dense[(by + 1) * nx + bx], bx === 0 || dense[by * nx + bx - 1]];
      if (!edges.some(Boolean)) { quad(x0, y0, x1, y1); continue; }
      // Counterclockwise perimeter. Split only borders that must match dense neighbours.
      const ring = [];
      for (let i = x0; i < x1; i += edges[0] ? 1 : x1 - x0) ring.push(sample(i, y0));
      for (let j = y0; j < y1; j += edges[1] ? 1 : y1 - y0) ring.push(sample(x1, j));
      for (let i = x1; i > x0; i -= edges[2] ? 1 : x1 - x0) ring.push(sample(i, y1));
      for (let j = y1; j > y0; j -= edges[3] ? 1 : y1 - y0) ring.push(sample(x0, j));
      const center = sample((x0 + x1) / 2, (y0 + y1) / 2);
      for (let i = 0; i < ring.length; i++) index.push(center, ring[i], ring[(i + 1) % ring.length]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    g.normalizeNormals(); g.setIndex(index); g.computeBoundingBox(); g.computeBoundingSphere();
    // CPU-only lookup for brush updates: the topology stays intact away from a new shoreline.
    g.userData.gridSamples = new Float32Array(samples); g.userData.blocks = blocks;
    return g;
  }

  rebuild(chunk, step = chunk.step) {
    const geometry = this.geometry(chunk, step), old = chunk.mesh.geometry;
    chunk.mesh.geometry = geometry; chunk.step = step; old.dispose();
  }

  update(camera, quality = this.quality) {
    if (!camera || this.disposed) return;
    camera.getWorldPosition(this.position);
    const changedQuality = quality !== this.quality; this.quality = quality;
    // Low retains the balanced terrain policy: larger protected blocks can cost
    // more triangles near roads, so low quality only reduces building/texture detail.
    const scale = quality === 'high' ? 2 : 1;
    const limits = [350, 1000, 2400].map((x) => x * scale);
    for (const chunk of this.chunks) {
      const distance = chunk.mesh.geometry.boundingBox.distanceToPoint(this.position);
      const steps = [1, 2, 4, 8];
      let level = limits.findIndex((limit) => distance < limit); if (level < 0) level = 3;
      const oldLevel = steps.indexOf(chunk.step), step = steps[level];
      if (step === chunk.step) continue;
      if (!changedQuality && oldLevel >= 0) {
        // Enter a finer level 15% inside its boundary; leave it 15% outside.
        if (level < oldLevel && distance > limits[level] * 0.85) continue;
        if (level > oldLevel && distance < limits[oldLevel] * 1.15) continue;
      }
      this.rebuild(chunk, step);
    }
  }

  updateRegion(i0, j0, i1, j1) {
    const { t, source } = this;
    for (const c of this.chunks) {
      if (c.i0 > i1 || c.i1 < i0 || c.j0 > j1 || c.j1 < j0) continue;
      const g = c.mesh.geometry;
      let topologyChanged = false;
      if (c.step !== 1) for (const b of g.userData.blocks) {
        if (b.x0 > i1 || b.x1 < i0 || b.y0 > j1 || b.y1 < j0) continue;
        let lo = Infinity, hi = -Infinity;
        for (let j = b.y0; j <= b.y1; j++) for (let i = b.x0; i <= b.x1; i++) {
          const z = t.h[j * t.nx + i]; lo = Math.min(lo, z); hi = Math.max(hi, z);
        }
        if ((lo <= 1 && hi >= -1) !== b.shore) { topologyChanged = true; break; }
      }
      if (topologyChanged) { this.rebuild(c); continue; }
      const samples = g.userData.gridSamples;
      let first = Infinity, last = -1;
      for (let n = 0; n < samples.length / 2; n++) {
        const i = samples[n * 2], j = samples[n * 2 + 1];
        if (i < i0 - 1 || i > i1 + 1 || j < j0 - 1 || j > j1 + 1) continue;
        const x = Math.floor(i), y = Math.floor(j), u = i - x, v = j - y;
        const xx = Math.min(x + 1, t.nx - 1), yy = Math.min(y + 1, t.ny - 1);
        const ks = [y * t.nx + x, y * t.nx + xx, yy * t.nx + x, yy * t.nx + xx], weights = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
        for (const name of ['position', 'color', 'normal']) {
          const data = source.attributes[name].array, target = g.attributes[name];
          for (let axis = 0; axis < 3; axis++) target.array[n * 3 + axis] = ks.reduce((sum, k, a) => sum + data[k * 3 + axis] * weights[a], 0);
          if (name === 'normal') {
            const k = n * 3, length = Math.hypot(target.array[k], target.array[k + 1], target.array[k + 2]) || 1;
            for (let axis = 0; axis < 3; axis++) target.array[k + axis] /= length;
          }
        }
        first = Math.min(first, n); last = Math.max(last, n);
      }
      if (last < 0) continue;
      for (const attr of Object.values(g.attributes)) { attr.clearUpdateRanges(); attr.addUpdateRange(first * 3, (last - first + 1) * 3); attr.needsUpdate = true; }
      g.computeBoundingBox(); g.computeBoundingSphere();
    }
  }

  setRoads(roads) {
    const stamp = this.stampRoads(roads); if (stamp === this.roadStamp) return;
    this.roadStamp = stamp; this.roads = roads; this.mask = protectSurfaces(roadMask(this.t, roads), this.t, this.surfaces);
    for (const chunk of this.chunks) this.rebuild(chunk);
  }

  stampRoads(roads) { return JSON.stringify([Object.entries(roads?.classes ?? {}).map(([key, c]) => [key, c.hw, c.hwt]), (roads?.edges ?? []).map((e) => [e.cls, e.pts])]); }

  stamp(surfaces) { return JSON.stringify((surfaces ?? []).map((s) => [s.p, s.holes])); }

  setSurfaces(surfaces) {
    const stamp = this.stamp(surfaces); if (stamp === this.surfaceStamp) return;
    this.surfaceStamp = stamp; this.surfaces = surfaces;
    const old = this.mask; this.mask = protectSurfaces(roadMask(this.t, this.roads), this.t, surfaces);
    // Rebuild only cells whose protection changed, including their shared edges.
    for (const c of this.chunks) {
      let changed = false;
      for (let j = c.j0; j <= c.j1 && !changed; j++) for (let i = c.i0; i <= c.i1; i++) {
        const k = j * this.t.nx + i; if (old[k] !== this.mask[k]) { changed = true; break; }
      }
      if (changed) this.rebuild(c);
    }
  }

  setMaterial(material) {
    this.material = material;
    for (const c of this.chunks) c.mesh.material = material;
  }

  dispose() {
    if (this.disposed) return; this.disposed = true;
    for (const c of this.chunks) c.mesh.geometry.dispose();
    this.group.clear(); this.chunks.length = 0;
  }
}
