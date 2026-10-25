// Everything derived from the road graph, kept in step with it: asphalt meshes per owner
// ('e<id>' edge, 'n<id>' node), pier bents, owned roadside furniture and the graded terrain.
// The graph records (roads.nodes / roads.edges) and terrain.base are the only sources.
import { buildNet, computeTrims, groundSampler, RoadIndex } from './roadnet.js';
import { Bufs, buildEdge, buildBents, buildNode, mergeBufs } from './roadmesh.js';
import { edgeFurniture, nodeFurniture } from './furniture.js';
import { regrade, edgeWindow } from './carve.js';

const NEIGHBOUR = 40;                     // m: roads this close may cut markings / barriers of each other

export function bbox(P, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of P) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}
const hit = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
// does any sample of the edge come within its half width of the box? (a long road's bbox overlaps half the map)
const nearBox = (e, z) => e.P.some((p) => p[0] >= z[0] - e.hwt && p[0] <= z[2] + e.hwt && p[1] >= z[1] - e.hwt && p[1] <= z[3] + e.hwt);
const union = (a, b) => (a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b);

export class RoadWorld {
  constructor(doc) { this.doc = doc; this.rebuildAll(); }
  get roads() { return this.doc.layers.roads; }
  get terrain() { return this.doc.layers.terrain; }

  rebuildAll() {
    this.net = buildNet(this.roads ?? {});
    this.ground = groundSampler(this.terrain);
    this.idx = new RoadIndex(this.net.edges);
    this.bufs = new Map();
    for (const e of this.net.edges) this.bufs.set('e' + e.id, this.edgeBufs(e));
    for (const nd of this.net.nodes) this.bufs.set('n' + nd.id, buildNode(nd));
    this.bents = buildBents(this.net.edges, this.idx, this.ground);
  }
  edgeBufs(e) { const L = new Bufs(); buildEdge(e, L, this.idx, this.ground); return L; }
  /** owner key -> { kind, rec, at: [x, y] } */
  owner(key) {
    const id = +key.slice(1);
    if (key[0] === 'e') { const e = this.net.edgeById.get(id); return e && { kind: 'edge', rec: e.rec, at: e.P[0] }; }
    const nd = this.net.nodeById.get(id); return nd && { kind: 'node', rec: nd.rec, at: nd.pos };
  }
  /** The road mesh in the shape physics wants: { material: { v, i } }. */
  mesh() { return mergeBufs([...this.bufs.values(), this.bents]); }

  /**
   * Records changed. edges / nodes: ids edited, added or removed; before: bounding boxes of their
   * geometry before the change (so roads that used to overlap them are refreshed too).
   * opts.live: a drag in progress — rebuild just these roads and their junctions, leave neighbours,
   * bents, furniture and terrain until the drop.
   * Returns { owners: Set of owner keys rebuilt or gone, box: re-graded cell box or null }.
   */
  update({ edges = [], nodes = [], before = [] } = {}, { live = false, terrain = !live, furniture = !live } = {}) {
    const old = this.net;
    this.net = buildNet(this.roads);
    this.ground = groundSampler(this.terrain);
    const net = this.net, owners = new Set();
    const nodeIds = new Set(nodes);
    for (const id of edges) for (const e of [old.edgeById.get(id), net.edgeById.get(id)]) for (const nd of e?.n ?? []) if (nd) nodeIds.add(nd.id);
    const affNodes = [...nodeIds].map((id) => net.nodeById.get(id)).filter(Boolean);
    computeTrims(net, affNodes);
    // edges to rebuild: the changed ones, every arm of a re-trimmed node, and roads overlapping either
    const edgeIds = new Set(edges);
    for (const nd of affNodes) for (const [e] of nd.edges) edgeIds.add(e.id);
    const zones = [...before.map((b) => [b[0] - NEIGHBOUR, b[1] - NEIGHBOUR, b[2] + NEIGHBOUR, b[3] + NEIGHBOUR])];
    for (const id of edges) { const e = net.edgeById.get(id); if (e) zones.push(bbox(e.P, NEIGHBOUR + e.hwt)); }
    if (!live) for (const e of net.edges) if (!edgeIds.has(e.id) && zones.some((z) => hit(z, bbox(e.P, e.hwt)) && nearBox(e, z))) edgeIds.add(e.id);
    const nodeSet = new Set(affNodes.map((n) => n.id));
    for (const id of edgeIds) for (const nd of net.edgeById.get(id)?.n ?? []) if (nd) nodeSet.add(nd.id);
    this.idx = new RoadIndex(net.edges);
    for (const id of edgeIds) {
      const e = net.edgeById.get(id), key = 'e' + id;
      owners.add(key);
      if (e) this.bufs.set(key, this.edgeBufs(e)); else this.bufs.delete(key);
    }
    for (const id of nodeIds) if (!net.nodeById.has(id)) { this.bufs.delete('n' + id); owners.add('n' + id); }
    for (const id of nodeSet) { const nd = net.nodeById.get(id); if (nd) { this.bufs.set('n' + id, buildNode(nd)); owners.add('n' + id); } }
    if (!live) this.bents = buildBents(net.edges, this.idx, this.ground);
    if (furniture) this.regenFurniture(owners);
    let box = null;
    if (terrain && this.terrain?.base) {
      let area = null;
      for (const b of before) area = union(area, b);
      for (const id of edgeIds) { const e = net.edgeById.get(id); if (e) area = union(area, bbox(e.P)); }
      if (area) {
        const t = this.terrain, pad = 140;
        box = [Math.max(0, Math.floor((area[0] - pad - t.x0) / t.res)), Math.max(0, Math.floor((area[1] - pad - t.y0) / t.res)),
          Math.min(t.nx - 1, Math.ceil((area[2] + pad - t.x0) / t.res)), Math.min(t.ny - 1, Math.ceil((area[3] + pad - t.y0) / t.res))];
        regrade(t, net, box);
      }
    }
    return { owners, box };
  }

  /** Replace the furniture owned by these roads with freshly placed items. */
  regenFurniture(owners) {
    const items = this.doc.layers.furniture?.items;
    if (!items) return;
    const keep = items.filter((it) => !it.owner || !owners.has(it.owner));
    for (const key of owners) {
      const id = +key.slice(1);
      if (key[0] === 'e') { const e = this.net.edgeById.get(id); if (e) keep.push(...edgeFurniture(e)); }
      else { const nd = this.net.nodeById.get(id); if (nd) keep.push(...nodeFurniture(nd)); }
    }
    items.length = 0; items.push(...keep);
  }

  /** Re-grade the whole terrain from terrain.base. */
  regradeAll() { const t = this.terrain; regrade(t, this.net, [0, 0, t.nx - 1, t.ny - 1]); }
  edgeWindow(e) { return edgeWindow(this.terrain, e); }
}
