// Real subprocess + HTTP MCP integration. The editor endpoint is a deterministic fixture;
// native WebView/dialog interaction is a separate manual or WebDriver check.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { allowedOrigin } from '../../desktop/bridge.mjs';
import { validateHostFile } from '../../editor/desktop.js';
import { emptyWorld, encodeWorld } from '../../format/world.js';

let acceptedPath = '/scratch/previous.vspb';
const accept = async (path) => { acceptedPath = path; };
const candidate = (bytes) => ({ path: '/scratch/next.vspb', bytesBase64: Buffer.from(bytes).toString('base64') });
assert.equal(await validateHostFile(null, accept), null);
await assert.rejects(validateHostFile(candidate(Buffer.from('VSPB truncated')), accept));
assert.equal(acceptedPath, '/scratch/previous.vspb', 'Malformed Open must not replace the save destination');
const validWorld = await encodeWorld(emptyWorld({ size: 250 }));
await validateHostFile(candidate(validWorld), accept);
assert.equal(acceptedPath, '/scratch/next.vspb');
console.log('OK Open cancellation / malformed file preserve save destination; valid world is accepted');

async function freePort() { const srv = net.createServer().listen(0, '127.0.0.1'); await once(srv, 'listening'); const port = srv.address().port; await new Promise((r) => srv.close(r)); return port; }
assert.equal(allowedOrigin('http://localhost.evil.example:7357', 7357), false);
assert.equal(allowedOrigin('http://127.0.0.1:7357.evil.example', 7357), false);
assert.equal(allowedOrigin('null', 7357), false);
assert.equal(allowedOrigin('http://localhost:7357', 7357), true);
assert.equal(allowedOrigin('http://localhost:5199', 7357), false);

async function exercise(entry, token, executable = process.execPath) {
  const port = await freePort();
  const child = spawn(executable, [entry], { env: { ...process.env, VSPB_MCP_PORT: String(port), VSPB_MCP_TOKEN: token ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let activeCalls = 0, peakCalls = 0;
  let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
  const lines = readline.createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sidecar startup timeout: ' + stderr)), 10000);
    child.once('exit', (code) => { if (code) reject(new Error(`Sidecar exit ${code}: ${stderr}`)); });
    lines.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.type === 'ready') { clearTimeout(timer); resolve(); }
      if (msg.type === 'call') { activeCalls++; peakCalls = Math.max(peakCalls, activeCalls); setTimeout(() => { activeCalls--; if (child.stdin.writable) child.stdin.write(JSON.stringify({ type: 'result', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ fromEditor: true, name: msg.name, args: msg.args }) }] } }) + '\n'); }, 10); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const client = new Client({ name: 'desktop-bridge-test', version: '1' });
  try {
    await ready;
    child.stdin.write(JSON.stringify({ type: 'state', file: '/scratch/test city.vspb', dirty: true }) + '\n');
    let health;
    for (let i = 0; i < 20; i++) { health = await (await fetch(base + '/health', { headers })).json(); if (health.dirty) break; await new Promise((r) => setTimeout(r, 20)); }
    assert.deepEqual(health, { app: 'vespera-editor', file: '/scratch/test city.vspb', dirty: true });
    for (const origin of ['https://evil.example', `http://localhost.evil.example:${port}`, 'null', 'file:///']) assert.equal((await fetch(base + '/health', { headers: { ...headers, origin } })).status, 403);
    assert.equal(await new Promise((resolve, reject) => { const request = http.get(base + '/health', { headers: { ...headers, host: `evil.example:${port}` } }, (response) => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); }), 403);
    if (token) assert.equal((await fetch(base + '/health')).status, 401);
    assert.equal((await fetch(base + '/tool', { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(base + '/tool', { method: 'POST', headers, body: JSON.stringify({ name: 'missing' }) })).status, 400);
    assert.equal((await fetch(base + '/tool', { method: 'POST', headers, body: JSON.stringify({ name: 'terrain_edit', args: {} }) })).status, 400);
    assert.equal((await fetch(base + '/tool', { method: 'POST', headers, body: 'x'.repeat(2 * 1024 * 1024 + 1) })).status, 413);
    const forwarded = await (await fetch(base + '/tool', { method: 'POST', headers, body: JSON.stringify({ name: 'world_info', args: {} }) })).json();
    assert.equal(JSON.parse(forwarded.content[0].text).fromEditor, true);
    await Promise.all(Array.from({ length: 4 }, () => fetch(base + '/tool', { method: 'POST', headers, body: JSON.stringify({ name: 'world_info', args: {} }) }).then((r) => r.json())));
    assert.equal(peakCalls, 1, 'Editor mutations must be serialized');
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers } }));
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'world_info'));
    const info = await client.callTool({ name: 'world_info', arguments: {} });
    assert.equal(JSON.parse(info.content[0].text).fromEditor, true);
    console.log(`OK ${entry}: MCP tools, live forwarding, state, input bounds, Origin/Host and ${token ? 'token auth' : 'local clients'}`);
  } finally {
    await client.close();
    const exited = once(child, 'exit'); child.stdin.end();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    const [code] = await exited; clearTimeout(timeout); lines.close();
    assert.equal(code, 0, stderr);
    await assert.rejects(fetch(base + '/health', { headers }), /fetch failed/);
  }
}
await exercise('desktop/bridge.mjs');
await exercise('desktop/bridge.mjs', 'scratch-test-token');
if (fs.existsSync('src-tauri/resources/mcp.cjs')) {
  const runtimes = fs.readdirSync('src-tauri/binaries').filter((name) => name.startsWith('city-labs-node-'));
  const platform = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' }[process.platform];
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const runtime = runtimes.find((name) => name.includes(arch) && name.includes(platform));
  assert.ok(runtime, 'A portable Node runtime must accompany bundled MCP');
  await exercise('src-tauri/resources/mcp.cjs', undefined, path.resolve('src-tauri/binaries', runtime));
  const app = process.env.VSPB_TEST_APP_CONTENTS ?? ['release', 'debug'].map((profile) => `src-tauri/target/${profile}/bundle/macos/City Labs.app/Contents`).find((candidate) => fs.existsSync(candidate + '/MacOS/city-labs-node'));
  if (process.platform === 'darwin' && app) {
    assert.ok(fs.existsSync(app + '/MacOS/city-labs-node'), 'Requested app must include the portable runtime');
    await exercise(app + '/Resources/resources/mcp.cjs', undefined, path.resolve(app + '/MacOS/city-labs-node'));
  }
}
else { assert(!process.env.VSPB_TEST_APP_CONTENTS, 'Requested packaged app must have built MCP resources'); console.log('NOTE bundled MCP test skipped; run npm run build:app first'); }
console.log('Desktop sidecar integration passed; native UI was not exercised by this test.');
