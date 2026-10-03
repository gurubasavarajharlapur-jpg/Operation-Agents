import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { PgBoss } from 'pg-boss';
import { verifyAuditChain } from '@oa/db';
import { MAX_ATTEMPTS } from '@oa/shared';
import { handleFinalizeDeadLetter, handleInvoiceDeadLetter, runFinalizeJob, runInvoiceJob } from '../src/jobs.ts';
import type { WorkerDeps } from '../src/processCase.ts';
import { createOperator } from '../../../testing/fixtures.ts';
import { testDatabaseUrl, testWorkerDatabaseUrl } from '../../../testing/testDb.ts';
import { TODAY, approvalsFor, auditActions, createCase, createTestPool, createWorkerPool, getCase, invoice } from './helpers.ts';

let pool: pg.Pool; // admin: fixtures and assertions
let workerPool: pg.Pool; // ops_worker: the code under test
beforeAll(() => { pool = createTestPool(); workerPool = createWorkerPool(); });
afterAll(async () => { await pool.end(); await workerPool.end(); });

const deps = (): WorkerDeps => ({ pool: workerPool, mode: 'rules', model: 'n/a', effort: 'medium', maxTurns: 8, today: TODAY });
const inject = (caseId: string, mode: 'recovers' | 'never_recovers', n: number) =>
  pool.query('INSERT INTO fault_injections (case_id, mode, failures_remaining) VALUES ($1, $2, $3)', [caseId, mode, n]);
const attemptEvents = async (caseId: string) =>
  (await pool.query("SELECT input, output FROM audit_events WHERE case_id = $1 AND action = 'job.attempt_failed' ORDER BY id", [caseId])).rows;

describe('retries and the dead letter (handlers called the way pg-boss calls them)', () => {
  it('an outage that recovers: two failed attempts are recorded, then the normal decision', async () => {
    const id = await createCase(pool, invoice());
    await inject(id, 'recovers', 2);

    await expect(runInvoiceJob(deps(), { data: { caseId: id }, retryCount: 0 })).rejects.toThrow('Simulated outage');
    await expect(runInvoiceJob(deps(), { data: { caseId: id }, retryCount: 1 })).rejects.toThrow('Simulated outage');
    expect((await getCase(pool, id)).state).toBe('validating'); // still in progress between attempts
    const result = await runInvoiceJob(deps(), { data: { caseId: id }, retryCount: 2 });

    expect(result).toMatchObject({ status: 'processed', state: 'awaiting_approval' });
    const attempts = await attemptEvents(id);
    expect(attempts.map((a) => a.input)).toEqual([
      { step: 'agent', attempt: 1, max_attempts: MAX_ATTEMPTS },
      { step: 'agent', attempt: 2, max_attempts: MAX_ATTEMPTS },
    ]);
    expect(attempts[0].output).toEqual({ error: 'Simulated outage: model API returned 529 overloaded', next: 'retry in about 5s' });
    expect(attempts[1].output.next).toBe('retry in about 10s');
  });

  it('an outage that never recovers: every attempt fails, the dead letter marks the case failed, nothing is proposed', async () => {
    const id = await createCase(pool, invoice());
    await inject(id, 'never_recovers', MAX_ATTEMPTS);
    for (let retryCount = 0; retryCount < MAX_ATTEMPTS; retryCount++) {
      await expect(runInvoiceJob(deps(), { data: { caseId: id }, retryCount })).rejects.toThrow('Simulated outage');
    }
    expect((await attemptEvents(id)).at(-1)!.output.next).toMatch(/no retries left/);

    const dead = await handleInvoiceDeadLetter(workerPool, { data: { caseId: id }, retryCount: 0 });

    expect(dead.status).toBe('failed');
    const c = await getCase(pool, id);
    expect(c.state).toBe('failed');
    expect(c.outcome).toMatchObject({ decision: 'failed', failed_step: 'agent', attempts: MAX_ATTEMPTS, reason: `Processing failed after ${MAX_ATTEMPTS} attempts: Simulated outage: model API returned 529 overloaded` });
    expect(await approvalsFor(pool, id)).toEqual([]);
    expect((await auditActions(pool, id)).slice(-2)).toEqual(['job.dead_lettered', 'state.changed']);
  });

  it('a dead letter never overturns a decision that was already made', async () => {
    const id = await createCase(pool, invoice(), 'escalated');
    expect(await handleInvoiceDeadLetter(workerPool, { data: { caseId: id }, retryCount: 0 })).toMatchObject({ status: 'skipped' });
    expect((await getCase(pool, id)).state).toBe('escalated');
  });

  it('the payment step: failures dead-letter to failed, and no payment is made', async () => {
    const op = await createOperator(pool, 'operations');
    const id = await createCase(pool, invoice(), 'awaiting_approval');
    const a = await pool.query<{ id: string }>(
      "INSERT INTO approvals (case_id, proposed_action, amount, currency, status, decided_by, decided_at) VALUES ($1, 'pay_invoice', 1250, 'GBP', 'approved', $2, now()) RETURNING id",
      [id, op.id],
    );
    // The real finalizer, with the connection dropping exactly when it inserts the payment.
    const brokenPool = {
      query: (...args: Parameters<pg.Pool['query']>) => (workerPool.query as (...a: unknown[]) => unknown)(...args),
      connect: async () => {
      const client = await workerPool.connect();
      const query = client.query.bind(client);
      client.query = ((text: unknown, ...rest: unknown[]) =>
        typeof text === 'string' && text.startsWith('INSERT INTO payments')
          ? Promise.reject(new Error('connection reset by peer'))
          : (query as (...a: unknown[]) => unknown)(text, ...rest)) as typeof client.query;
        client.release = ((orig) => (...a: Parameters<typeof orig>) => { client.query = query; return orig(...a); })(client.release.bind(client));
        return client;
      },
    } as unknown as pg.Pool;
    for (let retryCount = 0; retryCount < MAX_ATTEMPTS; retryCount++) {
      await expect(runFinalizeJob(brokenPool, { data: { approvalId: a.rows[0].id }, retryCount })).rejects.toThrow('connection reset');
    }
    expect((await attemptEvents(id)).map((e) => e.input.step)).toEqual(['payment', 'payment', 'payment', 'payment']);

    expect(await handleFinalizeDeadLetter(workerPool, { data: { approvalId: a.rows[0].id }, retryCount: 0 })).toMatchObject({ status: 'failed' });
    const c = await getCase(pool, id);
    expect(c.state).toBe('failed');
    expect(c.outcome).toMatchObject({ failed_step: 'payment', approval_id: a.rows[0].id, payment_made: false });
    expect((await pool.query('SELECT count(*)::int AS n FROM payments WHERE case_id = $1', [id])).rows[0].n).toBe(0);
  });
});

