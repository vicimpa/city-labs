// Built browser editor under a GitHub-Pages-style subpath, plus shared viewer.
// Headless and read-only; never starts the desktop app or a user's browser profile.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createOutputDir, launchBrowser, captureFailure } from '../helpers/browser.mjs';
import { createServer } from 'vite';

const root = path.resolve('dist-web'), prefix = '/city-labs/';
const out = createOutputDir('deployment');
assert(fs.existsSync(path.join(root, 'index.html')), 'run npm run build:web first');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.vspb': 'application/octet-stream' };
const staticServer = http.createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (!url.pathname.startsWith(prefix)) { res.writeHead(404); return res.end(); }
  const rel = decodeURIComponent(url.pathname.slice(prefix.length)), file = path.resolve(root, rel || 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try { res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream' }); res.end(fs.readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
});
const sourceServer = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser, page;
try {
  staticServer.listen(0, '127.0.0.1'); await once(staticServer, 'listening'); await sourceServer.listen();
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/favicon.ico', (r) => r.fulfill({ status: 204 }));
  await page.goto(`http://127.0.0.1:${staticServer.address().port}${prefix}`);
  await page.waitForFunction(() => window.editor?.world && document.querySelector('#busy').hidden);
  assert.equal(await page.evaluate(() => !!window.vspbHost), false);
  await page.locator('#filemenu').click(); await page.locator('#sample').click();
  await page.waitForFunction(() => window.editor?.doc.layers.buildings.items.length === 3508 && document.querySelector('#busy').hidden, null, { timeout: 60000 });
  await page.evaluate(() => editor.setView(700, -2200, 900, 600, -600, 60));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert((await page.evaluate(() => editor.metrics().render.calls)) > 0);
  assert.equal(await page.evaluate(() => editor.world.groups.trains.children.length), 0);
  assert.equal(await page.evaluate(() => editor.doc.meta.documentVersion), 2);
  await page.locator('#lang').selectOption('en');
  assert((await page.locator('#pane-props').textContent()).includes('Ground patch'), 'kind labels follow runtime locale switches');
  await page.locator('[data-tab="layers"]').click();
  assert.equal(await page.getByLabel('Trains', { exact: true }).count(), 0, 'no dead train layer control');
  await page.getByLabel('Road graph', { exact: true }).uncheck();
  await page.getByLabel('Grid (100 m)', { exact: true }).uncheck();
  await page.locator('[data-tab="find"]').click();
  assert.equal(await page.locator('#pane-find option[value="train"]').count(), 0, 'train routes are absent from editor search');
  await page.locator('[data-tab="props"]').click();
  console.log('OK static dist-web under /city-labs/: browser fallback, sample URL, v1 migration, scene and no trains');
  // Inspect the actual sample's first tunnel portal at street distance, where
  // terrain bore clipping and the protected LOD corridor must meet the road.
  await page.evaluate(() => {
    const edge = editor.doc.layers.roads.edges.find((e) => e.tunnel?.some(Boolean)), i = edge.tunnel.findIndex(Boolean), p = edge.pts[i], prev = edge.pts[Math.max(0, i - 10)];
    const length = Math.hypot(p[0] - prev[0], p[1] - prev[1]), dx = (p[0] - prev[0]) / length, dy = (p[1] - prev[1]) / length;
    editor.setQuality('high'); editor.select(null);
    editor.setView(p[0] - dx * 80 + dy * 20, p[1] - dy * 80 - dx * 20, p[2] + 24, p[0] + dx * 20, p[1] + dy * 20, p[2] + 5);
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: path.join(out, 'tunnel-portal.png') });
  await page.evaluate(() => editor.setQuality('medium'));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: path.join(out, 'tunnel-portal-medium.png') });
  await page.goto(`http://127.0.0.1:${sourceServer.httpServer.address().port}/viewer/`);
  await page.waitForFunction(() => window.viewer?.world && window.__roads?.edges.length === 220, null, { timeout: 60000 });
  await page.evaluate(() => { viewer.setView(700, -2200, 900, 600, -600, 60); viewer_setNight(true); });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert((await page.evaluate(() => viewer.metrics().render.triangles)) > 0);
  assert.equal(await page.evaluate(() => viewer.world.night), true);
  assert.equal(await page.evaluate(() => viewer.world.groups.trains.children.length), 0);
  assert.deepEqual(errors, []);
  console.log('OK shared viewer: local-object city, outdoor PBR/night, terrain LOD, live renderer and no errors');
  console.log(`Artifacts: ${out}`);
} catch (error) { await captureFailure(page, out, error); throw error; } finally { await browser?.close(); await sourceServer.close(); await new Promise((r) => staticServer.close(r)); }
