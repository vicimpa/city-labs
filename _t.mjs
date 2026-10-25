import { chromium } from '@playwright/test';
const b = await chromium.launch({ args: ['--use-gl=angle','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('ERR', e.message)); p.on('console', m => m.type()==='error' && console.log('CON', m.text()));
await p.goto('http://localhost:5199/viewer/'); await p.waitForFunction(() => window.__roads, null, { timeout: 120000 });
await p.waitForTimeout(3000);
await p.click('text=Сесть в машину'); await p.waitForFunction(() => document.body.innerText.includes('Выйти'), null, { timeout: 120000 });
await p.waitForTimeout(1500); await p.keyboard.down('KeyW'); await p.waitForTimeout(4000); await p.keyboard.down('KeyA'); await p.waitForTimeout(800); await p.keyboard.up('KeyA');
console.log("fps", await p.evaluate(()=>new Promise(r=>{let n=0,t=performance.now();const f=()=>{n++; if(performance.now()-t<2000) requestAnimationFrame(f); else r(n/2)};f()})));
for (let i=0;i<5;i++){ console.log(await p.evaluate(()=>{const v=window.__p; return v?JSON.stringify([v.keys, v.speed.toFixed(2), [0,1,2,3].map(w=>v.ctl.wheelIsInContact(w))]):"none"})); await p.waitForTimeout(500);}
await p.screenshot({ path: process.argv[2] }); console.log(await p.evaluate(() => document.querySelector('div[style*="monospace"]').textContent));
await b.close();
