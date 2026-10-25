#!/usr/bin/env node
// Vespera world MCP server over stdio.
//   node mcp/stdio.mjs [world.vspb]
// When the Vespera Editor app has the same file open, every call is forwarded to it, so edits show
// live in the editor and land in its undo history; otherwise the file is edited headless.
// Logs go to stderr: stdout carries the protocol.
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TOOLS, runTool } from './ops.js';
import { FileSession } from './file-session.js';

export const APP_PORT = +(process.env.VSPB_MCP_PORT ?? 7357);
const file = path.resolve(process.argv[2] ?? 'city/data/vespera.vspb');
const session = new FileSession(file);
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// is the app running with this file open?
async function app() {
  try {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/health`, { signal: AbortSignal.timeout(400) });
    const j = await r.json();
    return j.app === 'vespera-editor' && j.file && real(j.file) === real(file);
  } catch { return false; }
}

const server = new McpServer({ name: 'vespera', version: '1.0.0' });
for (const tool of TOOLS) {
  server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.schema(z) }, async (args) => {
    if (await app()) {
      const r = await fetch(`http://127.0.0.1:${APP_PORT}/tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: tool.name, args }) });
      return await r.json();
    }
    await session.ready();
    return runTool(session, tool.name, args);
  });
}
await server.connect(new StdioServerTransport());
console.error(`vespera mcp: ${file} (forwarding to the editor app on :${APP_PORT} when it has this file open)`);
