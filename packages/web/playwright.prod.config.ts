import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { testDatabaseUrl, testWorkerDatabaseUrl } from '../../testing/testDb.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Runs the production build exactly as deployed (npm run start:prod: migrate, seed, then one
// process serving API + worker + dashboard) in public demo mode, against the test database.
export default defineConfig({
  testDir: './e2e-prod',
  globalSetup: '../../testing/e2eSetup.ts',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: 'http://localhost:3300', viewport: { width: 1360, height: 900 } },
  webServer: {
    command: 'npm run build && npm run start:prod',
    cwd: repoRoot,
    url: 'http://localhost:3300/api/health',
    timeout: 180_000,
    env: {
      DATABASE_URL: testDatabaseUrl(),
      // the production way of configuring the worker user: one generated password
      WORKER_DB_PASSWORD: decodeURIComponent(new URL(testWorkerDatabaseUrl()).password),
      WEBHOOK_SECRET: 'prod-e2e-secret',
      DEMO_MODE: 'true',
      ENABLE_FAULT_INJECTION: 'true',
      AGENT_MODE: 'rules',
      PORT: '3300',
      NODE_ENV: 'production',
    },
    reuseExistingServer: false,
  },
});
