// Node MCP sidecar. No window/filesystem authority is exposed here: all edits run in the live editor.
import http from 'node:http';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { TOOLS, TOOL_BY_NAME } from '../mcp/ops.js';

export function allowedOrigin(value, port) {
  if (value === undefined) return true; // native MCP clients send no Origin
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash
      && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && u.port === String(port);
  } catch { return false; }
}
const error = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });
async function readBody(req, maxBytes = 2 * 1024 * 1024) {
  const parts = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body exceeds 2 MiB'), { status: 413 });
    parts.push(part);
  }
  return parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : undefined;
}
export async function createBridgeServer({ port = 7357, call, getState = () => ({}), token } = {}) {
  let active = 0;
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    const expectedHost = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (!expectedHost.has(req.headers.host) || !allowedOrigin(req.headers.origin, port)) return json(403, { error: 'Origin or Host not allowed' });
    if (token && req.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'Authentication required' });
    if (active >= 16) return json(429, { error: 'Too many pending requests' });
    active++;
    res.once('close', () => { active--; });
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname === '/health' && req.method === 'GET') return json(200, { app: 'vespera-editor', ...getState() });
      if (url.pathname === '/tool' && req.method === 'POST') {
        const body = await readBody(req);
        if (!TOOL_BY_NAME[body?.name]) return json(400, { error: 'Unknown tool' });
        // /tool is the private forwarding endpoint; validate against the same tool schema as /mcp.
        const schema = TOOL_BY_NAME[body.name].schema(z);
        const parsed = z.object(schema).safeParse(body.args ?? {});
        if (!parsed.success) return json(400, { error: parsed.error.message });
        return json(200, await call(body.name, parsed.data));
      }
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') return json(405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
        const body = await readBody(req);
        const mcp = new McpServer({ name: 'vespera-editor', version: '1.0.0' });
        for (const tool of TOOLS) mcp.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.schema(z) }, (args) => call(tool.name, args));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.once('close', () => { void transport.close(); void mcp.close(); });
        await mcp.connect(transport);
        return await transport.handleRequest(req, res, body);
      }
      json(404, { error: 'Not found' });
    } catch (e) { if (!res.headersSent) json(e.status ?? (e instanceof SyntaxError ? 400 : 500), { error: e.message }); else res.end(); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

export async function runSidecar() {
  const port = Number(process.env.VSPB_MCP_PORT ?? 7357);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VSPB_MCP_PORT');
  let state = { file: null, dirty: false }, seq = 0, stopping = false;
  const pending = new Map();
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  const execute = (name, args) => new Promise((resolve) => {
    if (stopping) return resolve(error('Editor closed'));
    if (pending.size >= 16) return resolve(error('Editor is busy'));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); resolve(error(`${name}: editor did not answer in 120 seconds`)); }, 120000);
    pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
    send({ type: 'call', id, name, args });
  });
  // Mutations are serialized so async scripts cannot overlap editor transactions.
  let tail = Promise.resolve();
  const call = (name, args) => { const result = tail.then(() => execute(name, args)); tail = result.catch(() => {}); return result; };
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'state') state = { file: msg.file ?? null, dirty: !!msg.dirty };
      else if (msg.type === 'result') { pending.get(msg.id)?.(msg.result); pending.delete(msg.id); }
    } catch (e) { console.error('Invalid host message:', e.message); }
  });
  const server = await createBridgeServer({ port, call, getState: () => state, token: process.env.VSPB_MCP_TOKEN });
  send({ type: 'ready', port });
  const stop = () => { stopping = true; for (const done of pending.values()) done(error('Editor closed')); pending.clear(); server.closeAllConnections(); server.close(); input.close(); };
  process.stdin.once('end', stop);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.error(`City Labs MCP: http://127.0.0.1:${port}/mcp`);
}
// Bundled CJS is the sidecar entry point; source imports stay side-effect free for tests.
if (typeof __CITY_LABS_SIDECAR__ !== 'undefined' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  runSidecar().catch((e) => { console.error('MCP sidecar:', e.message); process.exit(1); });
}
