import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { testDatabaseUrl } from './testDb.ts';

// Runs once before all tests: create the test database if needed and apply migrations to it.
export default async function setup() {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'operation_agents_test'");
  if (exists.rowCount === 0) await admin.query('CREATE DATABASE operation_agents_test');
  await admin.end();

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  execFileSync('npx', ['tsx', 'packages/db/src/migrate.ts'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'inherit',
  });
}
