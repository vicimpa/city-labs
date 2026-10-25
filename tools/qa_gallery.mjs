// Screenshot every issue of the world's `issues` layer into city/docs/qa/ + index.html
import { chromium } from 'playwright';
import fs from 'fs';
import { decode } from '../format/vspb.js';
const per = Number(process.argv[2] ?? 12);
const issues = ((await decode(fs.readFileSync('city/data/vespera.vspb'))).layers.issues?.items ?? []).filter(i => i.p[0] || i.p[1]);
const byRule = {};
for (const it of issues) (byRule[it.rule] ??= []).push(it);
const out = 'city/docs/qa'; fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 900, height: 600 } });
await p.goto('http://localhost:5199/viewer/');
await p.waitForFunction(() => document.getElementById('status').textContent.includes('edges'), null, { timeout: 180000 });
let html = '<!doctype html><meta charset=utf-8><title>Road QA</title><style>body{background:#111;color:#ddd;font:13px system-ui}img{width:440px}figure{display:inline-block;margin:6px}</style>';
for (const [rule, list] of Object.entries(byRule).sort()) {
  html += `<h2>${rule} — ${list.length}</h2>`;
  for (const [k, it] of list.slice(0, per).entries()) {
    const z = it.z ?? 20, [x, y] = it.p;
    await p.evaluate(v => window.viewer.setView(...v), [x + 45, y - 70, z + 60, x, y, z]);
    await p.waitForTimeout(400);
    const f = `${rule}_${k}.png`;
    await p.screenshot({ path: `${out}/${f}` });
    html += `<figure><img src="${f}"><figcaption>${it.p.join(', ')} — ${it.msg}</figcaption></figure>`;
  }
}
fs.writeFileSync(`${out}/index.html`, html);
await b.close();
console.log('qa gallery', Object.fromEntries(Object.entries(byRule).map(([k, v]) => [k, v.length])));
