import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    // AppleDouble metadata files (._*) appear on non-HFS volumes and must never be collected.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.build/**', '**/._*'],
    environment: 'node',
  },
});
