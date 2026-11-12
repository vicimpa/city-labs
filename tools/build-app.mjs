// Package the MCP JavaScript and a verified portable Node runtime as a Tauri sidecar.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
import { prepareNode } from './prepare-node.mjs';
const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [path.join(root, 'tools/build-web.mjs')], { cwd: root, stdio: 'inherit' });
const triple = process.env.TAURI_ENV_TARGET_TRIPLE ?? execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
await build({ configFile: false, root, logLevel: 'warn', define: { __CITY_LABS_SIDECAR__: 'true' }, ssr: { noExternal: true, target: 'node' },
  build: { ssr: path.join(root, 'desktop/bridge.mjs'), outDir: path.join(root, 'src-tauri/resources'), emptyOutDir: false, target: 'node24', minify: false,
    rollupOptions: { external: [/^node:/], output: { format: 'cjs', entryFileNames: 'mcp.cjs', codeSplitting: false } } } });
const runtime = await prepareNode(triple);
console.log(`Desktop resources prepared for ${triple}; portable Node ${runtime.version} is bundled.`);
