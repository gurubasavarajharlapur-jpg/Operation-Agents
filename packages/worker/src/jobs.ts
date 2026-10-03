// The pg-boss job handlers, with failure handling made visible:
//  - every failed attempt is written to the audit trail (error, attempt n of 4, next retry),
//    then rethrown so pg-boss retries it with exponential backoff;
//  - when a job exhausts its retries, pg-boss moves it to a dead-letter queue, and the
//    dead-letter handlers mark the case 'failed' so it is never silently stuck.
import type pg from 'pg';
import { appendAuditEvent, recordAuditEvent } from '@oa/db';
import { MAX_ATTEMPTS, canTransition, retryDelaySeconds, type CaseState } from '@oa/shared';
import { finalizeApproval } from './finalizeApproval.ts';
import { processCase, type WorkerDeps } from './processCase.ts';

/** The parts of a pg-boss job the handlers use. */
export interface JobLike<T> {
  data: T;
  retryCount: number; // 0 on the first attempt
}

async function recordAttemptFailure(pool: pg.Pool, caseId: string, step: 'agent' | 'payment', retryCount: number, err: unknown) {
  const attempt = retryCount + 1;
  const retriesLeft = attempt < MAX_ATTEMPTS;
  await recordAuditEvent(pool, {
    caseId,
    actor: 'system',
    action: 'job.attempt_failed',
    input: { step, attempt, max_attempts: MAX_ATTEMPTS },
    output: {
      error: err instanceof Error ? err.message : String(err),
      next: retriesLeft ? `retry in about ${retryDelaySeconds(attempt)}s` : 'no retries left: moving to the dead-letter queue',
    },
  }).catch((auditErr) => console.error('could not record failed attempt', auditErr)); // never mask the original error
}

export async function runInvoiceJob(deps: WorkerDeps, job: JobLike<{ caseId: string }>) {
  try {
    return await processCase(deps, job.data.caseId, job.retryCount);
  } catch (err) {
    await recordAttemptFailure(deps.pool, job.data.caseId, 'agent', job.retryCount, err);
    throw err; // pg-boss schedules the retry, or dead-letters after the last attempt
  }
}

export async function runFinalizeJob(pool: pg.Pool, job: JobLike<{ approvalId: string }>) {
  try {
    return await finalizeApproval(pool, job.data.approvalId);
  } catch (err) {
    const r = await pool.query<{ case_id: string }>('SELECT case_id FROM approvals WHERE id = $1', [job.data.approvalId]);
    if (r.rows[0]) await recordAttemptFailure(pool, r.rows[0].case_id, 'payment', job.retryCount, err);
    throw err;
  }
}

/** invoice.dead: the agent step failed every attempt. */
export async function handleInvoiceDeadLetter(pool: pg.Pool, job: JobLike<{ caseId: string }>) {
  return markFailed(pool, job.data.caseId, 'agent', null);
}

/** approval.dead: the payment step failed every attempt. No payment exists (it is transactional). */
export async function handleFinalizeDeadLetter(pool: pg.Pool, job: JobLike<{ approvalId: string }>) {
  const r = await pool.query<{ case_id: string }>('SELECT case_id FROM approvals WHERE id = $1', [job.data.approvalId]);
  if (!r.rows[0]) return { status: 'skipped' as const, reason: 'approval not found' };
  return markFailed(pool, r.rows[0].case_id, 'payment', job.data.approvalId);
}

async function markFailed(pool: pg.Pool, caseId: string, step: 'agent' | 'payment', approvalId: string | null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query<{ state: CaseState }>('SELECT state FROM cases WHERE id = $1 FOR NO KEY UPDATE', [caseId]);
    const from = c.rows[0]?.state;
    // Only fail a case that is still in the step that failed: a stray dead letter must never
    // overturn a decision that was already made.
    const expected: CaseState[] = step === 'agent' ? ['received', 'validating'] : ['awaiting_approval'];
    if (!from || !expected.includes(from) || !canTransition(from, 'failed')) {
      await client.query('ROLLBACK');
      return { status: 'skipped' as const, reason: `case is ${from ?? 'missing'}` };
    }
    const last = await client.query<{ output: { error?: string } }>(
      "SELECT output FROM audit_events WHERE case_id = $1 AND action = 'job.attempt_failed' ORDER BY id DESC LIMIT 1",
      [caseId],
    );
    const lastError = last.rows[0]?.output?.error ?? 'unknown error';
    const payments = step === 'payment' ? (await client.query('SELECT 1 FROM payments WHERE case_id = $1', [caseId])).rowCount : 0;
    const outcome = {
      decision: 'failed',
      failed_step: step,
      approval_id: approvalId,
      attempts: MAX_ATTEMPTS,
      reason: `${step === 'agent' ? 'Processing' : 'The payment step'} failed after ${MAX_ATTEMPTS} attempts: ${lastError}`,
      ...(step === 'payment' ? { payment_made: Boolean(payments) } : {}),
    };
    await client.query("UPDATE cases SET state = 'failed', outcome = coalesce(outcome, '{}'::jsonb) || $1::jsonb WHERE id = $2", [outcome, caseId]);
    await appendAuditEvent(client, { caseId, actor: 'system', action: 'job.dead_lettered', input: { step, attempts: MAX_ATTEMPTS }, output: outcome });
    await appendAuditEvent(client, { caseId, actor: 'system', action: 'state.changed', input: { from, to: 'failed' }, output: { state: 'failed' } });
    await client.query('COMMIT');
    return { status: 'failed' as const, reason: outcome.reason };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
