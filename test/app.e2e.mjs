// Desktop app end to end, on a scratch copy of the world and a spare MCP port:
// open the file, drive it over MCP (HTTP and the stdio proxy), screenshot, undo, save, outside change.
//   node test/app.e2e.mjs [outDir for screenshots]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { decode } from '../format/vspb.js';
import { FileSession } from '../mcp/file-session.js';

const PORT = '7399', out = process.argv[2] ?? os.tmpdir();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vspb-app-')), file = path.join(dir, 'world.vspb');
fs.copyFileSync('city/data/vespera.vspb', file);
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'OK   ' : 'FAIL ') + m); };

const env = { ...process.env, VSPB_MCP_PORT: PORT };
delete env.ELECTRON_RUN_AS_NODE;              // set by VS Code for its children: Electron would run as Node
const app = await electron.launch({ args: ['.', file], env });
app.process().stdout.on('data', (d) => process.stdout.write('[app] ' + d));
app.process().stderr.on('data', (d) => process.stdout.write('[app!] ' + d));
const win = await app.firstWindow();
console.log('window', await win.url());
win.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
const errs = [];
win.on('pageerror', (e) => errs.push(e.message));
await win.waitForFunction(() => document.getElementById('busy').hidden && window.editor?.doc, null, { timeout: 240000 });
ok((await win.title()).includes('world.vspb') || (await win.textContent('#source')).includes('world.vspb'), 'app opened the file given on the command line');

const mcp = new Client({ name: 'e2e', version: '1' });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
const call = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r;
};
const J = async (name, args) => JSON.parse((await call(name, args)).content[0].text);
ok((await mcp.listTools()).tools.length === 18, 'HTTP MCP lists the tools');
const info = await J('world_info');
ok(info.app === true && info.file === file, 'world_info comes from the editor');

const n0 = await win.evaluate(() => editor.doc.layers.buildings.items.length);
const [g] = await J('terrain_sample', { points: [[-60, -260]] });
const b = await J('create', { kind: 'building', record: { type: 'tower', zone: 'downtown', parts: [{ p: [[-80, -280], [-40, -280], [-40, -240], [-80, -240]], z: g.graded, h: 120, m: 'glass_teal' }] } });
ok(await win.evaluate(() => editor.doc.layers.buildings.items.length) === n0 + 1, 'MCP create shows up in the editor document');
await J('select', { kind: 'building', index: b.index });
ok(await win.evaluate(() => editor.sel?.kind === 'building'), 'MCP select selects it in the UI');
ok((await win.textContent('#save')).includes('несохранён'), 'the editor marks the world unsaved');

const shot = await call('screenshot', { camera: [-60, -620, 260], target: [-60, -260, 40], width: 900 });
const img = shot.content.find((c) => c.type === 'image');
ok(img && img.data.length > 10000, 'screenshot returns an image');
if (img) fs.writeFileSync(path.join(out, 'app_mcp_shot.png'), Buffer.from(img.data, 'base64'));
ok(await win.evaluate(() => !document.body.classList.contains('shot')), 'panels are back after the screenshot');

const road = await J('road_add', { points: [[-200, -420], [-60, -480], [80, -430]], cls: 'street', name: 'MCP Street' });
ok(await win.evaluate((id) => !!editor.world.roadWorld.bufs.get('e' + id)?.m.asphalt, road.id), `MCP road_add builds asphalt in the editor (#${road.id})`);
const u = await J('undo');
ok(/дорога/.test(u.undone) && await win.evaluate((id) => !editor.doc.layers.roads.edges.some((e) => e.id === id), road.id), 'MCP undo removes the road');
await J('redo');

// the stdio server forwards to the app when it has the same file open
const stdio = new Client({ name: 'e2e-stdio', version: '1' });
await stdio.connect(new StdioClientTransport({ command: 'node', args: ['mcp/stdio.mjs', file], env: { ...process.env, VSPB_MCP_PORT: PORT } }));
const si = JSON.parse((await stdio.callTool({ name: 'world_info', arguments: {} })).content[0].text);
ok(si.app === true, 'stdio MCP forwards to the running app');
await stdio.close();

const saved = await J('save');
const d1 = await decode(fs.readFileSync(file));
ok(saved.file === file && d1.layers.buildings.items.length === n0 + 1 && d1.layers.roads.edges.some((e) => e.name === 'MCP Street'), 'MCP save writes the file');
ok((await win.textContent('#save')).includes('сохранено'), 'the editor shows it saved');
await win.screenshot({ path: path.join(out, 'app_window.png') });

// an outside change to a clean world is picked up
const fsess = await new FileSession(file).ready();
fsess.insert('tree', [-70, -300, g.graded]);
await fsess.save();
await win.waitForFunction((n) => editor.doc.layers.buildings.trees.length === n, d1.layers.buildings.trees.length + 1, { timeout: 30000 }).then(() => ok(true, 'outside change reloaded'), () => ok(false, 'outside change reloaded'));

await mcp.close();
await app.close();
fs.rmSync(dir, { recursive: true });
ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
console.log(fails ? `${fails} FAILED` : 'all app checks passed');
process.exit(fails ? 1 : 0);
