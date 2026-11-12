import { spawn } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
const child = spawn(process.execPath, [cli, 'dev', '--', ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, CITY_LABS_NODE: process.execPath, CITY_LABS_ROOT: root },
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
