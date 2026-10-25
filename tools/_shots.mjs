import { chromium } from 'playwright';
const views = JSON.parse(process.argv[2]);
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
await p.goto('http://localhost:5199/viewer/');
await p.waitForFunction(() => document.getElementById('status').textContent.includes('edges'), null, { timeout: 180000 });
for (const [k, v] of Object.entries(views)) { await p.evaluate(v => window.viewer.setView(...v), v); await p.waitForTimeout(600); await p.screenshot({ path: '/private/tmp/claude-501/-Users-vic-CodeProjects-race-game/c9c67d36-0f52-4965-8378-085c1ea08788/scratchpad/' + k + '.png' }); }
await b.close();
