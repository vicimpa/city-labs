// Actual Chromium renderer comparison. Both Vite servers must be running.
// node tests/benchmarks/render.mjs [output-directory]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'city-labs-render-')); fs.mkdirSync(out, { recursive: true });
const baselineURL = process.env.BASELINE_URL, currentURL = process.env.CURRENT_URL;
assert(baselineURL && currentURL, 'Set BASELINE_URL and CURRENT_URL to the two editor URLs');
const warmup = Number(process.env.BENCH_WARMUP ?? 24), samples = Number(process.env.BENCH_SAMPLES ?? 60);
const results = { started: new Date().toISOString(), viewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, warmup, samples,
  instrumentation: 'Read-only editor.metrics() exposes renderer.info; both versions must expose the same metrics API. Vite HMR websocket is blocked to freeze the loaded version during measurements.', runs: [], resources: [], errors: [], screenshots: [] };
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
results.browser = browser.version();

async function frames(page, count) {
  return page.evaluate(async (count) => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame); }, count);
}
async function measured(page, variant, scene, quality, view, camera) {
  await page.evaluate(({ quality, camera }) => {
    if (window.editor.setQuality) window.editor.setQuality(quality === 'default' ? 'medium' : quality);
    else if (quality !== 'default') window.editor.world.setQuality?.(quality);
    window.editor.setView(...camera);
  }, { quality, camera });
  await frames(page, warmup);
  const sample = await page.evaluate(async (samples) => {
    const times = [], calls = [], triangles = [], renderCPU = [];
    let previous = await new Promise(requestAnimationFrame);
    for (let i = 0; i < samples; i++) {
      const now = await new Promise(requestAnimationFrame); times.push(now - previous); previous = now;
      const m = window.editor.metrics(); calls.push(m.render.calls); triangles.push(m.render.triangles);
      if (Number.isFinite(m.frameCPU)) renderCPU.push(m.frameCPU);
    }
    const stats = (values) => { const a = [...values].sort((a, b) => a - b); return { median: a[Math.floor(a.length * 0.5)], p95: a[Math.min(a.length - 1, Math.floor(a.length * 0.95))], min: a[0], max: a.at(-1) }; };
    return { frameMS: stats(times), calls: stats(calls), triangles: stats(triangles), renderCPUMS: renderCPU.length ? stats(renderCPU) : null, metrics: window.editor.metrics() };
  }, samples);
  const run = { variant, scene, quality, view, camera, ...sample };
  assert.ok(run.calls.median > 0 && run.triangles.median > 0, 'scene actually renders');
  if (variant === 'current' && scene === 'fixture1200') assert.ok(run.calls.median <= 150, '1,200-building fixture stays inside 150 draw calls including high shadows');
  results.runs.push(run);
  console.log(JSON.stringify({ variant, scene, quality, view, frameMS: run.frameMS, calls: run.calls.median, triangles: run.triangles.median }));
  fs.writeFileSync(path.join(out, 'render-results.json'), JSON.stringify(results, null, 2));
}
async function screenshot(page, variant, scene, view) {
  const filename = `${variant}-${scene}-${view}.png`;
  await page.screenshot({ path: path.join(out, filename) }); results.screenshots.push(filename);
}
async function fixture(page) {
  await page.evaluate(async () => {
    const { emptyWorld } = await import('/format/world.js');
    Object.assign(window.editor.doc, emptyWorld({ size: 1600, res: 16, ground: 10 }));
    window.editor.world.buildAll();
    const mats = ['concrete', 'plaster_white', 'plaster_beige', 'brick', 'glass_blue', 'glass_teal', 'metal_blue'];
    const items = Array.from({ length: 1200 }, (_, i) => {
      const x = (i % 40) * 30 - 600, y = Math.floor(i / 40) * 30 - 450, yaw = i % 5 === 0 ? Math.PI / 6 : 0;
      const c = Math.cos(yaw), s = Math.sin(yaw), point = ([u, v]) => [x + u * c - v * s, y + u * s + v * c];
      return { id: i, type: i % 3 ? 'block' : 'tower', zone: 'midtown', parts: [{
        p: [[-10, -10], [10, -10], [10, 10], [-10, 10]].map(point),
        ...(i % 13 === 0 ? { holes: [[[-4, -4], [-4, 4], [4, 4], [4, -4]].map(point)] } : {}),
        z: 10, h: 12 + (i * 17 % 18) * 3.3, m: mats[i % mats.length], roofMaterial: 'roof_grey',
      }] };
    });
    window.editor.doc.layers.buildings.items = items;
    window.editor.world.buildBlocks(); window.editor.world.setGrid(false);
    document.body.classList.add('shot');
    window.editor.__bench = { count: items.length };
  });
}
async function resources(page, variant) {
  const data = await page.evaluate(async () => {
    const snapshots = [], e = window.editor, b = e.doc.layers.buildings.items[17];
    e.doc.layers.buildings.trees = [[0, 0, 10], [700, 0, 10]];
    e.doc.layers.furniture.items = Array.from({ length: 20 }, (_, i) => ({ t: 'lamp', p: [i * 40 - 300, -300, 10], h: 0 }));
    e.world.buildTrees(); e.world.buildFurniture();
    const sample = (cycle) => snapshots.push({ cycle, ...e.metrics().memory, programs: e.metrics().programs });
    for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); sample(0);
    for (let i = 1; i <= 30; i++) {
      b.parts[0].h += i % 2 ? 1 : -1; e.world.touch('blocks', b);
      e.world.buildTrees(); e.world.buildFurniture();
      e.doc.layers.defs.facades.office.lit = i % 2 ? 1 : 0; e.world.refreshFacades();
      for (let k = 0; k < 2; k++) await new Promise(requestAnimationFrame);
      if (i % 6 === 0) sample(i);
    }
    return snapshots;
  });
  results.resources.push({ variant, snapshots: data });
  console.log('resources', variant, JSON.stringify(data));
  if (variant === 'current') {
    const steady = data.slice(1), reference = steady[0];
    assert.ok(steady.every((s) => s.geometries === reference.geometries && s.textures === reference.textures && s.programs === reference.programs), 'current resources plateau after repeated edits');
  }
}

