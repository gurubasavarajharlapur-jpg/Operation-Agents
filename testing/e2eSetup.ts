import pg from 'pg';
import migrateAndSeed from './globalSetup.ts';
import { testDatabaseUrl } from './testDb.ts';

// Browser tests run a real worker. The API tests deliberately create cases whose jobs are never
// processed, so clear that backlog first; otherwise the worker spends the test working through
// hundreds of stale jobs before it reaches the invoices the browser test sends. Test database only.
export default async function setup() {
  await migrateAndSeed();
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  const r = await client.query("DELETE FROM pgboss.job WHERE state IN ('created', 'retry')");
  await client.end();
  if (r.rowCount) console.log(`cleared ${r.rowCount} stale queued jobs from the test database`);
}
