import { PgBoss } from 'pg-boss';
import { APPROVAL_DEAD_LETTER_QUEUE, APPROVAL_FINALIZE_QUEUE, INVOICE_DEAD_LETTER_QUEUE, INVOICE_QUEUE } from '@oa/shared';

// pg-boss keeps its jobs in its own "pgboss" schema in the same Postgres database,
// which is what lets us insert a case (or an approval decision) and its job in one transaction.

const RETRIES = {
  retryLimit: 3, // after 3 failed retries the job moves to the dead-letter queue (Day 2 surfaces this)
  retryBackoff: true, // exponential backoff between retries
  retryDelay: 5, // seconds before the first retry
};

/**
 * Installs the pg-boss schema and creates the queues. Run by the migrate script as the admin user,
 * so the restricted worker user never needs permission to create tables.
 */
export async function installQueues(databaseUrl: string): Promise<void> {
  const boss = new PgBoss({ connectionString: databaseUrl, supervise: false, schedule: false });
  await boss.start();
  // A dead-letter queue must exist before a queue can point at it.
  await ensureQueue(boss, INVOICE_DEAD_LETTER_QUEUE, {});
  await ensureQueue(boss, INVOICE_QUEUE, { ...RETRIES, deadLetter: INVOICE_DEAD_LETTER_QUEUE });
  await ensureQueue(boss, APPROVAL_DEAD_LETTER_QUEUE, {});
  await ensureQueue(boss, APPROVAL_FINALIZE_QUEUE, { ...RETRIES, deadLetter: APPROVAL_DEAD_LETTER_QUEUE });
  await boss.stop();
}

/**
 * Connects to the already-installed queues.
 *  - 'api':    also runs pg-boss maintenance (expiring, archiving and retrying jobs)
 *  - 'worker': no schema changes, no maintenance; just sends and works jobs
 */
export async function startQueue(databaseUrl: string, role: 'api' | 'worker' = 'api'): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    migrate: false,
    createSchema: false,
    supervise: role === 'api',
    schedule: false,
  });
  boss.on('error', (err) => console.error('pg-boss error', err));
  await boss.start();
  for (const name of [INVOICE_QUEUE, APPROVAL_FINALIZE_QUEUE]) {
    if (!(await boss.getQueue(name))) throw new Error(`queue ${name} is missing: run npm run db:migrate`);
  }
  return boss;
}

async function ensureQueue(boss: PgBoss, name: string, options: Parameters<PgBoss['createQueue']>[1]) {
  if (!(await boss.getQueue(name))) await boss.createQueue(name, options);
}
