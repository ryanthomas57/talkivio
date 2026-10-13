import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __WIDGET_VERSION__: JSON.stringify('test') },
  test: {
    include: ['test/**/*.test.ts'],
    // AppleDouble metadata files (._*) appear on non-HFS volumes.
    exclude: ['**/node_modules/**', '**/._*'],
    environment: 'node',
  },
});
