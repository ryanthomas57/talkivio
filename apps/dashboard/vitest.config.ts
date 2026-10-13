import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Same `@/` alias as tsconfig.json, so stores and libraries can be tested directly.
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    // AppleDouble metadata files (._*) appear on non-HFS volumes and must never be collected.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.build/**', '**/._*'],
    environment: 'node',
  },
});
