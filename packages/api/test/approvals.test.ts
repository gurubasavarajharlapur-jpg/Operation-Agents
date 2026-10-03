import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { startQueue } from '@oa/db';
import { APPROVAL_FINALIZE_QUEUE } from '@oa/shared';
import { createPool } from '../src/db.ts';
import { buildServer } from '../src/server.ts';
import { createOperator } from '../../../testing/fixtures.ts';
import { testDatabaseUrl } from '../../../testing/testDb.ts';

let pool: pg.Pool;
let boss: PgBoss;
let app: FastifyInstance;
let ops: { id: string; token: string };
let finance: { id: string; token: string };

beforeAll(async () => {
  pool = createPool(testDatabaseUrl());
  boss = await startQueue(testDatabaseUrl());
  app = buildServer({ pool, boss, webhookSecret: 'unused', logger: false });
  await app.ready();
  ops = await createOperator(pool, 'operations');
  finance = await createOperator(pool, 'finance_manager');
});
afterAll(async () => {
  await app.close();
  await boss.stop();
  await pool.end();
});

async function pendingApproval(amount = 1250, requiredRole = 'operations') {
  const c = await pool.query<{ id: string }>(
    `INSERT INTO cases (idempotency_key, payload_hash, payload, state) VALUES ($1, 'x', $2, 'awaiting_approval') RETURNING id`,
    [`test-${crypto.randomUUID()}`, { invoice_number: 'INV-1', vendor_name: 'Northwind Office Supplies Ltd', amount, currency: 'GBP' }],
  );
  const a = await pool.query<{ id: string }>(
    `INSERT INTO approvals (case_id, proposed_action, amount, currency, required_role) VALUES ($1, 'pay_invoice', $2, 'GBP', $3) RETURNING id`,
    [c.rows[0].id, amount, requiredRole],
  );
  return { caseId: c.rows[0].id, approvalId: a.rows[0].id };
}

const call = (method: 'GET' | 'POST', url: string, token?: string, payload?: object) =>
  app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });

const finalizeJobs = async (approvalId: string) =>
  (await pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND data->>'approvalId' = $2", [APPROVAL_FINALIZE_QUEUE, approvalId])).rows[0].n;

describe('approval endpoints', () => {
  it('approve: records the human, audits it, and queues exactly one finalize job', async () => {
    const { caseId, approvalId } = await pendingApproval();
    const res = await call('POST', `/approvals/${approvalId}/approve`, ops.token, { note: 'Checked against delivery note.' });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ approval_id: approvalId, status: 'approved', decided_by: 'Test operations' });
    const row = (await pool.query('SELECT status, decided_by, decided_at, decision_note FROM approvals WHERE id = $1', [approvalId])).rows[0];
    expect(row).toMatchObject({ status: 'approved', decided_by: ops.id, decision_note: 'Checked against delivery note.' });
    expect(row.decided_at).toBeInstanceOf(Date);
    const audit = await pool.query("SELECT actor, action, output FROM audit_events WHERE case_id = $1", [caseId]);
    expect(audit.rows).toEqual([{ actor: 'human', action: 'approval.approved', output: expect.objectContaining({ operator: { id: ops.id, name: 'Test operations', role: 'operations' } }) }]);
    expect(await finalizeJobs(approvalId)).toBe(1);
  });

  it('reject: requires a reason', async () => {
    const { approvalId } = await pendingApproval();
    expect((await call('POST', `/approvals/${approvalId}/reject`, ops.token, {})).statusCode).toBe(400);
    expect((await call('POST', `/approvals/${approvalId}/reject`, ops.token, { reason: '   ' })).statusCode).toBe(400);
    const res = await call('POST', `/approvals/${approvalId}/reject`, ops.token, { reason: 'Duplicate of a paid invoice.' });
    expect(res.statusCode).toBe(202);
    expect(await finalizeJobs(approvalId)).toBe(1);
  });

  it('401 without a token, with a wrong token, or with a deactivated operator', async () => {
    const { approvalId } = await pendingApproval();
    const inactive = await createOperator(pool, 'finance_manager', false);
    expect((await call('POST', `/approvals/${approvalId}/approve`)).statusCode).toBe(401);
    expect((await call('POST', `/approvals/${approvalId}/approve`, 'op_wrong')).statusCode).toBe(401);
    expect((await call('POST', `/approvals/${approvalId}/approve`, inactive.token)).statusCode).toBe(401);
    expect((await call('GET', '/approvals')).statusCode).toBe(401);
  });

  it('403 when an operations user approves above 10,000; a finance manager can; anyone can reject', async () => {
    const { approvalId } = await pendingApproval(14400, 'finance_manager');
    expect((await call('POST', `/approvals/${approvalId}/approve`, ops.token)).statusCode).toBe(403);
    expect((await pool.query('SELECT status FROM approvals WHERE id = $1', [approvalId])).rows[0].status).toBe('pending');
    expect((await call('POST', `/approvals/${approvalId}/approve`, finance.token)).statusCode).toBe(202);

    const other = await pendingApproval(14400, 'finance_manager');
    expect((await call('POST', `/approvals/${other.approvalId}/reject`, ops.token, { reason: 'Looks wrong.' })).statusCode).toBe(202);
  });

  it('409 when already decided; 404 for unknown or malformed ids', async () => {
    const { approvalId } = await pendingApproval();
    await call('POST', `/approvals/${approvalId}/approve`, ops.token);
    expect((await call('POST', `/approvals/${approvalId}/approve`, ops.token)).statusCode).toBe(409);
    expect((await call('POST', `/approvals/${approvalId}/reject`, ops.token, { reason: 'too late' })).statusCode).toBe(409);
    expect((await call('POST', `/approvals/${crypto.randomUUID()}/approve`, ops.token)).statusCode).toBe(404);
    expect((await call('POST', '/approvals/not-a-uuid/approve', ops.token)).statusCode).toBe(404);
  });

  it('two approvers clicking at the same moment: exactly one wins, one job', async () => {
    const { approvalId } = await pendingApproval();
    const other = await createOperator(pool, 'operations');
    const results = await Promise.all([ops.token, other.token, finance.token].map((t) => call('POST', `/approvals/${approvalId}/approve`, t)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409, 409]);
    expect(await finalizeJobs(approvalId)).toBe(1);
  });

  it('GET /approvals lists the pending inbox', async () => {
    const { approvalId } = await pendingApproval(321.5);
    const res = await call('GET', '/approvals?status=pending', ops.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().approvals).toContainEqual(expect.objectContaining({ id: approvalId, amount: '321.50', vendor: 'Northwind Office Supplies Ltd', status: 'pending' }));
  });
});
