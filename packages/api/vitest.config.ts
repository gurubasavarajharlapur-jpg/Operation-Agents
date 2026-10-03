import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['../../testing/globalSetup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // Files share one test database, and some tests (overview totals) check database-wide counts,
    // so run files one at a time. Tests inside a file still exercise concurrency deliberately.
    fileParallelism: false,
  },
});