describe('the real pg-boss retry and dead-letter path', () => {
  it('retries with backoff, dead-letters after the last attempt, and the case ends failed', async () => {
    // A private pair of queues with a 1-second retry delay, so the real mechanism runs in seconds.
    const admin = new PgBoss({ connectionString: testDatabaseUrl(), supervise: false, schedule: false });
    await admin.start();
    const q = `test.retry.${Date.now()}`;
    await admin.createQueue(`${q}.dead`);
    await admin.createQueue(q, { retryLimit: MAX_ATTEMPTS - 1, retryDelay: 1, retryBackoff: false, deadLetter: `${q}.dead` });
    await admin.stop();
    await pool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ops_worker');

    const boss = new PgBoss({ connectionString: testWorkerDatabaseUrl(), migrate: false, createSchema: false, supervise: false, schedule: false });
    await boss.start();
    const id = await createCase(pool, invoice());
    await inject(id, 'never_recovers', MAX_ATTEMPTS);
    await boss.work<{ caseId: string }>(q, { pollingIntervalSeconds: 0.5 }, async ([job]) => runInvoiceJob(deps(), job));
    await boss.work<{ caseId: string }>(`${q}.dead`, { pollingIntervalSeconds: 0.5 }, async ([job]) => handleInvoiceDeadLetter(workerPool, job));
    await boss.send(q, { caseId: id });

    const deadline = Date.now() + 25_000;
    while ((await getCase(pool, id)).state !== 'failed' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    await boss.stop({ graceful: false });

    expect((await getCase(pool, id)).state).toBe('failed');
    expect((await attemptEvents(id)).map((a) => a.input.attempt)).toEqual([1, 2, 3, 4]);
    expect((await verifyAuditChain(pool)).intact).toBe(true);
  }, 40_000);
});
