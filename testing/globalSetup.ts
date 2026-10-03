import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { testDatabaseUrl } from './testDb.ts';

// Runs once before a package's tests: create the test database if needed, migrate and seed it.
// Migrations and seed are idempotent, so this is safe to run before every test run.
export default async function setup() {
  const adminUrl = new URL(testDatabaseUrl());
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'operation_agents_test'");
  if (exists.rowCount === 0) await admin.query('CREATE DATABASE operation_agents_test');
  await admin.end();

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const env = {
    ...process.env,
    DATABASE_URL: testDatabaseUrl(),
    WORKER_DATABASE_URL: process.env.WORKER_DATABASE_URL ?? 'postgres://ops_worker:ops_worker_dev@localhost:5432/operation_agents',
  };
  for (const script of ['packages/db/src/migrate.ts', 'packages/db/src/seed.ts']) {
    execFileSync('npx', ['tsx', script], { cwd: repoRoot, env, stdio: 'pipe' });
  }
}
