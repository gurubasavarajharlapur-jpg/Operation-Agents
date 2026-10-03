// Minimal migration runner: applies migrations/*.sql in filename order, once each.
// Each file runs in its own transaction, so a failing migration leaves nothing half-applied.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DATABASE_URL, WORKER_DATABASE_URL } from './env.ts';
import { installQueues } from './queue.ts';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const LOCK_ID = 727001; // any constant; stops two migrate runs racing each other

async function migrate() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    console.log('migrations up to date');

    await setWorkerPassword(client);
    await installQueues(DATABASE_URL);
    await grantWorkerQueueAccess(client);
    console.log('queues installed');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

// The ops_worker role is created by migration 005 without a password; set it from
// WORKER_DATABASE_URL so the password lives only in .env, never in the repo.
async function setWorkerPassword(client: pg.Client) {
  const url = new URL(WORKER_DATABASE_URL);
  if (url.username !== 'ops_worker' || !url.password) {
    console.warn('WORKER_DATABASE_URL does not use ops_worker with a password; the worker role cannot log in');
    return;
  }
  await client.query(`ALTER ROLE ops_worker PASSWORD ${client.escapeLiteral(decodeURIComponent(url.password))}`);
}

// The worker needs to read and complete jobs, nothing else in the pgboss schema.
async function grantWorkerQueueAccess(client: pg.Client) {
  await client.query(`
    GRANT USAGE ON SCHEMA pgboss TO ops_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ops_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO ops_worker;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO ops_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ops_worker;
  `);
}

migrate().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
