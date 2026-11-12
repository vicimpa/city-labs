// Authoring command regressions: node --test tests/unit/commands.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { emptyWorld } from '../../format/world.js';
import { validateWorld } from '../../format/validate.js';
import { matrixFromTransform, rotateObject } from '../../format/transforms.js';
import { addRoad } from '../../editor/roadedit.js';
import { editRoadControl, transformRecord, updateRoadFlags } from '../../editor/commands.js';
import { FileSession } from '../../mcp/file-session.js';
import { RoadWorld } from '../../world/roadworld.js';

function flatGraph() {
  const doc = emptyWorld({ size_m: 1000, ground: 0 });
  const edge = (id, x0, x1, n) => ({ id, cls: 'street', n,
    pts: Array.from({ length: 26 }, (_, i) => [x0 + (x1 - x0) * i / 25, 0, 0]),
    elev: Array(26).fill(0), tunnel: Array(26).fill(0) });
  doc.layers.roads.edges = [edge(0, -100, 0, [0, 1]), edge(1, 0, 100, [1, 2])];
  doc.layers.roads.nodes = [{ id: 0, p: [-100, 0, 0] }, { id: 1, p: [0, 0, 0] }, { id: 2, p: [100, 0, 0] }];
  return doc;
}

test('joining the interior of an elevated road preserves the split-node height', () => {
  const doc = emptyWorld({ size_m: 1000, ground: 0 });
  const bridge = addRoad(doc, () => 0, [[-100, 0], [100, 0]], 'street', 'bridge', { elevation: 10, snap: false });
  const splitZ = bridge.edge.pts[Math.floor(bridge.edge.pts.length / 2)][2];
  const branch = addRoad(doc, () => 0, [[0, 0, splitZ], [0, 100, 0]], 'street', 'branch');
  assert(branch);
  const node = doc.layers.roads.nodes.find((n) => n.id === branch.edge.n[0]);
  assert.equal(node.p[2], splitZ, 'a split node is constrained by its existing road');
  for (const e of doc.layers.roads.edges) for (const end of [0, 1]) if (e.n[end] === node.id)
    assert(Math.abs(e.pts[end ? e.pts.length - 1 : 0][2] - node.p[2]) < 0.002, 'every incident endpoint meets the node');
});

test('moving a shared road endpoint refreshes bridge flags of adjacent edges', () => {
  const doc = flatGraph(), [first, neighbor] = doc.layers.roads.edges;
  editRoadControl(doc, first, { action: 'move', index: 1, point: [0, 0, 20] });
  const expected = structuredClone(neighbor); updateRoadFlags(doc, expected);
  assert(expected.elev.some(Boolean), 'fixture has an elevated approach');
  assert.deepEqual(neighbor.elev, expected.elev);
  assert.deepEqual(neighbor.tunnel, expected.tunnel);
});

test('road transforms refresh bridge flags on the translated edge and its neighbors', () => {
  const doc = flatGraph(), [first] = doc.layers.roads.edges;
  transformRecord(doc, 'edge', first, { dz: 20 });
  for (const edge of doc.layers.roads.edges) {
    const expected = structuredClone(edge); updateRoadFlags(doc, expected);
    assert.deepEqual(edge.elev, expected.elev);
    assert.deepEqual(edge.tunnel, expected.tunnel);
  }
});

test('world validation rejects non-finite coordinates in surface records', () => {
  const doc = emptyWorld({ size_m: 1000, ground: 0 });
  doc.layers.buildings.surfaces.push({ p: [[0, 0], [1, NaN], [0, 1]], m: 'plaza' });
  assert.throws(() => validateWorld(doc), /finite|surface|coordinate/i);
});

test('generic road edits reject missing graph nodes before committing an unsaveable document', () => {
  // This session is only in memory: ready/save are never called.
  const session = new FileSession('in-memory-only.vspb');
  session.doc = flatGraph(); session.roads = new RoadWorld(session.doc);
  const edge = session.doc.layers.roads.edges[0], before = structuredClone(edge);
  assert.throws(() => session.edit('edge', edge, (rec) => { rec.n = [999, 1000]; }), /node|topology|reference/i);
  assert.deepEqual(edge, before);
  assert.equal(session.history.done.length, 0);
});

test('yaw composition stays correct for arbitrarily tilted and scaled buildings', () => {
  for (let i = 0; i < 100; i++) {
    const tr = { p: [1, 2, 3], r: [Math.sin(i) * 3, Math.cos(i * 2) * 3, Math.sin(i * 3) * 3], s: [1.3, 0.7, 2.1] };
    const angle = Math.cos(i * 5) * 3, rec = { transform: structuredClone(tr) };
    rotateObject('building', rec, angle);
    const expected = new THREE.Matrix4().makeRotationZ(angle).multiply(new THREE.Matrix4().fromArray(matrixFromTransform(tr)));
    expected.setPosition(...tr.p);
    const actual = matrixFromTransform(rec.transform);
    for (let j = 0; j < 16; j++) assert(Math.abs(actual[j] - expected.elements[j]) < 1e-9);
  }
});
