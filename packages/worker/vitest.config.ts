import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['../../testing/globalSetup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
