// Focused HEADLESS test: actual Three render order, insertion-invariant pixels,
// opposite camera sides and live resource replacement. Not order-independent transparency.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const out = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'city-labs-transparency-')); fs.mkdirSync(out, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), plugins: [{ name: 'transparency-fixture-imports', resolveId(id) { if (id === '/__transparency_modules__.js') return '\0city-transparency-modules'; }, load(id) { if (id === '\0city-transparency-modules') return `export * as THREE from 'three';`; } }], server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
try {
  await server.listen(); browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/transparency-qa', (route) => route.fulfill({ contentType: 'text/html', body: '<body style="margin:0"><div id="label" style="position:absolute;top:12px;left:12px;font:14px sans-serif;color:#17202b"></div></body>' }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/transparency-qa`);
  const setup = await page.evaluate(async () => {
    const { THREE } = await import('/__transparency_modules__.js'), { World3D } = await import('/viewer/world3d.js');
    const box = (id, y, material) => ({ id, type: 'block', detail: 'none', transform: { p: [-8, y, 0], r: [0, 0, 0], s: [1, 1, 1] },
      parts: [{ p: [[-3, -0.4], [3, -0.4], [3, 0.4], [-3, 0.4]], z: 0, h: 8, m: material }] });
    const doc = { layers: { defs: { materials: { red: { color: '#e53935', opacity: 0.55, roughness: 1 }, blue: { color: '#286ade', opacity: 0.55, roughness: 1 } },
      furniture: { redPanel: { parts: [{ k: 'box', s: [6, 0.8, 8], m: 'red' }] }, bluePanel: { parts: [{ k: 'box', s: [6, 0.8, 8], m: 'blue' }] } } },
      buildings: { items: [box('redBuilding', 10, 'red'), box('blueBuilding', 14, 'blue')] },
      furniture: { items: [{ id: 'nearRedProp', t: 'redPanel', p: [8, 9, 0] }, { id: 'blueProp', t: 'bluePanel', p: [8, 12, 0] }, { id: 'farRedProp', t: 'redPanel', p: [8, 15, 0] }] } } };
    const world = new World3D(doc, { detail: 'none' }).buildAll(), scene = new THREE.Scene(); scene.background = new THREE.Color('#e8edf3');
    scene.add(world.groups.buildings, world.groups.furniture, new THREE.AmbientLight(0xffffff, 3));
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); renderer.setSize(1000, 640); renderer.setPixelRatio(1);
    document.body.prepend(renderer.domElement);
    const camera = new THREE.OrthographicCamera(-18, 18, 11.52, -11.52, 0.1, 200); camera.up.set(0, 0, 1);
    const state = { THREE, world, doc, renderer, scene, camera, order: [] };
    state.draw = (side) => {
      state.order = [];
      for (const group of [world.groups.blocks, world.groups.furniture]) group.traverse((o) => {
        if (o.isMesh) o.onBeforeRender = () => state.order.push(o.userData.owner(0).id);
      });
      camera.position.set(0, side === 'front' ? -40 : 65, 12); camera.lookAt(0, 12, 4); camera.updateMatrixWorld(true);
      document.querySelector('#label').textContent = `Transparent buildings (left), shared-geometry props (right): ${side}`;
      renderer.render(scene, camera);
      return { order: [...state.order], png: renderer.domElement.toDataURL(), memory: { ...renderer.info.memory } };
    };
    window.transparencyQA = state;
    const props = world.groups.furniture.children;
    return { buildings: world.groups.blocks.children.flatMap((g) => g.children).length, props: props.length,
      allPropsSortable: props.every((o) => !o.isInstancedMesh), redGeometryShared: props[0].geometry === props[1].geometry };
  });
  assert.equal(setup.buildings, 2); assert.equal(setup.props, 3); assert.equal(setup.allPropsSortable, true); assert.equal(setup.redGeometryShared, true);
  const front = await page.evaluate(() => transparencyQA.draw('front'));
  assert.deepEqual(front.order.filter((id) => id.endsWith('Building')), ['blueBuilding', 'redBuilding']);
  assert.deepEqual(front.order.filter((id) => id.endsWith('Prop')), ['farRedProp', 'blueProp', 'nearRedProp']);
  await page.screenshot({ path: `${out}/transparency-front.png` });
  const reversed = await page.evaluate(() => {
    const s = transparencyQA; s.doc.layers.buildings.items.reverse(); s.doc.layers.furniture.items.reverse(); s.world.buildBlocks(); s.world.buildFurniture(); return s.draw('front');
  });
  assert.equal(reversed.png, front.png, 'insertion order cannot change composited pixels');
  const back = await page.evaluate(() => transparencyQA.draw('back'));
  assert.deepEqual(back.order.filter((id) => id.endsWith('Building')), ['redBuilding', 'blueBuilding']);
  assert.deepEqual(back.order.filter((id) => id.endsWith('Prop')), ['nearRedProp', 'blueProp', 'farRedProp']);
  await page.screenshot({ path: `${out}/transparency-back.png` });
  const resources = await page.evaluate(() => {
    const s = transparencyQA, old = new Set(); s.world.groups.furniture.traverse((o) => { if (o.isMesh) { old.add(o.geometry); old.add(o.material); } });
    const counts = new Map(); for (const r of old) r.addEventListener('dispose', () => counts.set(r, (counts.get(r) ?? 0) + 1));
    s.doc.layers.defs.materials.red.opacity = 1; s.world.refreshMaterials(); const opaque = s.draw('front');
    const instanced = s.world.groups.furniture.children.filter((m) => m.isInstancedMesh).length;
    s.doc.layers.defs.materials.red.opacity = 0.55; s.world.refreshMaterials(); const transparent = s.draw('front');
    s.world.dispose(); const released = [...counts.values()]; const after = { ...s.renderer.info.memory }; s.renderer.dispose();
    return { opaque: opaque.memory, transparent: transparent.memory, after, instanced, released, resources: old.size, disposed: counts.size };
  });
  assert.equal(resources.instanced, 1); assert.deepEqual(resources.transparent, front.memory);
  assert.equal(resources.resources, resources.disposed); assert.ok(resources.released.every((n) => n === 1)); assert.equal(resources.after.geometries, 0);
  assert.deepEqual(errors, []);
  fs.writeFileSync(`${out}/transparency-results.json`, JSON.stringify({ setup, frontOrder: front.order, backOrder: back.order, resources, errors }, null, 2));
  console.log(`Headless transparency passed: per-object reverse sort, insertion-invariant pixels, shared geometry and resource replacement. Artifacts: ${out}`);
} finally { await browser?.close(); await server.close(); }
