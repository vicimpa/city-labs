// Real editor gesture regressions. Disposable browser storage; no native host,
// file-open/save commands, project write middleware or visible browser windows.
// Run: node tests/browser/gestures.test.mjs [screenshot-directory]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const source = 'city/data/vespera.vspb';
const digest = () => fs.existsSync(source) ? createHash('sha256').update(fs.readFileSync(source)).digest('hex') : null;
const sourceBefore = digest();
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: { cookies: [], origins: [] } });
  const writes = [], errors = [];
  await context.route('**/*', (route) => {
    if (!['GET', 'HEAD'].includes(route.request().method())) { writes.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/editor/`);
  await page.waitForFunction(() => window.editor?.doc && !document.querySelector('#busy')?.offsetParent);
  const initial = await page.evaluate(() => ({ native: !!window.vspbHost, buildings: editor.doc.layers.buildings.items.length, roads: editor.doc.layers.roads.edges.length, history: editor.hist.done.length }));
  assert.deepEqual(initial, { native: false, buildings: 0, roads: 0, history: 0 }, 'refuse to mutate a nonempty or native-host session');
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const call = async (name, args) => {
    const result = await page.evaluate(([n, a]) => editor.call(n, a), [name, args]);
    assert(!result?.isError, JSON.stringify(result)); await frames(); return result;
  };
  const state = () => page.evaluate(() => ({ buildings: structuredClone(editor.doc.layers.buildings.items), history: editor.hist.done.length, hidden: editor.world.hidden.size }));
  await call('create', { kind: 'building', record: { type: 'block', parts: [{ p: [[-20, -20], [20, -20], [20, 20], [-20, 20]], z: 0, h: 20, m: 'concrete' }] } });
  await page.evaluate(() => { editor.setTool('select'); editor.select('building', 0); editor.setView(110, -150, 140, 0, 0, 10); });
  await frames();
  const roofPoint = () => page.evaluate(async () => { const { localToWorld } = await import('/format/transforms.js'); return editor.toScreen(...localToWorld(editor.doc.layers.buildings.items[0], [0, 0, 20])); });
  const startDrag = async (vertex = false) => {
    await page.evaluate(() => { editor.setTool('select'); editor.select('building', 0); }); await frames();
    const before = await state();
    const p = vertex ? await page.evaluate(() => editor.handles().find(([x, y]) => x > 250 && x < 1050 && y > 120 && y < 880)) : await roofPoint();
    assert(p, 'visible gesture target');
    await page.mouse.move(...p); await page.mouse.down();
    await page.mouse.move(p[0] + 45, p[1] + 20, { steps: 5 }); await frames();
    const moving = await state();
    assert.notDeepEqual(moving.buildings, before.buildings, 'gesture actually changes the fixture');
    assert.equal(moving.hidden, 1, 'live preview hides the committed mesh');
    return before;
  };
  const assertRollback = async (before, label) => { await page.mouse.up(); await frames(); assert.deepEqual(await state(), before, label); };

  for (const vertex of [false, true]) {
    const before = await startDrag(vertex);
    await page.keyboard.press('Escape');
    await assertRollback(before, `Escape restores ${vertex ? 'vertex' : 'object'} gesture and history`);
  }
  const rollbackScreenshot = path.join(process.argv[2] ?? os.tmpdir(), 'city-labs-gesture-rollback.png');
  await page.screenshot({ path: rollbackScreenshot });

  const beforeTransform = await state();
  await call('transform', { kind: 'building', index: 0, dx: 8 });
  await startDrag(); await page.keyboard.press('Control+z');
  await assertRollback(beforeTransform, 'undo cancels drag then undoes only the committed transform');

  const beforeDelete = await startDrag();
  await page.keyboard.press('Delete'); await page.mouse.up(); await frames();
  assert.deepEqual(await state(), { buildings: [], history: beforeDelete.history + 1, hidden: 0 }, 'delete cancels drag and removes the selected fixture once');
  await page.keyboard.press('Control+z'); await frames();
  assert.deepEqual(await state(), beforeDelete, 'undo delete restores the exact pre-gesture record');

  const beforeSwitch = await startDrag();
  await page.keyboard.press('Digit2');
  await assertRollback(beforeSwitch, 'switching tools cancels the active gesture');
  assert.equal(await page.locator('[data-tool="road"]').evaluate((el) => el.classList.contains('on')), true);

  // Additional exit paths share cancelGesture but must also release render state.
  for (const event of ['pointercancel', 'blur']) {
    const before = await startDrag();
    await page.evaluate((type) => type === 'blur' ? window.dispatchEvent(new Event(type)) : document.querySelector('canvas').dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse' })), event);
    await assertRollback(before, `${event} restores gesture`);
  }
  const beforeDeselect = await startDrag();
  await page.evaluate(() => editor.select(null));
  await assertRollback(beforeDeselect, 'selection change restores gesture');

  await call('update', { kind: 'building', index: 0, set: { transform: { p: [12, 8, 4], r: [0.2, -0.15, 0.7], s: [1.4, 0.8, 1.2] } } });
  await page.evaluate(() => { editor.setTool('select'); editor.select(null); }); await frames();
  await page.mouse.click(...await roofPoint()); await frames();
  assert.equal(await page.evaluate(() => editor.sel?.kind === 'building' && editor.sel.rec === editor.doc.layers.buildings.items[0]), true, 'picking matches translated, tilted, rotated and scaled geometry');
  const handlesMatch = await page.evaluate(async () => {
    const { localToWorld } = await import('/format/transforms.js');
    const rec = editor.doc.layers.buildings.items[0], handles = editor.handles();
    // Handles deliberately sit 0.3 m above the authored roof plane.
    return rec.parts[0].p.every(([x, y]) => { const p = editor.toScreen(...localToWorld(rec, [x, y, 20.3])); return handles.some((h) => Math.hypot(h[0] - p[0], h[1] - p[1]) < 0.01); });
  });
  assert(handlesMatch, 'selection handles match transformed roof vertices');
  assert.equal(await page.evaluate(() => editor.doc.layers.buildings.items.length), 1, 'fixture world remains intact');
  assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(writes, [], 'no write requests');
  assert.equal(digest(), sourceBefore, 'source city bytes remain unchanged');
  console.log(`OK Escape object/vertex, undo/delete during drag, tool/selection changes, blur/pointercancel, transformed picking and handles; screenshot ${rollbackScreenshot}`);
} finally {
  await browser?.close(); await server.close();
  assert.equal(digest(), sourceBefore, 'source city bytes remain unchanged after cleanup');
}
