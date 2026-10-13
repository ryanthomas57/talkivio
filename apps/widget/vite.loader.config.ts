import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** Loader bundle: dist/loader.js (IIFE, dependency-free, served at /widget/loader.js). */
export default defineConfig(({ mode }) => ({
  publicDir: false,
  define: { __WIDGET_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    // ES2020: native object spread / optional chaining, so esbuild injects no helpers above the IIFE (they would
    // become globals on the host page — scripts/check-loader.mjs guards this).
    target: 'es2020',
    minify: mode === 'development' ? false : 'esbuild',
    sourcemap: false,
    reportCompressedSize: false,
    lib: {
      entry: 'src/loader/index.ts',
      formats: ['iife'],
      name: 'TalkivioLoader',
      fileName: () => 'loader.js',
    },
  },
}));
