import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./cache/vite', import.meta.url)),
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 15000,
  },
});
