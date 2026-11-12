// End-to-end city authoring in a disposable headless browser. No native host,
// project-write middleware, user browser profile or source-city mutation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { decodeWorld } from '../../format/world.js';

const output = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'city-labs-workflow-'));
fs.mkdirSync(output, { recursive: true });
const source = 'city/data/vespera.vspb', digest = () => createHash('sha256').update(fs.readFileSync(source)).digest('hex'), sourceBefore = digest();
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
try {
  await server.listen(); browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', acceptDownloads: true, storageState: { cookies: [], origins: [] } });
  const errors = [], writes = [], dialogs = [];
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).pathname === '/__vspb/ping') return route.fulfill({ contentType: 'application/json', body: '{"vspb":false}' });
    if (!['GET', 'HEAD'].includes(route.request().method())) { writes.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', async (d) => { dialogs.push({ type: d.type(), message: d.message() }); if (d.type() === 'confirm') await d.accept(); else await d.dismiss(); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/editor/`);
  const ready = () => page.waitForFunction(() => window.editor?.doc && document.querySelector('#busy').hidden);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await ready();
  assert.deepEqual(await page.evaluate(() => [!!window.vspbHost, editor.doc.layers.buildings.items.length, editor.doc.layers.roads.edges.length, editor.hist.done.length]), [false, 0, 0, 0], 'refuse to edit a nonempty/native session');
  await page.locator('#lang').selectOption('en');
  await page.locator('#filemenu').click(); await page.locator('#new').click();
  await page.locator('#dialog-preset').selectOption('0.5x0.5');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click(); await ready();
  await page.waitForFunction(() => (editor.doc.layers.terrain.nx - 1) * editor.doc.layers.terrain.res === 500);
  assert.equal(await page.evaluate(() => (editor.doc.layers.terrain.nx - 1) * editor.doc.layers.terrain.res), 500);
  await page.evaluate(() => editor.setView(0, -420, 360, 0, 0, 10)); await frames();

  const mapClick = async (x, y, z = 10) => {
    const p = await page.evaluate(([x, y, z]) => editor.toScreen(x, y, z), [x, y, z]);
    assert(p && p[0] > 220 && p[0] < 1040 && p[1] > 115 && p[1] < 950, `unobstructed test point ${x},${y}: ${p}`);
    await page.mouse.click(...p); await frames();
  };
  const drawRoad = async (points, elevation = 0) => {
    await page.locator('[data-tool="road"]').click();
    const offset = page.getByLabel('Height offset, m'); await offset.fill(String(elevation)); await offset.press('Tab');
    for (const p of points) await mapClick(...p);
    await page.locator('#draw-actions').getByRole('button', { name: 'Finish ↵', exact: true }).click(); await frames();
  };
  await drawRoad([[-145, -15], [145, -15]]);
  assert.equal(await page.evaluate(() => editor.doc.layers.roads.edges.length), 1);
  await drawRoad([[-30, -15], [-30, 120]]);
  assert.equal(await page.evaluate(() => editor.doc.layers.roads.edges.length), 3, 'joining a road splits it into a T junction');
  await drawRoad([[-120, 60], [120, 60]], 12);
  assert(await page.evaluate(() => editor.doc.layers.roads.edges.at(-1).elev.some(Boolean)), 'height offset creates a bridge');
  assert.equal(await page.evaluate(() => editor.hist.done.length), 3, 'each complete road is one undo command');

  // Keep the form mounted while tabbing between coordinates. Every callback
  // must read the current vector/curve, rather than the value at form creation.
  await page.locator('[data-tool="select"]').click();
  await page.evaluate(() => editor.select('edge', 0)); await frames();
  const roadBefore = await page.evaluate(() => structuredClone(editor.doc.layers.roads.edges[0].pts));
  await page.mouse.click(...await page.evaluate(() => editor.handles()[0])); await frames();
  for (const [axis, value] of [['X', roadBefore[0][0] - 2], ['Y', roadBefore[0][1] - 4], ['Z', roadBefore[0][2] + 1]]) {
    const field = page.getByLabel(`Point #0 ${axis}`, { exact: true }); await field.fill(String(value)); await field.press('Tab');
  }
  const changedEnd = [roadBefore[0][0] - 2, roadBefore[0][1] - 4, roadBefore[0][2] + 1];
  assert.deepEqual(await page.evaluate(() => editor.doc.layers.roads.edges[0].pts[0]), changedEnd, 'point XYZ edits retain preceding coordinates');
  assert.deepEqual(await page.evaluate(() => { const R = editor.doc.layers.roads; return R.nodes.find((n) => n.id === R.edges[0].n[0]).p; }), changedEnd, 'linked graph node follows typed point');
  for (let i = 0; i < 3; i++) await page.locator('#undo').click();
  assert.deepEqual(await page.evaluate(() => editor.doc.layers.roads.edges[0].pts), roadBefore);
  await page.evaluate(() => { const R = editor.doc.layers.roads; editor.select('node', R.nodes.findIndex((n) => n.id === R.edges[0].n[0])); });
  const nodeP = page.locator('#pane-props label[title="p"]').locator('..');
  await nodeP.locator('input[title="x"]').fill(String(roadBefore[0][0] + 3)); await nodeP.locator('input[title="x"]').press('Tab');
  await nodeP.locator('input[title="y"]').fill(String(roadBefore[0][1] + 4)); await nodeP.locator('input[title="y"]').press('Tab');
  assert.deepEqual(await page.evaluate(() => editor.sel.rec.p), [roadBefore[0][0] + 3, roadBefore[0][1] + 4, roadBefore[0][2]], 'generic vector edits retain preceding coordinate');
  for (let i = 0; i < 2; i++) await page.locator('#undo').click();

  await page.evaluate(() => editor.select('edge', 0)); await frames();
  const controlsBefore = await page.evaluate(() => editor.handles().length);
  const middle = roadBefore[roadBefore.length >> 1], bend = await page.evaluate((p) => editor.toScreen(p[0], p[1] - 30, p[2]), middle);
  await page.mouse.move(...await page.evaluate((p) => editor.toScreen(...p), middle));
  await page.keyboard.down('Alt'); await page.mouse.down(); await page.keyboard.up('Alt');
  await page.mouse.move(...bend, { steps: 8 }); await frames(); await page.mouse.up(); await frames();
  assert.equal(await page.evaluate(() => editor.handles().length), controlsBefore + 1, 'Alt drag inserts a curve control');
  await page.mouse.move(...await page.evaluate(() => editor.handles()[1])); await frames();
  await page.keyboard.down('Alt'); await page.mouse.click(...await page.evaluate(() => editor.handles()[1])); await page.keyboard.up('Alt'); await frames();
  assert.equal(await page.evaluate(() => editor.handles().length), controlsBefore, 'Alt click removes an interior curve control');
  await page.locator('#undo').click(); await page.locator('#undo').click();
  assert.deepEqual(await page.evaluate(() => editor.doc.layers.roads.edges[0].pts), roadBefore, 'curve edits undo exactly');
  await page.getByRole('button', { name: 'Split at point / midpoint', exact: true }).click();
  assert.equal(await page.evaluate(() => editor.doc.layers.roads.edges.length), 5, 'split adds an edge and selects the new junction');
  assert.equal(await page.evaluate(() => editor.sel.kind), 'node');
  await page.locator('#undo').click();
  assert.equal(await page.evaluate(() => editor.hist.done.length), 3, 'road edit regressions restore the original three commands');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('#undo').click();
  assert.equal(await page.evaluate(() => editor.sel?.kind), 'edge', 'undo road deletion restores road selection');
  assert.equal(await page.evaluate(() => editor.doc.layers.roads.edges.length), 4);

  await page.locator('[data-tool="building"]').click();
  for (const p of [[35, -115], [75, -115], [75, -75], [35, -75]]) await mapClick(...p);
  await page.locator('#draw-actions').getByRole('button', { name: 'Finish ↵', exact: true }).click(); await frames();
  assert.equal(await page.evaluate(() => editor.doc.layers.buildings.items.length), 1);
  const parts = await page.evaluate(() => JSON.stringify(editor.doc.layers.buildings.items[0].parts));

  await page.locator('[data-tab="materials"]').click();
  await page.getByLabel('New material name').fill('harbour_brick');
  await page.getByRole('button', { name: '+ Create', exact: true }).click();
  await page.locator('[data-material-field="roughness"]').fill('0.55'); await page.locator('[data-material-field="roughness"]').press('Tab');
  await page.locator('[data-material-field="facade"]').selectOption('brick');
  await page.getByRole('button', { name: 'Assign to selection', exact: true }).click();
  assert.equal(await page.evaluate(() => editor.doc.layers.buildings.items[0].parts[0].m), 'harbour_brick');
  assert(await page.getByRole('button', { name: 'Delete material', exact: true }).isDisabled());
  await page.locator('[data-tab="props"]').click();
  await page.getByLabel('Position, m X', { exact: true }).fill('65'); await page.getByLabel('Position, m X', { exact: true }).press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Position, m Y', 'Tab after committing X advances to Y');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Position, m X', 'Shift+Tab preserves reverse navigation');
  await page.getByLabel('Rotation, ° Z', { exact: true }).fill('35'); await page.getByLabel('Rotation, ° Z', { exact: true }).press('Tab');
  await page.getByLabel('Scale Z', { exact: true }).fill('1.4'); await page.getByLabel('Scale Z', { exact: true }).press('Tab');
  const local = await page.evaluate(() => editor.doc.layers.buildings.items[0]);
  assert.equal(local.transform.p[0], 65); assert(Math.abs(local.transform.r[2] - 35 * Math.PI / 180) < 1e-9); assert.equal(local.transform.s[2], 1.4);
  const geometryOnly = (s) => JSON.parse(s).map(({ m, roofMaterial, trimMaterial, ...p }) => p);
  assert.deepEqual(geometryOnly(JSON.stringify(local.parts)), geometryOnly(parts), 'transforms preserve local outlines and heights');
  await page.locator('#undo').click(); assert.equal(await page.evaluate(() => editor.doc.layers.buildings.items[0].transform.s[2]), 1);
  await page.locator('#redo').click(); assert.equal(await page.evaluate(() => editor.doc.layers.buildings.items[0].transform.s[2]), 1.4);
  await page.getByText('Part materials 1', { exact: true }).click(); await page.getByLabel('Roof 1', { exact: true }).selectOption('roof_white');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  assert.equal(await page.evaluate(() => editor.doc.layers.buildings.items.length), 0);
  await page.locator('#undo').click();
  assert.equal(await page.evaluate(() => editor.sel?.rec === editor.doc.layers.buildings.items[0]), true, 'undo deletion restores object selection');
  await page.locator('#redo').click();
  assert.equal(await page.evaluate(() => editor.sel), null, 'redo deletion clears a removed selection');
  await page.locator('#undo').click();
  assert.equal(await page.evaluate(() => editor.sel?.kind), 'building');
  await page.evaluate(async () => {
    const result = await editor.call('run_script', { code: "world.remove('building', world.get('building', 0));" });
    if (result.isError) throw new Error(result.content[0].text);
  });
  assert.equal(await page.evaluate(() => editor.sel), null);
  await page.locator('#undo').click();
  assert.equal(await page.evaluate(() => editor.sel?.rec === editor.doc.layers.buildings.items[0]), true, 'undo agent batch restores its prior selection');

  await page.locator('[data-tool="furniture"]').click(); await mapClick(-70, -90);
  const propIndex = await page.evaluate(() => editor.doc.layers.furniture.items.indexOf(editor.sel.rec));
  await page.locator('[data-tab="materials"]').click();
  await page.getByRole('button', { name: 'harbour_brick', exact: false }).click();
  await page.getByRole('button', { name: 'Assign to selection', exact: true }).click();
  assert.equal(await page.evaluate((i) => editor.doc.layers.furniture.items[i].material, propIndex), 'harbour_brick');

  await page.evaluate(async () => {
    const r = await editor.call('update', { kind: 'building', index: 0, set: { gameplay: { district: 'harbour', collision: 'static' } } });
    if (r.isError) throw new Error(r.content[0].text);
    await editor.saveNow();
  });
  const expected = await page.evaluate(() => ({ building: structuredClone(editor.doc.layers.buildings.items[0]), roads: editor.doc.layers.roads.edges.length, props: editor.doc.layers.furniture.items.length }));
  await page.reload(); await ready();
  assert.deepEqual(await page.evaluate(() => ({ building: structuredClone(editor.doc.layers.buildings.items[0]), roads: editor.doc.layers.roads.edges.length, props: editor.doc.layers.furniture.items.length })), expected, 'IndexedDB reopen restores the authored city');
  await page.evaluate(() => editor.setView(0, -420, 360, 0, 0, 10)); await frames();
  const downloadPromise = page.waitForEvent('download'); await page.locator('#quicksave').click();
  const download = await downloadPromise, worldFile = path.join(output, 'workflow.vspb'); await download.saveAs(worldFile);
  const saved = await decodeWorld(fs.readFileSync(worldFile)); assert.equal(saved.version.major, 2); assert.equal(saved.layers.buildings.items[0].gameplay.collision, 'static');
  await page.locator('#file').setInputFiles(worldFile); await ready();
  assert.equal(await page.evaluate(() => editor.doc.layers.buildings.items[0].parts[0].roofMaterial), 'roof_white');

  const glbPromise = page.waitForEvent('download'); await page.locator('#filemenu').click(); await page.locator('#export').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click();
  const glb = await glbPromise, glbFile = path.join(output, 'workflow.glb'); await glb.saveAs(glbFile); await ready();
  const bytes = fs.readFileSync(glbFile); assert.equal(bytes.subarray(0, 4).toString(), 'glTF'); assert(bytes.length > 1000);

  for (const quality of ['low', 'medium', 'high']) { await page.locator('#render-quality').selectOption(quality); await frames(); assert.equal(await page.evaluate(() => editor.metrics().quality), quality); }
  await page.evaluate(() => { editor.select('building', 0); editor.focus(); }); await frames();
  await page.screenshot({ path: path.join(output, 'workflow-building-high.png') });
  await page.getByTitle('Day/night · N', { exact: true }).click(); await frames();
  await page.screenshot({ path: path.join(output, 'workflow-night.png') });
  await page.locator('#lang').selectOption('ru'); await page.setViewportSize({ width: 960, height: 1000 }); await frames();
  await page.locator('[data-tab="materials"]').click(); await frames();
  await page.screenshot({ path: path.join(output, 'workflow-ru-960.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.evaluate(() => editor.world.groups.trains.children.length), 0);
  assert.deepEqual(errors, [], 'no uncaught/browser WebGL errors'); assert.deepEqual(writes, [], 'no server writes');
  assert(dialogs.every((d) => d.type === 'confirm'), JSON.stringify(dialogs)); assert.equal(digest(), sourceBefore);
  console.log(`Workflow passed: roads/T junction/bridge, building, materials, prop, TRS, undo/redo, browser+file reopen, GLB, quality/day/night and RU/EN. Artifacts: ${output}`);
} finally { await browser?.close(); await server.close(); assert.equal(digest(), sourceBefore, 'source city was not changed'); }
