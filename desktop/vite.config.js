import { defineConfig } from 'vite';
// Desktop never enables the browser development endpoint that overwrites the sample.
export default defineConfig({ root: '.', clearScreen: false, server: { host: 'localhost', port: 5199, strictPort: true, open: false }, build: { target: 'esnext' } });
