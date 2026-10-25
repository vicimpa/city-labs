// Development entry (`npm run app`): City Labs from the repo, served by the Vite dev server.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './main.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse((await import('node:fs')).readFileSync(path.join(root, 'package.json'), 'utf8'));
start({ mode: 'dev', root, version: pkg.version + '-dev', shell: pkg.cityLabs?.shell });
