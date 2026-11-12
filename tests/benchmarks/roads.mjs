// Headless-only comparison of road merge granularity; no source/world file writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const currentURL = process.env.CURRENT_URL;
assert(currentURL, 'Set CURRENT_URL to the editor URL');
const output = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'city-labs-roads-')); fs.mkdirSync(output, { recursive: true });
const out = path.join(output, 'roads-render-results.json');
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const result = { started: new Date().toISOString(), viewport: [1440, 900], samples: 60, warmup: 24, runs: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.routeWebSocket(/.*/, () => {});
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (d) => d.accept());
  await page.goto(currentURL);
  await page.waitForFunction(() => window.editor?.world && window.editor?.metrics, undefined, { timeout: 90000 });
  await page.locator('#sample').evaluate((el) => el.click());
  await page.waitForFunction(() => editor.doc.layers.buildings?.items?.length > 2000 && document.querySelector('#busy').hidden, undefined, { timeout: 120000 });
  await page.evaluate(() => { editor.setQuality('medium'); editor.world.setGrid(false); document.body.classList.add('shot'); });
  for (const roadTileSize of [600, 1200, 2400]) {
    await page.evaluate((size) => { editor.world.roadTileSize = size; editor.world.buildRoads(); }, roadTileSize);
    for (const [view, camera] of [['overview', [1500, -7000, 5600, 0, 0, 20]], ['waterfront', [1500, -2800, 900, 0, -400, 40]]]) {
      const run = await page.evaluate(async ({ camera, roadTileSize, view }) => {
        editor.setView(...camera);
        const frames = async (n) => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); };
        await frames(24); const frameMS = [], calls = [], triangles = [];
        let previous = await new Promise(requestAnimationFrame);
        for (let i = 0; i < 60; i++) {
          const now = await new Promise(requestAnimationFrame); frameMS.push(now - previous); previous = now;
          calls.push(editor.metrics().render.calls); triangles.push(editor.metrics().render.triangles);
        }
        const stats = (a) => { a.sort((x, y) => x - y); return { median: a[Math.floor(a.length / 2)], p95: a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] }; };
        const full = editor.metrics(), categories = {};
        for (const name of ['terrain', 'roads', 'furniture', 'blocks', 'surfaces', 'trees', 'rails', 'wind', 'cables']) {
          const g = editor.world.groups[name], visible = g.visible; g.visible = false; await frames(2);
          categories[name] = full.render.calls - editor.metrics().render.calls; g.visible = visible; await frames(2);
        }
        const tiles = [...editor.world.roadTiles], largest = tiles.sort((a, b) => b[1].recs.size - a[1].recs.size)[0];
        const mergeMS = [];
        for (let i = 0; i < 12; i++) { const start = performance.now(); editor.world.buildRoadTile(largest[0]); mergeMS.push(performance.now() - start); await frames(1); }
        return { roadTileSize, view, camera, frameMS: stats(frameMS), calls: stats(calls), triangles: stats(triangles), categories,
          roadTiles: editor.world.roadTiles.size, largestTile: { key: largest[0], owners: largest[1].recs.size, mergeCPU: stats(mergeMS) }, memory: editor.metrics().memory };
      }, { camera, roadTileSize, view });
      result.runs.push(run); console.log(JSON.stringify(run)); fs.writeFileSync(out, JSON.stringify(result, null, 2));
    }
  }
  result.errors = errors; assert.deepEqual(errors, []);
} finally { result.finished = new Date().toISOString(); fs.writeFileSync(out, JSON.stringify(result, null, 2)); await browser.close(); }
