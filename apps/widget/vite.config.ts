import { readFileSync } from 'node:fs';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * Frame bundle: dist/frame/frame.js + dist/frame/frame.css (fixed names, single ES module,
 * served by the API at /widget/frame/*). The loader is built by vite.loader.config.ts.
 */
export default defineConfig(({ mode }) => ({
  plugins: [preact({ devToolsEnabled: false, prefreshEnabled: false, reactAliasesEnabled: false })],
  base: '/widget/',
  publicDir: false,
  define: { __WIDGET_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2019',
    cssTarget: ['chrome90', 'safari14', 'firefox90', 'edge90'],
    minify: mode === 'development' ? false : 'esbuild',
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: 'src/frame/main.tsx',
      output: {
        format: 'es',
        entryFileNames: 'frame/frame.js',
        assetFileNames: (info) => ((info.names?.[0] ?? info.name ?? '').endsWith('.css') ? 'frame/frame.css' : 'frame/[name][extname]'),
        inlineDynamicImports: true,
      },
    },
  },
}));
