import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
try {
  process.loadEnvFile(rootEnv);
} catch {
  // no .env file: rely on the real environment
}

// Tests use their own database next to the dev one, so test runs never touch dev data.
export function testDatabaseUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://ops:ops@localhost:5432/operation_agents');
  url.pathname = '/operation_agents_test';
  return url.toString();
}

// The restricted worker user (migration 005), on the test database.
export function testWorkerDatabaseUrl(): string {
  const url = new URL(process.env.WORKER_DATABASE_URL ?? 'postgres://ops_worker:ops_worker_dev@localhost:5432/operation_agents');
  url.pathname = '/operation_agents_test';
  return url.toString();
}
