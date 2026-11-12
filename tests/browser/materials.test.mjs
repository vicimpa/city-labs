// Focused browser checks for the material component, using an isolated document and callbacks.
// Run: node tests/browser/materials.test.mjs [screenshot-directory]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOutputDir, launchBrowser, captureFailure } from '../helpers/browser.mjs';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, root: process.cwd(),
  plugins: [{ name: 'material-test-three', resolveId(id) { if (id === '/__fixtures__/material-three.js') return '\0material-test-three'; }, load(id) { if (id === '\0material-test-three') return "export * from 'three';"; } }],
  server: { host: '127.0.0.1', port: 0, hmr: false } });
const out = createOutputDir('materials');
let browser, page;
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const html = fs.readFileSync('editor/index.html', 'utf8').replace('<script type="module" src="./main.js"></script>', '');
  await page.route('**/editor/', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`http://127.0.0.1:${address.port}/editor/`);
  await page.evaluate(async () => {
    const { setLang, applyDom } = await import('/editor/i18n.js'); setLang('en'); applyDom();
    const { renderMaterialEditor } = await import('/editor/materials.js');
    document.querySelector('#busy').hidden = true;
    document.querySelector('#source').textContent = 'Harbour district.vspb';
    document.querySelector('#save').textContent = 'Saved';
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === 'materials'));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-materials'));
    const doc = { layers: { defs: { materials: { concrete: { color: '#adb6c1', roughness: 0.8 }, bronze: { color: '#ad7542', roughness: 0.3, metalness: 0.9 } }, buildingTypes: { block: { wall: 'windows' }, tower: { wall: 'ribs' } }, facades: { windows: {}, office: { style: 'curtain' }, ribs: { style: 'ribs' } } }, buildings: { items: [{ parts: [{ m: 'concrete' }, { m: 'concrete' }] }] } } };
    const state = { doc, history: [], selection: { kind: 'building' }, assigned: null, textureDisposals: 0 };
    const THREE = await import('/__fixtures__/material-three.js'), disposeTexture = THREE.Texture.prototype.dispose;
    THREE.Texture.prototype.dispose = function () { if (this.isCanvasTexture) state.textureDisposals++; return disposeTexture.call(this); };
    state.cleanup = renderMaterialEditor(document.querySelector('#pane-materials'), {
      getDoc: () => doc, getSelection: () => state.selection,
      setDef(group, id, value) { state.history.push(structuredClone(doc)); if (value === null) delete doc.layers.defs[group][id]; else doc.layers.defs[group][id] = structuredClone(value); state.cleanup?.refresh(); },
      assign(id) { state.history.push(structuredClone(doc)); state.assigned = id; if (state.selection.kind === 'furniture') state.selection.rec.material = id; else doc.layers.buildings.items[0].parts.forEach((p) => { p.m = id; }); },
    });
    window.materialTest = state;
  });
  await page.getByRole('button', { name: '+ Create', exact: true }).click();
  assert.equal(await page.evaluate(() => materialTest.doc.layers.defs.materials.material.roughness), 0.7);
  const roughness = page.locator('[data-material-field="roughness"]');
  await roughness.fill('0.35');
  assert.equal(await page.evaluate(() => materialTest.doc.layers.defs.materials.material.roughness), 0.7, 'preview input does not mutate document');
  await roughness.press('Tab');
  assert.equal(await page.evaluate(() => materialTest.doc.layers.defs.materials.material.roughness), 0.35);
  assert.equal(await page.evaluate(() => materialTest.history.length), 2, 'one commit for the numeric edit');
  await roughness.fill('4'); await roughness.press('Tab');
  assert.equal(await page.evaluate(() => materialTest.history.length), 2, 'out-of-range input cannot mutate document');
  await page.evaluate(() => materialTest.cleanup.refresh());
  await page.getByRole('button', { name: 'Assign to selection', exact: true }).click();
  assert.equal(await page.evaluate(() => materialTest.assigned), 'material');
  assert.equal(await page.getByRole('button', { name: 'Delete material', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  assert.equal(await page.evaluate(() => materialTest.doc.layers.defs.materials.material_copy.roughness), 0.35);
  await roughness.fill('0.6'); await roughness.press('Tab');
  assert.equal(await page.evaluate(() => materialTest.doc.layers.defs.materials.material.roughness), 0.35, 'duplicate is independent');
  await page.getByRole('button', { name: 'Delete material', exact: true }).click();
  assert.equal(await page.evaluate(() => Object.hasOwn(materialTest.doc.layers.defs.materials, 'material_copy')), false);
  await page.evaluate(() => { const previous = materialTest.history.pop(); materialTest.doc.layers = previous.layers; materialTest.cleanup.refresh(); });
  assert.equal(await page.evaluate(() => materialTest.doc.layers.defs.materials.material_copy.roughness), 0.6, 'external undo refreshes component');
  await page.getByRole('button', { name: 'material_copy', exact: true }).click();
  await page.getByRole('button', { name: 'Cube', exact: true }).click();
  const plainPreview = await page.locator('.material-preview-viewport').screenshot();
  await page.locator('[data-material-field="facade"]').selectOption('windows');
  assert.equal(await page.evaluate(() => materialTest.doc.layers.defs.materials.material_copy.facade), 'windows');
  assert.equal(await page.getByRole('button', { name: 'Cube', exact: true }).evaluate((el) => el.classList.contains('on')), true, 'preview shape survives edit refresh');
  assert.notDeepEqual(await page.locator('.material-preview-viewport').screenshot(), plainPreview, 'facade changes visible preview pixels');
  const disposals = () => page.evaluate(() => materialTest.textureDisposals);
  const beforeTextureRefresh = await disposals();
  await page.evaluate(() => materialTest.cleanup.refresh());
  await roughness.fill('0.65'); await roughness.press('Tab');
  assert.equal(await disposals(), beforeTextureRefresh, 'refresh and scalar edits retain facade textures');
  await page.evaluate(() => { materialTest.selection.rec = { type: 'block' }; });
  await page.locator('[data-material-field="facade"]').selectOption('wall');
  assert.equal(await disposals(), beforeTextureRefresh, 'wall alias resolves the selected building facade without replacing identical textures');
  await page.evaluate(() => { materialTest.selection.rec = { type: 'tower' }; materialTest.cleanup.refresh(); });
  assert.equal(await disposals(), beforeTextureRefresh + 3, 'changed building facade disposes prior private color/emission/relief maps');
  await page.evaluate(() => { materialTest.selection = null; materialTest.cleanup.refresh(); });
  assert.equal(await disposals(), beforeTextureRefresh + 5, 'wall without selection falls back to office and disposes ribs maps');
  await page.locator('[data-material-field="facade"]').selectOption('');
  assert.equal(await disposals(), beforeTextureRefresh + 8, 'disabling facade disposes all its private textures');
  await page.locator('[data-material-field="facade"]').selectOption('windows');
  const canvas = await page.locator('.material-preview canvas').elementHandle();
  await page.evaluate(() => materialTest.cleanup.refresh());
  assert.equal(await canvas.evaluate((node) => node.isConnected), true, 'refresh retains the preview renderer');
  for (const width of [1440, 960]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('#pane-materials').evaluate((el) => { el.scrollTop = 0; });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await page.locator('#side').boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width, 'sidebar fits viewport');
    assert.equal(await page.locator('#pane-materials').evaluate((el) => el.scrollWidth <= el.clientWidth), true, 'material panel has no horizontal overflow');
    await page.screenshot({ path: path.join(out, `city-labs-materials-${width}.png`) });
  }
  const focusedField = () => page.evaluate(() => document.activeElement?.dataset.materialField);
  await roughness.fill('0.37'); await roughness.press('Tab');
  assert.equal(await page.evaluate(() => materialTest.doc.layers.defs.materials.material_copy.roughness), 0.37);
  assert.equal(await focusedField(), 'metalness', 'Tab commits roughness and advances to metalness despite synchronous external refresh');
  await page.locator('[data-material-field="metalness"]').fill('0.2'); await page.keyboard.press('Shift+Tab');
  assert.equal(await focusedField(), 'roughness', 'Shift+Tab commits metalness and returns to roughness');
  await roughness.fill('0.38'); await page.locator('[data-material-field="opacity"]').click();
  assert.equal(await focusedField(), 'opacity', 'scalar commit does not steal focus from the clicked field');
  await page.evaluate(() => {
    const rec = { t: 'bench', p: [0, 0, 0], h: 0 };
    materialTest.doc.layers.furniture = { items: [rec] };
    materialTest.selection = { kind: 'furniture', rec }; materialTest.cleanup.refresh();
  });
  assert.equal(await page.getByRole('button', { name: 'Assign to selection', exact: true }).isEnabled(), true, 'furniture selection enables assignment');
  await page.getByRole('button', { name: 'Assign to selection', exact: true }).click();
  assert.equal(await page.evaluate(() => materialTest.doc.layers.furniture.items[0].material), 'material_copy', 'furniture assignment uses the context callback');
  assert.equal(await page.getByRole('button', { name: 'Delete material', exact: true }).isDisabled(), true, 'furniture material dependency blocks deletion');
  assert.match(await page.locator('.material-scope').textContent(), /1 material slots/, 'usage counts the furniture override');
  await page.evaluate(async () => { const { setLang, applyDom } = await import('/editor/i18n.js'); setLang('ru'); applyDom(); materialTest.cleanup.refresh(); });
  assert.equal(await page.getByRole('button', { name: 'Дублировать', exact: true }).count(), 1);
  const beforeCleanup = await disposals();
  await page.evaluate(() => materialTest.cleanup());
  assert.equal(await disposals(), beforeCleanup + 3, 'cleanup disposes remaining private facade maps');
  assert.equal(await page.locator('.material-preview canvas').count(), 0);
  assert.deepEqual(errors, []);
  console.log('OK material CRUD, preview/commit, validation, building/furniture assignment and dependency guard, undo, facade pixels/selection/default, texture reuse/disposal, shape persistence, RU/EN, 1440/960 and cleanup');
} catch (error) { await captureFailure(page, out, error); throw error; } finally {
  await browser?.close(); await server.close();
}
