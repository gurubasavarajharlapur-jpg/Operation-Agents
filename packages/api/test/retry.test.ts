import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { startQueue } from '@oa/db';
import { APPROVAL_FINALIZE_QUEUE, INVOICE_QUEUE } from '@oa/shared';
import { createPool } from '../src/db.ts';
import { buildServer } from '../src/server.ts';
import { signBody } from '../src/signature.ts';
import { createOperator } from '../../../testing/fixtures.ts';
import { testDatabaseUrl } from '../../../testing/testDb.ts';

let pool: pg.Pool;
let boss: PgBoss;
let app: FastifyInstance;
let plain: FastifyInstance;
let token: string;

beforeAll(async () => {
  pool = createPool(testDatabaseUrl());
  boss = await startQueue(testDatabaseUrl());
  app = buildServer({ pool, boss, webhookSecret: 's', logger: false, faultInjection: true });
  plain = buildServer({ pool, boss, webhookSecret: 's', logger: false });
  await app.ready();
  await plain.ready();
  token = (await createOperator(pool, 'operations')).token;
});
afterAll(async () => {
  await app.close();
  await plain.close();
  await boss.stop();
  await pool.end();
});

async function failedCase(outcome: Record<string, unknown>) {
  const r = await pool.query<{ id: string }>(
    "INSERT INTO cases (idempotency_key, payload_hash, payload, state, outcome) VALUES ($1, 'x', '{}', 'failed', $2) RETURNING id",
    [`test-${crypto.randomUUID()}`, outcome],
  );
  return r.rows[0].id;
}
const retry = (id: string, t: string | null = token) =>
  app.inject({ method: 'POST', url: `/cases/${id}/retry`, headers: t ? { authorization: `Bearer ${t}` } : {} });
const jobs = async (queue: string, key: string, value: string) =>
  (await pool.query(`SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND data->>'${key}' = $2`, [queue, value])).rows[0].n;

describe('POST /cases/:id/retry', () => {
  it('re-runs the agent for a case that failed in the agent step', async () => {
    const id = await failedCase({ decision: 'failed', failed_step: 'agent', reason: 'Processing failed after 4 attempts: boom' });
    const res = await retry(id);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ case_id: id, state: 'received' });
    expect((await pool.query('SELECT state, outcome FROM cases WHERE id = $1', [id])).rows[0]).toEqual({ state: 'received', outcome: null });
    expect(await jobs(INVOICE_QUEUE, 'caseId', id)).toBe(1);
    const audit = await pool.query("SELECT actor, input FROM audit_events WHERE case_id = $1 AND action = 'case.retried'", [id]);
    expect(audit.rows[0]).toMatchObject({ actor: 'human', input: { step: 'agent', previous_error: 'Processing failed after 4 attempts: boom' } });
  });

  it('re-runs only the payment step for a case whose approved payment failed', async () => {
    const approvalId = crypto.randomUUID();
    const id = await failedCase({ decision: 'failed', failed_step: 'payment', approval_id: approvalId, amount: 1250, reason: 'x' });
    const res = await retry(id);
    expect(res.json()).toEqual({ case_id: id, state: 'awaiting_approval' });
    expect(await jobs(APPROVAL_FINALIZE_QUEUE, 'approvalId', approvalId)).toBe(1);
    expect(await jobs(INVOICE_QUEUE, 'caseId', id)).toBe(0);
    expect((await pool.query('SELECT outcome FROM cases WHERE id = $1', [id])).rows[0].outcome).toEqual({ decision: 'propose_payment', approval_id: approvalId, amount: 1250 });
  });

  it('409 for a case that is not failed, 401 without a token, 404 for unknown ids', async () => {
    const r = await pool.query<{ id: string }>("INSERT INTO cases (idempotency_key, payload_hash, payload, state) VALUES ($1, 'x', '{}', 'escalated') RETURNING id", [`test-${crypto.randomUUID()}`]);
    expect((await retry(r.rows[0].id)).statusCode).toBe(409);
    expect((await retry(r.rows[0].id, null)).statusCode).toBe(401);
    expect((await retry(crypto.randomUUID())).statusCode).toBe(404);
  });
});

describe('simulated failures (demo only)', () => {
  const send = (server: FastifyInstance, failure?: string) => {
    const body = JSON.stringify({ invoice_number: `INV-${crypto.randomUUID()}` });
    return server.inject({
      method: 'POST', url: '/webhooks/invoice', payload: body,
      headers: { 'content-type': 'application/json', 'idempotency-key': `t-${crypto.randomUUID()}`, 'x-signature': signBody(body, 's'), ...(failure ? { 'x-simulate-failure': failure } : {}) },
    });
  };
  const faultFor = async (caseId: string) => (await pool.query('SELECT mode, failures_remaining FROM fault_injections WHERE case_id = $1', [caseId])).rows[0];

  it('a signed request can ask for a recoverable or permanent outage, stored with the case', async () => {
    expect(await faultFor((await send(app, 'recovers')).json().case_id)).toEqual({ mode: 'recovers', failures_remaining: 2 });
    expect(await faultFor((await send(app, 'never_recovers')).json().case_id)).toEqual({ mode: 'never_recovers', failures_remaining: 4 });
    expect(await faultFor((await send(app, 'bogus')).json().case_id)).toBeUndefined();
  });

  it('is ignored entirely unless fault injection is enabled', async () => {
    expect(await faultFor((await send(plain, 'never_recovers')).json().case_id)).toBeUndefined();
  });
});
