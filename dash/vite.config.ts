import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// The client builds into dist/dash-ui, which `pim dashboard` serves. `npm run dashboard:dev`
// runs Vite with hot reload and proxies the API to a running `pim dashboard`.
export default defineConfig({
  root,
  build: { outDir: fileURLToPath(new URL('../dist/dash-ui', import.meta.url)), emptyOutDir: true },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:4777', changeOrigin: true } } },
});
