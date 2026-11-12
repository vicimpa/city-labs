// Isolated, headless Chromium; no editor UI, native app, existing tab, or source-file writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
const out = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'city-export-'));
fs.mkdirSync(out, { recursive: true });
const source = 'city/data/vespera.vspb';
const digest = () => createHash('sha256').update(fs.readFileSync(source)).digest('hex');
const before = digest(), errors = [], materialWarnings = [];
const server = await createServer({ configFile: false, root: process.cwd(), plugins: [{ name: 'export-fixture-imports', resolveId(id) { if (id === '/__export_modules__.js') return '\0city-export-modules'; }, load(id) { if (id === '\0city-export-modules') return `import * as THREE from 'three'; import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'; import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'; export { THREE, GLTFLoader, GLTFExporter };`; } }], server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const context = await browser.newContext({ viewport: { width: 800, height: 600 }, storageState: { cookies: [], origins: [] } });
  await context.route('**/__export_fixture__', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  const page = await context.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (message) => { if (/GLTFExporter: Use MeshStandardMaterial or MeshBasicMaterial/.test(message.text())) materialWarnings.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__export_fixture__`);
  const result = await page.evaluate(async () => {
    const { THREE, GLTFLoader, GLTFExporter } = await import('/__export_modules__.js');
    const { exportGlb, exportPng, exportJson } = await import('/editor/export.js');
    const { emptyWorld } = await import('/format/world.js');
    const { localToWorld } = await import('/format/transforms.js');
    const { World3D } = await import('/viewer/world3d.js');
    const { KINDS } = await import('/editor/kinds.js');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const equal = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), `${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    const near = (a, b, message) => check(Math.abs(a - b) < 5e-4, `${message}: ${a} != ${b}`);
    const yUp = ([x, y, z = 0]) => [x, z, -y];
    const doc = emptyWorld({ size: 128, res: 8, ground: 10 });
    const courtyard = { type: 'courtyard', zone: 'midtown', transform: { p: [25, 15, 10], r: [0.15, -0.2, 0.5], s: [1.2, 0.8, 1.5] },
      parts: [{ p: [[-10, -10], [10, -10], [10, 10], [-10, 10]], holes: [[[-4, -4], [-4, 4], [4, 4], [4, -4]]], z: 0, h: 18, m: 'brick', roofMaterial: 'roof_grey' }] };
    doc.layers.buildings.items = [courtyard, { type: 'block', transform: { p: [-25, 15, 10], r: [0, 0, 0], s: [1, 1, 1] }, parts: [{ p: [[-7, -7], [7, -7], [7, 7], [-7, 7]], z: 0, h: 16, m: 'brick', roofMaterial: 'roof_grey' }] }];
    doc.layers.furniture.items = [{ t: 'lamp', p: [0, -15, 10], h: 0.4, scale: [2, 0.8, 1.2] }, { t: 'lamp', p: [15, -15, 10], h: -0.4 }];
    doc.layers.buildings.trees = [[-35, -20, 10], [45, -30, 10]];
    const pts = Array.from({ length: 21 }, (_, i) => [-50 + i * 5, -40, 10 + i / 10]);
    doc.layers.roads.nodes = [{ id: 7, p: [...pts[0]] }, { id: 9, p: [...pts.at(-1)] }];
    doc.layers.roads.edges = [{ id: 42, name: 'Export Road', cls: 'street', n: [7, 9], pts, trim: [0, 0], elev: pts.map(() => 0), tunnel: pts.map(() => 0) }];
    const world = new World3D(doc, { tileSize: Infinity }).buildAll();
    const swatch = document.createElement('canvas'); swatch.width = swatch.height = 2; const paint = swatch.getContext('2d'); paint.fillStyle = '#aabbcc'; paint.fillRect(0, 0, 2, 2);
    const legacyTexture = new THREE.CanvasTexture(swatch), legacyMaterial = new THREE.MeshPhongMaterial({ name: 'Legacy Phong', color: '#4488cc', map: legacyTexture, shininess: 78, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
    const legacyMesh = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), legacyMaterial); legacyMesh.position.set(50, 35, 12); legacyMesh.userData = { kind: 'building', owner: () => doc.layers.buildings.items[1] }; world.groups.blocks.add(legacyMesh);
    const renderer = new THREE.WebGLRenderer({ antialias: false }); renderer.setSize(800, 600); document.body.append(renderer.domElement);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.1, 20000); camera.up.set(0, 0, 1); camera.position.set(180, -220, 200); camera.lookAt(0, 0, 15); camera.updateMatrixWorld();
    scene.add(new THREE.AmbientLight(0xffffff, 2)); scene.add(world.groups.terrain, world.groups.roads, world.groups.furniture, world.groups.buildings);
    const far = camera.clone(); far.position.set(9000, 9000, 9000); far.updateMatrixWorld(); world.update(far);
    let hiddenDetail = 0; world.groups.blocks.traverse((o) => { if (o.userData.detail && !o.visible) hiddenDetail++; }); check(hiddenDetail > 0, 'fixture has actual LOD-hidden detail');
    renderer.render(scene, camera);
    const memoryBefore = { ...renderer.info.memory }, live = new Set(), objectState = [];
    scene.traverse((o) => {
      objectState.push([o, o.visible, o.userData, o.userData.owner]);
      if (o.geometry) live.add(o.geometry);
      for (const m of o.material ? Array.isArray(o.material) ? o.material : [o.material] : []) { live.add(m); for (const value of Object.values(m)) if (value?.isTexture) live.add(value); }
    }); live.add(world.terrainGeo);
    let disposedLive = 0; for (const resource of live) resource.addEventListener('dispose', () => disposedLive++);
    const geometryDispose = THREE.BufferGeometry.prototype.dispose, materialDispose = THREE.Material.prototype.dispose;
    const temporaryDisposed = { geometries: 0, materials: 0 };
    THREE.BufferGeometry.prototype.dispose = function () { if (!live.has(this)) temporaryDisposed.geometries++; return geometryDispose.call(this); };
    THREE.Material.prototype.dispose = function () { if (!live.has(this)) temporaryDisposed.materials++; return materialDispose.call(this); };
    const rawJSON = (bytes) => {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); check(dv.getUint32(0, true) === 0x46546c67 && dv.getUint32(4, true) === 2, 'binary glTF 2 header'); equal(dv.getUint32(8, true), bytes.length, 'GLB length');
      check(dv.getUint32(16, true) === 0x4e4f534a, 'first GLB chunk is JSON');
      return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + dv.getUint32(12, true))));
    };
    const asDataURL = (bytes, type) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(new Blob([bytes], { type })); });
    try {
      const bytes = await exportGlb(world, { terrainStep: 6 }), json = rawJSON(bytes), game = json.scenes[json.scene].extras.cityLabs;
      equal(game.format, 'city-labs-game', 'metadata format'); equal(game.version, 1, 'metadata schema version'); equal(game.documentVersion, doc.meta.documentVersion, 'document version'); equal(game.units, 'metres', 'metres'); equal(game.upAxis, 'Y', 'Y up');
      const ids = new Set(game.entities.map((e) => e.id)); equal(ids.size, game.entities.length, 'entity IDs unique');
      for (const kind of ['building', 'furniture', 'tree']) equal(game.entities.filter((e) => e.kind === kind).length, 2, `${kind} entity index`);
      const graph = game.roadGraph; equal(graph.classes.street.lanes, doc.layers.roads.classes.street.lanes, 'lane parameters'); equal(graph.classes.street.lane_w, doc.layers.roads.classes.street.lane_w, 'lane widths');
      equal(graph.nodes[0].position, [-50, 10, 40], 'graph Y-up position'); equal(graph.edges[0].axis[20], [50, 12, 40], 'axis Y-up'); equal(graph.edges[0].nodes, graph.nodes.map((n) => n.entityId), 'graph connectivity');
      equal(graph.edges[0].controlPoints, graph.edges[0].controlIndices.map((i) => graph.edges[0].axis[i]), 'controls refer to axis points');
      const pbr = json.materials.find((material) => material.name === 'Legacy Phong');
      near(pbr.pbrMetallicRoughness.roughnessFactor, Math.sqrt(2 / 80), 'legacy shininess converted to roughness'); equal(pbr.pbrMetallicRoughness.metallicFactor, 0, 'legacy dielectric metalness');
      near(pbr.pbrMetallicRoughness.baseColorFactor[3], 0.7, 'legacy opacity retained'); check(pbr.pbrMetallicRoughness.baseColorTexture, 'legacy diffuse map retained'); equal(pbr.alphaMode, 'BLEND', 'legacy transparency retained'); equal(pbr.doubleSided, true, 'legacy material side retained');
      check(json.extensionsUsed.includes('EXT_mesh_gpu_instancing'), 'GPU instancing extension retained');
      let detailed = 0, merged = 0, instanced = 0, roadOwners = 0;
      for (const node of json.nodes) {
        const extra = node.extras?.cityLabs; if (!extra) continue;
        if (extra.detail) detailed++;
        const ownership = extra.ownership; if (!ownership) continue;
        const mesh = json.meshes[node.mesh];
        let count = 0;
        if (ownership.domain === 'instances') { count = json.accessors[node.extensions.EXT_mesh_gpu_instancing.attributes.TRANSLATION].count; instanced++; }
        else if (ownership.domain === 'triangles') count = mesh.primitives.reduce((n, p) => n + (p.indices !== undefined ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count) / 3, 0);
        else continue;
        let end = 0; for (const range of ownership.ranges) { equal(range.start, end, 'ownership contiguous'); check(range.count > 0, 'positive ownership range'); if (range.entityId !== null) check(ids.has(range.entityId), 'ownership references index'); end += range.count; }
        equal(end, count, 'ownership covers mesh/instances');
        if (extra.kind === 'building' && new Set(ownership.ranges.map((r) => r.entityId)).size === 2) merged++;
        if (extra.kind === 'road') { check(ownership.ranges.every((r) => r.entityId?.startsWith('edge:') || r.entityId?.startsWith('node:')), 'road faces identify graph entities'); roadOwners++; }
      }
      check(detailed >= hiddenDetail, 'hidden architectural detail included in GLB'); check(merged > 0, 'merged building mesh references both records'); check(instanced >= 3, 'prop and tree instance ownership'); check(roadOwners > 0, 'road ownership exported');
      const loaded = await new GLTFLoader().parseAsync(bytes.buffer, ''); loaded.scene.updateMatrixWorld(true);
      loaded.scene.traverse((object) => {
        if (!object.isInstancedMesh || object.userData.cityLabs?.kind !== 'furniture') return;
        const ranges = object.userData.cityLabs.ownership.ranges;
        for (let i = 0; i < object.count; i++) {
          const id = ranges.find((range) => i >= range.start && i < range.start + range.count).entityId;
          const entity = game.entities.find((entry) => entry.id === id), expected = yUp(doc.layers.furniture.items[entity.index].p);
          const matrix = new THREE.Matrix4(); object.getMatrixAt(i, matrix); const position = new THREE.Vector3().setFromMatrixPosition(matrix).applyMatrix4(object.matrixWorld);
          position.toArray().forEach((value, axis) => near(value, expected[axis], 'instance ownership identifies physical prop position'));
        }
      });
      check(!JSON.stringify(json).includes('"parts"'), 'full authoring building records are not duplicated into GLB extras');
      const terrain = loaded.scene.getObjectByName('terrain'), terrainBox = new THREE.Box3().setFromObject(terrain);
      near(terrainBox.min.x, -64, 'terrain west border'); near(terrainBox.max.x, 64, 'terrain east border'); near(terrainBox.min.z, -64, 'terrain north border'); near(terrainBox.max.z, 64, 'terrain south border'); near(terrainBox.min.y, 10, 'terrain height is Y');
      equal(terrain.geometry.index.count, 54, 'non-divisible coarse grid retains all border cells');
      const expectedRoot = new THREE.Group(); expectedRoot.rotation.x = -Math.PI / 2; expectedRoot.add(world.groups.blocks.clone(true)); expectedRoot.updateMatrixWorld(true);
      const expectedBox = new THREE.Box3().setFromObject(expectedRoot), actualBox = new THREE.Box3().setFromObject(loaded.scene.getObjectByName('blocks'));
      for (const side of ['min', 'max']) for (const axis of ['x', 'y', 'z']) near(actualBox[side][axis], expectedBox[side][axis], `transformed building physical bounds ${side}.${axis}`);
      const ownedBy = (hit, id) => hit.object.userData.cityLabs?.ownership?.ranges.some((r) => hit.faceIndex >= r.start && hit.faceIndex < r.start + r.count && r.entityId === id);
      const rayThrough = (x, y) => {
        const a = yUp(localToWorld(courtyard, [x, y, 118])), b = yUp(localToWorld(courtyard, [x, y, 18]));
        return new THREE.Raycaster(new THREE.Vector3(...a), new THREE.Vector3(...b).sub(new THREE.Vector3(...a)).normalize()).intersectObject(loaded.scene, true).filter((h) => ownedBy(h, 'building:0'));
      };
      equal(rayThrough(0, 0).length, 0, 'courtyard hole survives GLB tessellation'); check(rayThrough(8, 0).length > 0, 'solid transformed courtyard roof is hittable');
      const second = rawJSON(await exportGlb(world, { terrainStep: 6 })); equal(second.scenes[second.scene].extras.cityLabs.entities, game.entities, 'per-export IDs stable for identical snapshot');
      const noMetadata = rawJSON(await exportGlb(world, { terrainStep: 0, metadata: false })); check(noMetadata.scenes.every((s) => !s.extras?.cityLabs) && noMetadata.nodes.every((n) => !n.extras?.cityLabs), 'metadata opt-out');
      const exportOnlyRoad = rawJSON(await exportGlb(world, { terrainStep: 0, buildings: false, furniture: false, trees: false })); check(exportOnlyRoad.scenes[0].extras.cityLabs.entities.every((e) => ['edge', 'node'].includes(e.kind)), 'export options limit the entity index');
      const previousCounts = { ...temporaryDisposed }, parse = GLTFExporter.prototype.parseAsync;
      try { GLTFExporter.prototype.parseAsync = async () => { throw new Error('injected export failure'); }; let rejected = false; try { await exportGlb(world); } catch (e) { rejected = e.message === 'injected export failure'; } check(rejected, 'export errors propagate'); }
      finally { GLTFExporter.prototype.parseAsync = parse; }
      equal(temporaryDisposed.geometries, previousCounts.geometries + 1, 'temporary terrain geometry disposed after failure'); check(temporaryDisposed.materials > previousCounts.materials + 1, 'temporary terrain and converted materials disposed after failure');
      equal(disposedLive, 0, 'cached live resources never disposed'); equal(legacyMaterial.shininess, 78, 'source Phong shine unchanged'); check(legacyMaterial.map === legacyTexture, 'source texture reference unchanged');
      for (const [o, visible, data, owner] of objectState) { equal(o.visible, visible, 'source visibility retained'); check(o.userData === data && o.userData.owner === owner, 'source owner functions unchanged'); }
      renderer.render(scene, camera); check(renderer.info.render.calls > 0 && renderer.info.render.triangles > 0, 'live renderer still draws after exports'); equal(renderer.info.memory, memoryBefore, 'GPU resources unchanged after repeated exports');
      const jsonBytes = exportJson(doc), roundtrip = JSON.parse(new TextDecoder().decode(jsonBytes)); equal(roundtrip.layers.buildings.items[0].transform, courtyard.transform, 'JSON transform retained'); check(Array.isArray(roundtrip.layers.terrain.h), 'JSON typed heightfields become arrays');
      const png = await exportPng(doc, world.H, KINDS, 128), image = await createImageBitmap(new Blob([png], { type: 'image/png' })); equal(image.width, 128, 'PNG width'); equal(image.height, 128, 'PNG height'); image.close();
      return { glb: (await asDataURL(bytes, 'model/gltf-binary')).split(',')[1], png: (await asDataURL(png, 'image/png')).split(',')[1], summary: { bytes: bytes.length, entities: game.entities.length, nodes: json.nodes.length, meshDefinitions: json.meshes.length, mergedOwnedMeshes: merged, instanceMeshes: instanced, roadMeshes: roadOwners, hiddenDetailExported: detailed, temporaryDisposed, gpuMemory: memoryBefore, liveResourcesDisposed: disposedLive, flags: ['Y-up metres', 'graph + lanes', 'stable ownership ranges', 'courtyard holes', 'terrain borders', 'metadata opt-out', 'failure cleanup', 'live render', 'PNG/JSON'] } };
    } finally {
      THREE.BufferGeometry.prototype.dispose = geometryDispose; THREE.Material.prototype.dispose = materialDispose;
      world.dispose(); renderer.dispose();
    }
  });
  assert.deepEqual(errors, [], 'no browser page errors');
  assert.deepEqual(materialWarnings, [], 'all legacy export materials converted without exporter warnings');
  fs.writeFileSync(path.join(out, 'city-export.glb'), Buffer.from(result.glb, 'base64'));
  fs.writeFileSync(path.join(out, 'city-map.png'), Buffer.from(result.png, 'base64'));
  fs.writeFileSync(path.join(out, 'export-results.json'), JSON.stringify(result.summary, null, 2));
  console.log('OK headless GLB/PNG/JSON export:', JSON.stringify(result.summary)); console.log('Artifacts:', out);
} finally { await browser?.close(); await server.close(); assert.equal(digest(), before, 'source city never modified'); }
