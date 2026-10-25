// Start the desktop app. ELECTRON_RUN_AS_NODE (set for child processes of VS Code and other Electron
// hosts) would make Electron run app/main.mjs as plain Node, so it is dropped here.
import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
