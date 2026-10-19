import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // FM-036: boot.test.ts spawns real servers whose drain loop is global (the
    // production call passes no archiveId). Under parallel files that server
    // drains another file's fixtures out from under it — it made FM-022's drain
    // assertion see 0. One database, one file at a time.
    fileParallelism: false,
    // these tests talk to real GoTrue + Postgres on a developer machine; the first
    // call after a cold start can exceed vitest's 5s default under load
    testTimeout: 20_000,
    hookTimeout: 60_000,
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/vitest.json' },
  },
});