try {
  for (const [variant, url] of [['baseline', baselineURL], ['current', currentURL]]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    // Keep hot reload from changing either measured version.
    await page.routeWebSocket(/.*/, () => {});
    page.on('pageerror', (e) => results.errors.push({ variant, error: e.message }));
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(url); await page.waitForFunction(() => window.editor?.world && window.editor?.metrics, undefined, { timeout: 90000 });
    const hardware = await page.evaluate(() => {
      const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { userAgent: navigator.userAgent, dpr: devicePixelRatio, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        extensions: { multiDraw: !!gl.getExtension('WEBGL_multi_draw'), timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'), clipControl: !!gl.getExtension('EXT_clip_control') } };
    }); results[`${variant}Hardware`] = hardware;
    console.log('ready', variant, hardware.renderer);
    await fixture(page);
    const fixtureCameras = [['overview', [650, -1050, 900, 0, 0, 10]], ['street', [-120, -450, 65, 0, -150, 30]]];
    for (const quality of variant === 'current' ? ['default', 'low', 'high'] : ['default']) for (const [view, camera] of fixtureCameras) {
      await measured(page, variant, 'fixture1200', quality, view, camera);
      if (quality === 'default') await screenshot(page, variant, 'fixture1200', view);
    }
    await resources(page, variant);
    await page.evaluate(() => {
      const rotate = ([x, y]) => [x * Math.cos(Math.PI / 6) - y * Math.sin(Math.PI / 6) + 15, x * Math.sin(Math.PI / 6) + y * Math.cos(Math.PI / 6)];
      editor.doc.layers.buildings.items = [
        { type: 'courtyard', parts: [{ p: [[-45, -20], [-10, -20], [-10, 20], [-45, 20]], holes: [[[-37, -12], [-37, 12], [-18, 12], [-18, -12]]], z: 10, h: 18, m: 'plaster_beige', roofMaterial: 'roof_grey' }] },
        { type: 'block', parts: [{ p: [[-10, -15], [10, -15], [10, 15], [-10, 15]].map(rotate), z: 10, h: 28, m: 'brick', roofMaterial: 'roof_white' }] },
        { type: 'tower', parts: [{ p: [[40, 0], [56, 0], [56, 18], [40, 18]], z: 10, h: 38, m: 'glass_blue', roofMaterial: 'roof_grey' }] },
      ];
      editor.world.setQuality?.('high'); editor.world.buildBlocks();
      editor.setView(95, -115, 100, 0, 0, 20);
    });
    await frames(page, 12); await screenshot(page, variant, 'detailQA', 'courtyard-diagonal-roof');
    // Fresh browser document removes direct fixture mutations and isolates sample loading.
    await page.reload(); await page.waitForFunction(() => window.editor?.world && window.editor?.metrics, undefined, { timeout: 90000 });
    console.log('loading sample', variant);
    await page.locator('#sample').evaluate((el) => el.click());
    await page.waitForFunction(() => (window.editor?.doc?.layers.buildings?.items?.length ?? 0) > 2000 && document.querySelector('#busy').hidden, undefined, { timeout: 120000 });
    console.log('sample loaded', variant);
    results[`${variant}SampleCounts`] = await page.evaluate(() => ({ buildings: editor.doc.layers.buildings.items.length, terrainVertices: editor.world.terrainGeo.attributes.position.count, roads: editor.doc.layers.roads.edges.length }));
    await page.evaluate(() => { document.body.classList.add('shot'); editor.world.setGrid(false); });
    const cameras = [['overview', [1500, -7000, 5600, 0, 0, 20]], ['waterfront', [1500, -2800, 900, 0, -400, 40]]];
    for (const quality of variant === 'current' ? ['default', 'low'] : ['default']) for (const [view, camera] of cameras) {
      await measured(page, variant, 'vespera', quality, view, camera);
      if (quality === 'default') await screenshot(page, variant, 'vespera', view);
    }
    if (variant === 'current') results.terrainEditCPU = await page.evaluate(async () => {
      const e = editor, t = e.doc.layers.terrain, core = e.doc.layers.buildings.core ?? [0, 0];
      const i = Math.max(10, Math.min(t.nx - 11, Math.round((core[0] - t.x0) / t.res)));
      const j = Math.max(10, Math.min(t.ny - 11, Math.round((core[1] - t.y0) / t.res))), k = j * t.nx + i, original = t.h[k], times = [];
      for (let n = 0; n < 20; n++) {
        t.h[k] = original + (n % 2 ? 0 : 0.15);
        const start = performance.now(); e.world.updateTerrain(i - 8, j - 8, i + 8, j + 8); times.push(performance.now() - start);
        await new Promise(requestAnimationFrame);
      }
      times.sort((a, b) => a - b);
      return { samples: 20, median: times[10], p95: times[19], min: times[0], max: times[19], cellBox: [i - 8, j - 8, i + 8, j + 8], includes: 'CPU source attribute and local chunk buffer update, excludes GPU completion and UI/undo' };
    });
    await page.close();
  }
  assert.deepEqual(results.errors, [], 'no uncaught browser errors');
} finally {
  results.finished = new Date().toISOString(); fs.writeFileSync(path.join(out, 'render-results.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
console.log('Browser rendering comparison completed:', path.join(out, 'render-results.json'));
