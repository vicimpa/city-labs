// Focused HEADLESS source-app regression: inward tunnel normals cause high-only
// receiver acne. No benchmark, global bias changes or disabled shadows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createOutputDir, launchBrowser, captureFailure } from '../helpers/browser.mjs';
import { createServer } from 'vite';

const out = createOutputDir('tunnel-shadow');
const digest = () => createHash('sha256').update(fs.readFileSync('city/data/vespera.vspb')).digest('hex'), before = digest();
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser, page;
try {
  await server.listen(); browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/editor/`);
  await page.waitForFunction(() => window.editor?.world && document.querySelector('#busy').hidden, null, { timeout: 60000 });
  await page.locator('#sample').evaluate((el) => el.click());
  await page.waitForFunction(() => editor.doc.layers.buildings.items.length === 3508 && document.querySelector('#busy').hidden, null, { timeout: 60000 });
  await page.evaluate(() => {
    const e = editor.doc.layers.roads.edges.find((e) => e.tunnel?.some(Boolean)), i = e.tunnel.findIndex(Boolean), p = e.pts[i], previous = e.pts[Math.max(0, i - 10)];
    const length = Math.hypot(p[0] - previous[0], p[1] - previous[1]), dx = (p[0] - previous[0]) / length, dy = (p[1] - previous[1]) / length;
    editor.setQuality('medium'); editor.select(null); editor.world.setGrid(false);
    editor.world.groups.roads.parent.getObjectByName('roadGraph').visible = false;
    editor.setView(p[0] - dx * 80 + dy * 20, p[1] - dy * 80 - dx * 20, p[2] + 24, p[0] + dx * 20, p[1] + dy * 20, p[2] + 5);
    const meshes = []; editor.world.groups.roads.traverse((o) => { if (o.isMesh && o.userData.material === 'tunnel') meshes.push(o); });
    window.tunnelQA = { meshes, flip() { for (const m of meshes) {
      const a = m.geometry.index.array;
      for (let i = 0; i < a.length; i += 3) { const b = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = b; }
      m.geometry.index.needsUpdate = true; m.geometry.computeVertexNormals();
    } }, meanNormalZ() { let sum = 0, count = 0; for (const m of meshes) { const n = m.geometry.attributes.normal; for (let i = 0; i < n.count; i++) { sum += n.getZ(i); count++; } } return sum / count; } };
  });
  // Two app frames settle matrices/LOD; capture() then renders and reads back the GPU.
  const frames = async () => page.evaluate(async () => { for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame); });
  const pixels = async () => page.evaluate(async () => {
    const image = await createImageBitmap(await (await fetch(editor.capture())).blob()), c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
    const context = c.getContext('2d'); context.drawImage(image, 0, 0); image.close();
    // Read the original full-resolution pixels, but transfer only the oracle ROI and neighbours.
    const x = 455, y = 422, width = 188, height = 31;
    return { data: [...context.getImageData(x, y, width, height).data], width, x, y };
  });
  await frames(); const medium = await pixels();
  await page.evaluate(() => editor.setQuality('high')); await frames();
  const fixed = await pixels(), fixedStats = await page.evaluate(() => ({ ...editor.metrics().render, meanNormalZ: tunnelQA.meanNormalZ(), flags: tunnelQA.meshes.map((m) => ({ cast: m.castShadow, receive: m.receiveShadow })) }));
  await page.screenshot({ path: `${out}/tunnel-shadow-fixed.png` });
  // Reintroduce the generator's historical inward winding for a counterexample.
  await page.evaluate(() => tunnelQA.flip()); await frames(); const inward = await pixels(), inwardStats = await page.evaluate(() => ({ ...editor.metrics().render, meanNormalZ: tunnelQA.meanNormalZ() }));
  await page.screenshot({ path: `${out}/tunnel-shadow-inward.png` });
  const score = (image) => {
    let sum = 0, count = 0;
    // Interior portions of the two roof planes in this fixed production camera.
    for (const [x0, y0, x1, y1] of [[455, 422, 535, 439], [575, 439, 643, 453]]) for (let y = y0; y < y1; y++) for (let x = x0 + 1; x < x1 - 1; x++) {
      const k = ((y - image.y) * image.width + x - image.x) * 4, ref = medium.data;
      if (Math.max(ref[k], ref[k + 1], ref[k + 2]) - Math.min(ref[k], ref[k + 1], ref[k + 2]) > 16 || ref[k] < 80 || ref[k] > 190) continue;
      const delta = (i) => image.data[i] - ref[i]; sum += Math.abs(delta(k - 4) - 2 * delta(k) + delta(k + 4)); count++;
    }
    return { value: sum / count, pixels: count };
  };
  const fixedNoise = score(fixed), inwardNoise = score(inward);
  assert.ok(fixedStats.meanNormalZ > 0 && inwardStats.meanNormalZ < 0, 'render tube normals face outward');
  assert.ok(fixedStats.flags.length && fixedStats.flags.every((f) => f.cast && f.receive), 'casting and receiving stay enabled');
  assert.equal(fixedStats.calls, inwardStats.calls); assert.equal(fixedStats.triangles, inwardStats.triangles);
  assert.ok(fixedNoise.pixels > 500); assert.ok(fixedNoise.value < inwardNoise.value * 0.5, `roof acne: ${JSON.stringify({ fixedNoise, inwardNoise })}`);
  await page.evaluate(() => tunnelQA.flip()); await frames();
  assert.deepEqual(errors, []);
  fs.writeFileSync(`${out}/tunnel-shadow-results.json`, JSON.stringify({ fixedNoise, inwardNoise, fixedStats, inwardStats, errors }, null, 2));
  console.log('Headless tunnel shadow passed:', JSON.stringify({ fixedNoise, inwardNoise, calls: fixedStats.calls, triangles: fixedStats.triangles }));
} catch (error) { await captureFailure(page, out, error); throw error; } finally { await browser?.close(); await server.close(); assert.equal(digest(), before, 'source city never modified'); }
