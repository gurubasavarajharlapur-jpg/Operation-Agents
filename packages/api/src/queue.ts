import { PgBoss } from 'pg-boss';
import { INVOICE_DEAD_LETTER_QUEUE, INVOICE_QUEUE } from '@oa/shared';

// pg-boss keeps its jobs in its own "pgboss" schema in the same Postgres database,
// which is what lets us insert a case and its job in one transaction.
export async function startQueue(databaseUrl: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: databaseUrl });
  boss.on('error', (err) => console.error('pg-boss error', err));
  await boss.start();

  // The dead-letter queue must exist before a queue can point at it.
  await ensureQueue(boss, INVOICE_DEAD_LETTER_QUEUE, {});
  await ensureQueue(boss, INVOICE_QUEUE, {
    retryLimit: 3, // after 3 failed retries the job moves to the dead-letter queue (Day 2 surfaces this)
    retryBackoff: true, // exponential backoff between retries
    retryDelay: 5, // seconds before the first retry
    deadLetter: INVOICE_DEAD_LETTER_QUEUE,
  });
  return boss;
}

async function ensureQueue(boss: PgBoss, name: string, options: Parameters<PgBoss['createQueue']>[1]) {
  if (!(await boss.getQueue(name))) await boss.createQueue(name, options);
}
