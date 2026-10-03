import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { INVOICE_QUEUE } from '@oa/shared';
import { createPool } from '../src/db.ts';
import { startQueue } from '../src/queue.ts';
import { buildServer } from '../src/server.ts';
import { signBody } from '../src/signature.ts';
import { testDatabaseUrl } from './testDb.ts';

const SECRET = 'test-secret';
let pool: pg.Pool;
let boss: PgBoss;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool(testDatabaseUrl());
  boss = await startQueue(testDatabaseUrl());
  app = buildServer({ pool, boss, webhookSecret: SECRET, logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await boss.stop();
  await pool.end();
});

const invoice = {
  invoice_number: 'INV-2026-0042',
  vendor_id: 'a1000000-0000-4000-8000-000000000001',
  po_number: 'PO-1001',
  amount: 1250.0,
  currency: 'GBP',
  issue_date: '2026-10-01',
  due_date: '2026-10-31',
  line_items: [{ description: 'Office chairs', quantity: 5, unit_price: 250.0 }],
};

// Sends a signed webhook. Every test uses a fresh idempotency key so tests never interfere.
function post(body: unknown, key: string | null, opts: { signature?: string; rawBody?: string } = {}) {
  const raw = opts.rawBody ?? JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-signature': opts.signature ?? signBody(raw, SECRET),
  };
  if (key !== null) headers['idempotency-key'] = key;
  return app.inject({ method: 'POST', url: '/webhooks/invoice', headers, payload: raw });
}

const newKey = () => `test-${crypto.randomUUID()}`;

async function countCases(key: string): Promise<number> {
  const r = await pool.query('SELECT count(*)::int AS n FROM cases WHERE idempotency_key = $1', [key]);
  return r.rows[0].n;
}

async function countJobs(caseId: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND data->>'caseId' = $2`,
    [INVOICE_QUEUE, caseId],
  );
  return r.rows[0].n;
}

describe('POST /webhooks/invoice', () => {
  it('creates a case in state "received" and enqueues exactly one job', async () => {
    const key = newKey();
    const res = await post(invoice, key);

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ state: 'received', duplicate: false });

    const row = await pool.query('SELECT state, due_date, payload FROM cases WHERE id = $1', [body.case_id]);
    expect(row.rows[0]).toMatchObject({ state: 'received', due_date: '2026-10-31', payload: invoice });
    expect(await countJobs(body.case_id)).toBe(1);

    const audit = await pool.query('SELECT actor, action FROM audit_events WHERE case_id = $1 ORDER BY id', [body.case_id]);
    expect(audit.rows).toEqual([{ actor: 'system', action: 'case.received' }]);
  });

  it('returns the existing case for a repeated key and does not re-queue it', async () => {
    const key = newKey();
    const first = (await post(invoice, key)).json();
    const second = await post(invoice, key);

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ case_id: first.case_id, state: 'received', duplicate: true });
    expect(await countCases(key)).toBe(1);
    expect(await countJobs(first.case_id)).toBe(1);

    const audit = await pool.query('SELECT action FROM audit_events WHERE case_id = $1 ORDER BY id', [first.case_id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['case.received', 'webhook.duplicate_ignored']);
  });

  it('treats the same JSON with different key order and whitespace as the same payload', async () => {
    const key = newKey();
    const first = (await post(invoice, key)).json();
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(invoice).reverse()), null, 2);
    const res = await post(null, key, { rawBody: reordered });

    expect(res.statusCode).toBe(200);
    expect(res.json().case_id).toBe(first.case_id);
  });

  it('rejects a reused key with a different payload (409) and changes nothing', async () => {
    const key = newKey();
    const first = (await post(invoice, key)).json();
    const res = await post({ ...invoice, amount: 9999 }, key);

    expect(res.statusCode).toBe(409);
    const stored = await pool.query('SELECT payload FROM cases WHERE id = $1', [first.case_id]);
    expect(stored.rows[0].payload.amount).toBe(1250);
    expect(await countJobs(first.case_id)).toBe(1);
  });

  it('creates exactly one case and one job when 10 identical requests race', async () => {
    const key = newKey();
    const results = await Promise.all(Array.from({ length: 10 }, () => post(invoice, key)));

    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 202)).toHaveLength(1);
    expect(codes.filter((c) => c === 200)).toHaveLength(9);
    expect(new Set(results.map((r) => r.json().case_id)).size).toBe(1);
    expect(await countCases(key)).toBe(1);
    expect(await countJobs(results[0].json().case_id)).toBe(1);
  });

  it('accepts an incomplete invoice (the agent flags missing fields, not the webhook)', async () => {
    const res = await post({ invoice_number: 'INV-INCOMPLETE', due_date: '2026-02-31' }, newKey());

    expect(res.statusCode).toBe(202);
    const row = await pool.query('SELECT due_date FROM cases WHERE id = $1', [res.json().case_id]);
    expect(row.rows[0].due_date).toBeNull(); // 31 February is not a real date
  });

  it('rejects a missing or wrong signature (401) without creating a case', async () => {
    const key = newKey();
    expect((await post(invoice, key, { signature: 'sha256=' + '0'.repeat(64) })).statusCode).toBe(401);
    expect((await post(invoice, key, { signature: '' })).statusCode).toBe(401);
    expect(await countCases(key)).toBe(0);
  });

  it('rejects a body that was altered after signing', async () => {
    const key = newKey();
    const signature = signBody(JSON.stringify(invoice), SECRET);
    const tampered = JSON.stringify({ ...invoice, amount: 1 });
    expect((await post(null, key, { signature, rawBody: tampered })).statusCode).toBe(401);
    expect(await countCases(key)).toBe(0);
  });

  it('rejects a missing or malformed Idempotency-Key (400)', async () => {
    expect((await post(invoice, null)).statusCode).toBe(400);
    expect((await post(invoice, 'has spaces in it')).statusCode).toBe(400);
  });

  it('rolls back the case if enqueueing the job fails (never a case without a job)', async () => {
    // A queue whose send() always throws, standing in for pg-boss being unavailable.
    const brokenBoss = { send: async () => { throw new Error('queue unavailable'); } } as unknown as PgBoss;
    const brokenApp = buildServer({ pool, boss: brokenBoss, webhookSecret: SECRET, logger: false });
    const key = newKey();
    const raw = JSON.stringify(invoice);

    const res = await brokenApp.inject({
      method: 'POST',
      url: '/webhooks/invoice',
      headers: { 'content-type': 'application/json', 'x-signature': signBody(raw, SECRET), 'idempotency-key': key },
      payload: raw,
    });
    await brokenApp.close();

    expect(res.statusCode).toBe(500);
    expect(await countCases(key)).toBe(0);
    // The sender can safely retry with the same key once the queue is back.
    const retry = await post(invoice, key);
    expect(retry.statusCode).toBe(202);
  });

  it('GET /audit/verify reports an intact chain', async () => {
    await post(invoice, newKey());
    const res = await app.inject({ method: 'GET', url: '/audit/verify' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ intact: true, head_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('rejects bodies that are not JSON objects (400)', async () => {
    expect((await post([invoice], newKey())).statusCode).toBe(400);
    expect((await post(null, newKey(), { rawBody: '{not json' })).statusCode).toBe(400);
  });
});
