import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { appendAuditEvent, startQueue } from '@oa/db';
import { createPool } from '../src/db.ts';
import { buildServer } from '../src/server.ts';
import { createOperator } from '../../../testing/fixtures.ts';
import { testDatabaseUrl } from '../../../testing/testDb.ts';

let pool: pg.Pool;
let boss: PgBoss;
let app: FastifyInstance;
let token: string;
let operatorId: string;

beforeAll(async () => {
  pool = createPool(testDatabaseUrl());
  boss = await startQueue(testDatabaseUrl());
  app = buildServer({ pool, boss, webhookSecret: 'unused', logger: false });
  await app.ready();
  ({ token, id: operatorId } = await createOperator(pool, 'finance_manager'));
});
afterAll(async () => {
  await app.close();
  await boss.stop();
  await pool.end();
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());

// XTS is the ISO 4217 code reserved for testing: money totals in it come only from this test.
async function makeCase(state: string, opts: { amount?: number; due?: string; outcome?: object; createdHoursAgo?: number } = {}) {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO cases (idempotency_key, payload_hash, payload, state, due_date, outcome)
     VALUES ($1, 'x', $2, $3, $4, $5) RETURNING id`,
    [`test-${crypto.randomUUID()}`, { amount: opts.amount ?? 100, currency: 'XTS' }, state, opts.due ?? null, opts.outcome ?? null],
  );
  return r.rows[0].id;
}
async function approval(caseId: string, amount: number, status: 'pending' | 'approved' | 'rejected', hoursAgo = 0) {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO approvals (case_id, proposed_action, amount, currency, status, decided_by, decided_at, created_at)
     VALUES ($1, 'pay_invoice', $2, 'XTS', $3, $4, $5, now() - make_interval(hours => $6)) RETURNING id`,
    [caseId, amount, status, status === 'pending' ? null : operatorId, status === 'pending' ? null : new Date(), hoursAgo],
  );
  return r.rows[0].id;
}
const xts = (rows: { currency: string; amount: string }[]) => Number(rows.find((r) => r.currency === 'XTS')?.amount ?? 0);

describe('GET /overview', () => {
  it('requires an operator token', async () => {
    expect((await app.inject({ method: 'GET', url: '/overview' })).statusCode).toBe(401);
  });

  it('counts exactly what was added: states, attention, categories, money per currency, Claude spend', async () => {
    const before = await get('/overview');

    // 1 waiting approval for 30h (stale) and overdue, 1 fresh waiting approval
    const stale = await makeCase('awaiting_approval', { due: '2026-01-01' });
    await approval(stale, 1000, 'pending', 30);
    const fresh = await makeCase('awaiting_approval', { due: '2999-01-01' });
    await approval(fresh, 500, 'pending', 1);
    // 1 paid: approved 2000 and paid
    const paidCase = await makeCase('completed');
    const paidApproval = await approval(paidCase, 2000, 'approved');
    await pool.query("INSERT INTO payments (approval_id, case_id, amount, currency, reference) VALUES ($1, $2, 2000, 'XTS', $3)", [paidApproval, paidCase, `SIM-${crypto.randomUUID()}`]);
    // 1 rejected by the approver, 2 escalated by the agent, 1 failed
    const rejected = await makeCase('escalated', { amount: 300, outcome: { decision: 'propose_payment', resolution: { category: 'rejected_by_approver' } } });
    await approval(rejected, 300, 'rejected');
    await makeCase('escalated', { amount: 700, outcome: { decision: 'escalate_to_human', category: 'suspicious_content' } });
    await makeCase('escalated', { amount: 50, outcome: { decision: 'escalate_to_human', category: 'suspicious_content' } });
    await makeCase('failed', { due: '2026-01-01' }); // failed: counted as failed, not overdue
    // 2 Claude calls on one case
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await appendAuditEvent(client, { caseId: fresh, actor: 'system', action: 'agent.started', input: { mode: 'llm' } });
      await appendAuditEvent(client, { caseId: fresh, actor: 'agent', action: 'llm.call', tokens: 1000, costUsd: 0.01 });
      await appendAuditEvent(client, { caseId: fresh, actor: 'agent', action: 'llm.call', tokens: 500, costUsd: 0.005 });
      await appendAuditEvent(client, { caseId: fresh, actor: 'agent', action: 'guardrail.refused.propose_payment', output: {} });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const after = await get('/overview');
    const d = (f: (o: any) => number) => f(after) - f(before);

    expect(d((o) => o.total)).toBe(7);
    expect(d((o) => o.by_state.awaiting_approval)).toBe(2);
    expect(d((o) => o.by_state.escalated)).toBe(3);
    expect(d((o) => o.by_state.failed)).toBe(1);
    expect(d((o) => o.attention.failed)).toBe(1);
    expect(d((o) => o.attention.overdue)).toBe(1); // the stale one; the failed one is not "overdue"
    expect(d((o) => o.attention.stale)).toBe(1);
    expect(d((o) => o.attention.needs_attention)).toBe(2); // failed + the stale/overdue case, counted once
    expect(d((o) => o.attention.guardrail_refusals_7d)).toBe(1);
    const cat = (o: any, c: string) => o.escalation_categories.find((x: any) => x.category === c)?.n ?? 0;
    expect(d((o) => cat(o, 'suspicious_content'))).toBe(2);
    expect(d((o) => cat(o, 'rejected_by_approver'))).toBe(1); // the approver's rejection, not the agent's category
    expect(d((o) => o.awaiting_approval.count)).toBe(2);

    expect(d((o) => xts(o.awaiting_approval.by_currency))).toBe(1500);
    expect(d((o) => xts(o.money.proposed))).toBe(3800);
    expect(d((o) => xts(o.money.approved))).toBe(2000);
    expect(d((o) => xts(o.money.paid))).toBe(2000);
    expect(d((o) => xts(o.money.rejected))).toBe(300);
    expect(d((o) => xts(o.money.blocked))).toBe(750); // the two the agent escalated; the rejected one counts as rejected, not twice
    expect(after.money.paid.every((r: any) => /^[A-Z]{3}$/.test(r.currency))).toBe(true); // grouped, never summed across

    expect(d((o) => o.claude.calls)).toBe(2);
    expect(d((o) => o.claude.tokens)).toBe(1500);
    expect(d((o) => o.claude.cost_usd)).toBeCloseTo(0.015);
    expect(d((o) => o.claude.cases_by_mode.llm)).toBe(1);
  });

  it('every number links to a matching case list: category and attention filters', async () => {
    const id = await makeCase('escalated', { outcome: { category: 'over_approval_limit' } });
    const failed = await makeCase('failed');
    const ids = (r: any) => r.cases.map((c: any) => c.id);
    expect(ids(await get('/cases?category=over_approval_limit'))).toContain(id);
    expect(ids(await get('/cases?category=po_mismatch'))).not.toContain(id);
    expect(ids(await get('/cases?attention=failed'))).toContain(failed);
    expect(ids(await get('/cases?attention=failed'))).not.toContain(id);
    expect((await app.inject({ method: 'GET', url: '/cases?attention=bogus', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(400);
  });
});
