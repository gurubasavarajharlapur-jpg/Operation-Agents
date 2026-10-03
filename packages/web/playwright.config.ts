import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { testDatabaseUrl } from '../../testing/testDb.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Browser tests run the real API and dashboard against the test database, on their own ports
// so they never collide with a dev server. The worker is started by the test itself.
export const E2E = { apiPort: 3100, webPort: 5174, webhookSecret: 'e2e-secret' };

export default defineConfig({
  testDir: './e2e',
  globalSetup: '../../testing/e2eSetup.ts',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: `http://localhost:${E2E.webPort}`, viewport: { width: 1360, height: 900 } },
  webServer: [
    {
      command: 'npm run start -w @oa/api',
      cwd: repoRoot,
      url: `http://localhost:${E2E.apiPort}/health`,
      env: { DATABASE_URL: testDatabaseUrl(), API_PORT: String(E2E.apiPort), WEBHOOK_SECRET: E2E.webhookSecret },
      reuseExistingServer: false,
    },
    {
      command: `npx vite --port ${E2E.webPort} --strictPort`,
      url: `http://localhost:${E2E.webPort}`,
      env: { API_PORT: String(E2E.apiPort) },
      reuseExistingServer: false,
    },
  ],
});
