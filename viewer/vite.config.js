import fs from 'node:fs';
import { defineConfig } from 'vite';

// Dev-only endpoint for the editor's "write to project" button: POST /__vspb/save stores the body as
// city/data/vespera.vspb (the previous file is kept as vespera.vspb.bak).
const WORLD = 'city/data/vespera.vspb';
const vspbSave = {
  name: 'vspb-save',
  configureServer(server) {
    server.middlewares.use('/__vspb/ping', (req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"vspb":true}'); });
    server.middlewares.use('/__vspb/save', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 204; res.end(); return; }
      const parts = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(parts);
        if (buf.subarray(0, 4).toString() !== 'VSPB') { res.statusCode = 400; res.end('not a VSPB file'); return; }
        if (fs.existsSync(WORLD)) fs.copyFileSync(WORLD, WORLD + '.bak');
        fs.writeFileSync(WORLD, buf);
        res.end(JSON.stringify({ ok: true, bytes: buf.length, path: WORLD }));
      });
    });
  },
};

export default defineConfig({ root: '.', plugins: [vspbSave], server: { port: 5199, open: '/viewer/' } });
