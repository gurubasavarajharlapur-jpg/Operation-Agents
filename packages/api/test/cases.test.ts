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

beforeAll(async () => {
  pool = createPool(testDatabaseUrl());
  boss = await startQueue(testDatabaseUrl());
  app = buildServer({ pool, boss, webhookSecret: 'unused', logger: false });
  await app.ready();
  token = (await createOperator(pool, 'finance_manager')).token;
});
afterAll(async () => {
  await app.close();
  await boss.stop();
  await pool.end();
});

const get = (url: string, t: string | null = token) => app.inject({ method: 'GET', url, headers: t ? { authorization: `Bearer ${t}` } : {} });

async function caseWithHistory() {
  const c = await pool.query<{ id: string }>(
    `INSERT INTO cases (idempotency_key, payload_hash, payload, state, due_date, outcome)
     VALUES ($1, 'x', $2, 'escalated', '2026-10-20', '{"decision":"escalate_to_human","category":"po_mismatch"}') RETURNING id`,
    [`test-${crypto.randomUUID()}`, { invoice_number: 'INV-DASH', vendor_id: 'a1000000-0000-4000-8000-000000000002', amount: 3950, currency: 'GBP', po_number: 'PO-1003' }],
  );
  const id = c.rows[0].id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await appendAuditEvent(client, { caseId: id, actor: 'system', action: 'agent.started', input: { mode: 'llm', model: 'claude-opus-5-5' } });
    await appendAuditEvent(client, { caseId: id, actor: 'agent', action: 'llm.call', tokens: 1200, costUsd: 0.008 });
    await appendAuditEvent(client, { caseId: id, actor: 'agent', action: 'llm.call', tokens: 800, costUsd: 0.004 });
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  return id;
}

describe('dashboard read endpoints', () => {
  it('all require an operator token', async () => {
    for (const url of ['/me', '/stats', '/cases', `/cases/${crypto.randomUUID()}`]) {
      expect((await get(url, null)).statusCode).toBe(401);
    }
  });

  it('GET /me returns the signed-in operator', async () => {
    expect((await get('/me')).json()).toMatchObject({ name: 'Test finance_manager', role: 'finance_manager' });
  });

  it('GET /cases lists cases with vendor name, mode, model and Claude cost totals', async () => {
    const id = await caseWithHistory();
    const row = (await get('/cases?state=escalated')).json().cases.find((c: { id: string }) => c.id === id);
    expect(row).toMatchObject({
      invoice_number: 'INV-DASH', vendor: 'Brightline Cloud Hosting', amount: '3950', currency: 'GBP',
      state: 'escalated', due_date: '2026-10-20', category: 'po_mismatch',
      mode: 'llm', model: 'claude-opus-5-5', llm_calls: 2, tokens: 2000,
    });
    expect(row.cost_usd).toBeCloseTo(0.012);
    expect((await get('/cases?state=bogus')).statusCode).toBe(400);
  });

  it('GET /cases/:id returns the case with its full audit timeline in order', async () => {
    const id = await caseWithHistory();
    const body = (await get(`/cases/${id}`)).json();
    expect(body.case).toMatchObject({ id, payload: expect.objectContaining({ po_number: 'PO-1003' }) });
    expect(body.events.map((e: { action: string }) => e.action)).toEqual(['agent.started', 'llm.call', 'llm.call']);
    expect(body.events[1].prev_hash).toBe(body.events[0].hash);
    expect(body.approvals).toEqual([]);
    expect(body.payments).toEqual([]);
  });

  it('GET /cases/:id is 404 for unknown and malformed ids', async () => {
    expect((await get(`/cases/${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect((await get('/cases/nope')).statusCode).toBe(404);
  });

  it('GET /stats counts cases per state', async () => {
    const body = (await get('/stats')).json();
    expect(body.by_state).toHaveProperty('awaiting_approval');
    expect(body.total).toBeGreaterThan(0);
    expect(typeof body.pending_approvals).toBe('number');
  });
});
