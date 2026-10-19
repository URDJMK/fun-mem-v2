import { defineConfig } from 'vitest/config';

// browser tests (Playwright as a library): long timeouts, one file at a time
export default defineConfig({
  test: {
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/vitest.json' },
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
