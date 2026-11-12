// Actual editor lifecycle with a staged native-host fixture. Headless, scratch bytes only.
import assert from 'node:assert/strict';
import { createOutputDir, launchBrowser, captureFailure } from '../helpers/browser.mjs';
import { createServer } from 'vite';
import { emptyWorld, encodeWorld } from '../../format/world.js';
import { validateHostFile } from '../../editor/desktop.js';

const a = await encodeWorld(emptyWorld({ width: 250, depth: 250 }));
const b = await encodeWorld(emptyWorld({ width: 500, depth: 250 }));
let destination = 'A', commits = 0;
const accept = async (path) => { destination = path; commits++; };
const result = (bytes) => ({ path: 'B', bytesBase64: Buffer.from(bytes).toString('base64') });
const staged = await validateHostFile(result(b), accept, { staged: true });
assert.equal(destination, 'A', 'validation must not select a native save target');
await assert.rejects(validateHostFile(result(new Uint8Array([1, 2, 3])), accept, { staged: true }));
assert.equal(destination, 'A', 'bad candidate preserves current target');
await staged.commit(); await staged.commit();
assert.equal(destination, 'B'); assert.equal(commits, 1, 'accept candidate once');

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0, hmr: false } });
const out = createOutputDir('files');
let browser, page;
try {
  await server.listen();
  browser = await launchBrowser();
  page = await browser.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  let allowConfirm = false, confirms = 0, expectedAlert = false;
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'confirm') { confirms++; await (allowConfirm ? dialog.accept() : dialog.dismiss()); }
    else { if (!expectedAlert) errors.push(dialog.message()); await dialog.dismiss(); }
  });
  await page.addInitScript(({ a, b }) => {
    const bytes = (v) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
    const state = window.nativeFixture = { path: '/scratch/A.vspb', calls: [], writes: [], callbacks: {}, holdSave: false, holdOpen: false, cancelOpen: false };
    const file = async (name) => {
      state.calls.push(name);
      if (state.holdOpen) await new Promise((resolve) => { state.releaseOpen = resolve; });
      if (state.cancelOpen) return null;
      const path = name === 'current' || name === 'reload' ? state.path : '/scratch/B.vspb';
      return { path, bytes: state.badOpen ? new Uint8Array([1, 2, 3]) : bytes(path.endsWith('A.vspb') ? a : b), async commit() { state.calls.push('accept:' + path); state.path = path; } };
    };
    const save = async (data) => {
      state.calls.push('save');
      if (state.holdSave) await new Promise((resolve) => { state.releaseSave = resolve; });
      state.writes.push({ path: state.path, bytes: data.length });
      return { path: state.path };
    };
    window.vspbHost = {
      platform: 'darwin', frameless: false,
      current: () => file('current'), open: () => file('open'), openSample: () => file('sample'), reload: () => file('reload'), openPath: () => file('openPath'),
      newFile: async () => { state.calls.push('new'); state.path = null; },
      save, saveAs: save, info: async () => ({}), setDirty: () => {}, setTitle: () => {}, setLang: () => {},
      on: (event, callback) => { state.callbacks[event] = callback; },
    };
  }, { a: Buffer.from(a).toString('base64'), b: Buffer.from(b).toString('base64') });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/editor/`);
  await page.waitForFunction(() => window.editor?.doc && document.querySelector('#busy').hidden);
  const width = () => page.evaluate(() => (editor.doc.layers.terrain.nx - 1) * editor.doc.layers.terrain.res);
  const dirty = () => page.evaluate(async () => {
    const r = await editor.call('create', { kind: 'tree', record: [20, 20, 10] });
    if (r.isError) throw new Error(r.content[0].text);
  });
  assert.equal(await width(), 250);
  await dirty();
  // Regression: cancellation happens before opening or accepting the native sample.
  await page.evaluate(() => document.querySelector('#sample').onclick());
  assert.equal(confirms, 1);
  assert.deepEqual(await page.evaluate(() => [nativeFixture.path, nativeFixture.calls.includes('sample'), editor.doc.layers.buildings.trees.length]), ['/scratch/A.vspb', false, 1]);
  assert.equal(await page.evaluate(() => editor.saveNow()), true);
  assert.equal(await page.evaluate(() => nativeFixture.writes.at(-1).path), '/scratch/A.vspb');

  // No document transition (including MCP and OS Open) may run while saving.
  await dirty(); await page.evaluate(() => { nativeFixture.holdSave = true; window.pendingSave = editor.saveNow(); });
  await page.waitForFunction(() => typeof nativeFixture.releaseSave === 'function');
  const before = await page.evaluate(() => nativeFixture.calls.length);
  await page.evaluate(async () => {
    await document.querySelector('#sample').onclick();
    await document.querySelector('#open').onclick();
    await document.querySelector('#reset').onclick();
    await document.querySelector('#new').onclick();
    await nativeFixture.callbacks['file:open-request']({ path: '/scratch/B.vspb' });
    window.busyNew = await editor.call('new_world', { force: true });
  });
  assert.equal(await page.evaluate(() => nativeFixture.calls.length), before);
  assert.equal(await page.evaluate(() => window.busyNew.isError), true);
  assert.equal(await page.locator('[role=dialog]').count(), 0);
  await page.evaluate(async () => { nativeFixture.releaseSave(); await pendingSave; nativeFixture.holdSave = false; });
  assert.equal(await width(), 250);
  assert.equal(await page.evaluate(() => nativeFixture.writes.at(-1).path), '/scratch/A.vspb');

  // Opening owns the transition until the staged destination and world both commit.
  allowConfirm = true;
  await page.evaluate(() => { nativeFixture.holdOpen = true; window.pendingOpen = document.querySelector('#open').onclick(); });
  await page.waitForFunction(() => typeof nativeFixture.releaseOpen === 'function');
  assert.equal(await page.evaluate(() => editor.saveNow()), false, 'Save cannot race with native Open');
  await page.evaluate(async () => {
    window.editWhileOpen = await editor.call('create', { kind: 'tree', record: [0, 0, 0] });
    await document.querySelector('#sample').onclick();
  });
  assert.equal(await page.evaluate(() => window.editWhileOpen.isError), true);
  assert.equal(await page.evaluate(() => nativeFixture.path), '/scratch/A.vspb');
  await page.evaluate(async () => { nativeFixture.releaseOpen(); await pendingOpen; nativeFixture.holdOpen = false; });
  assert.equal(await width(), 500);
  assert.equal(await page.evaluate(() => nativeFixture.path), '/scratch/B.vspb');
  assert.equal(await page.evaluate(() => editor.saveNow()), true);
  assert.equal(await page.evaluate(() => nativeFixture.writes.at(-1).path), '/scratch/B.vspb');

  // Canceling the native picker leaves both the loaded document and target untouched.
  await page.evaluate(async () => { nativeFixture.cancelOpen = true; await document.querySelector('#open').onclick(); });
  assert.equal(await width(), 500); assert.equal(await page.evaluate(() => nativeFixture.path), '/scratch/B.vspb');
  assert.equal(await page.evaluate(() => editor.saveNow()), true, 'Picker cancel releases transition lock');

  // Decode failure also releases the lock without accepting a destination.
  expectedAlert = true;
  const acceptsBefore = await page.evaluate(() => nativeFixture.calls.filter((v) => v.startsWith('accept:')).length);
  assert.equal(await page.evaluate(async () => { nativeFixture.cancelOpen = false; nativeFixture.badOpen = true; return document.querySelector('#open').onclick(); }), false);
  expectedAlert = false;
  assert.equal(await page.evaluate(() => nativeFixture.calls.filter((v) => v.startsWith('accept:')).length), acceptsBefore);
  assert.equal(await width(), 500);
  assert.equal(await page.evaluate(() => editor.saveNow()), true, 'Decode failure releases transition lock');
  await page.evaluate(() => { nativeFixture.badOpen = false; window.pendingNew = document.querySelector('#new').onclick(); });
  await page.locator('[role=dialog]').waitFor();
  assert.equal(await page.evaluate(() => editor.saveNow()), false, 'New-map form also owns the transition');
  await page.locator('[role=dialog]').press('Escape');
  await page.evaluate(() => window.pendingNew);
  assert.equal(await page.evaluate(() => nativeFixture.path), '/scratch/B.vspb');
  assert.equal(await page.evaluate(() => editor.saveNow()), true, 'New-map cancel releases transition lock');
  assert.deepEqual(errors, []);
  console.log('OK native file transitions: staged acceptance, canceled Sample/Open/New, malformed Open rollback, save/open mutual exclusion, OS Open, New/Reload and MCP guards');
} catch (error) { await captureFailure(page, out, error); throw error; } finally { await browser?.close(); await server.close(); }
