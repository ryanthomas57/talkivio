import { defineConfig } from 'vite';

/**
 * Demo storefront (pnpm --filter @talkivio/widget exec vite --config vite.demo.config.ts).
 * Pages embed the real snippet pointing at the API (http://localhost:4000/widget/loader.js).
 */
export default defineConfig({
  root: 'demo',
  publicDir: 'public',
  appType: 'mpa',
  server: { port: 5173, host: 'localhost' },
});
