// The whole Day 1 flow with real components: signed webhook -> queue -> agent worker (rules-only
// mode, as the restricted ops_worker user) -> human approval via the API -> finalize -> paid.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { startQueue, verifyAuditChain } from '@oa/db';
import { finalizeApproval, processCase } from '@oa/worker';
import { createPool } from '../src/db.ts';
import { buildServer } from '../src/server.ts';
import { signBody } from '../src/signature.ts';
import { createOperator } from '../../../testing/fixtures.ts';
import { testDatabaseUrl, testWorkerDatabaseUrl } from '../../../testing/testDb.ts';

let pool: pg.Pool;
let workerPool: pg.Pool;
let boss: PgBoss;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool(testDatabaseUrl());
  workerPool = new pg.Pool({ connectionString: testWorkerDatabaseUrl() });
  boss = await startQueue(testDatabaseUrl());
  app = buildServer({ pool, boss, webhookSecret: 'e2e-secret', logger: false });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await boss.stop();
  await pool.end();
  await workerPool.end();
});

describe('end to end', () => {
  it('invoice in -> agent proposes -> human approves -> simulated payment -> completed', async () => {
    const invoice = {
      invoice_number: `INV-E2E-${Date.now()}`, vendor_id: 'a1000000-0000-4000-8000-000000000001',
      vendor_name: 'Northwind Office Supplies Ltd', po_number: 'PO-1001', amount: 1250, currency: 'GBP',
      issue_date: '2026-09-20', due_date: '2026-10-20', line_items: [{ description: 'Chairs', quantity: 5, unit_price: 250 }],
    };
    const body = JSON.stringify(invoice);

    // 1. Invoice arrives
    const received = await app.inject({
      method: 'POST', url: '/webhooks/invoice', payload: body,
      headers: { 'content-type': 'application/json', 'idempotency-key': `e2e-${Date.now()}`, 'x-signature': signBody(body, 'e2e-secret') },
    });
    expect(received.statusCode).toBe(202);
    const caseId = received.json().case_id;

    // 2. The worker processes the queued job (as ops_worker)
    const processed = await processCase({ pool: workerPool, mode: 'rules', model: 'n/a', effort: 'medium', maxTurns: 8, today: '2026-10-03' }, caseId);
    expect(processed).toMatchObject({ status: 'processed', state: 'awaiting_approval' });

    // 3. A human approves it in the inbox
    const op = await createOperator(pool, 'operations');
    const inbox = await app.inject({ method: 'GET', url: '/approvals', headers: { authorization: `Bearer ${op.token}` } });
    const approval = inbox.json().approvals.find((a: { case_id: string }) => a.case_id === caseId);
    const approved = await app.inject({ method: 'POST', url: `/approvals/${approval.id}/approve`, headers: { authorization: `Bearer ${op.token}` } });
    expect(approved.statusCode).toBe(202);

    // 4. The worker finalizes: simulated payment, case completed
    expect(await finalizeApproval(workerPool, approval.id)).toMatchObject({ status: 'completed' });

    const c = (await pool.query('SELECT state FROM cases WHERE id = $1', [caseId])).rows[0];
    expect(c.state).toBe('completed');
    const trail = await pool.query('SELECT actor, action FROM audit_events WHERE case_id = $1 ORDER BY id', [caseId]);
    expect(trail.rows.map((r) => `${r.actor}:${r.action}`)).toEqual([
      'system:case.received',
      'system:state.changed', 'system:agent.started', 'system:rules.evaluated',
      'system:decision.propose_payment', 'system:state.changed',
      'human:approval.approved',
      'system:payment.executed', 'system:state.changed',
    ]);
    expect((await verifyAuditChain(pool)).intact).toBe(true);
  });
});
