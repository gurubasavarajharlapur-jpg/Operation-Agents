import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { startQueue } from '@oa/db';
import { createPool } from '../src/db.ts';
import { buildServer } from '../src/server.ts';
import { testDatabaseUrl } from '../../../testing/testDb.ts';

let pool: pg.Pool;
let boss: PgBoss;
let demo: FastifyInstance;
let plain: FastifyInstance;

beforeAll(async () => {
  pool = createPool(testDatabaseUrl());
  boss = await startQueue(testDatabaseUrl());
  demo = buildServer({ pool, boss, webhookSecret: 's', logger: false, apiPrefix: '/api', demo: { enabled: true, agentMode: 'rules', invoicesPerHour: 1000, signInsPerHour: 1000 } });
  plain = buildServer({ pool, boss, webhookSecret: 's', logger: false });
  await demo.ready();
  await plain.ready();
});
afterAll(async () => {
  await demo.close();
  await plain.close();
  await boss.stop();
  await pool.end();
});

describe('public demo mode', () => {
  it('is not exposed unless DEMO_MODE is on', async () => {
    expect((await plain.inject({ method: 'GET', url: '/demo' })).statusCode).toBe(404);
    expect((await plain.inject({ method: 'POST', url: '/demo/sign-in', payload: { role: 'operations' } })).statusCode).toBe(404);
  });

  it('serves everything under /api in production', async () => {
    expect((await demo.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await demo.inject({ method: 'GET', url: '/health' })).statusCode).toBe(404);
    // every route plugin, not just /health (a bug once put them all under /api/api)
    expect((await demo.inject({ method: 'GET', url: '/api/cases' })).statusCode).toBe(401);
    expect((await demo.inject({ method: 'GET', url: '/api/audit/verify' })).statusCode).toBe(200);
    expect((await demo.inject({ method: 'POST', url: '/api/webhooks/invoice', payload: {} })).statusCode).toBe(401);
  });

  it('signs a visitor in as their own demo operator, then sends a sample invoice through the signed webhook', async () => {
    const info = (await demo.inject({ method: 'GET', url: '/api/demo' })).json();
    expect(info).toMatchObject({ enabled: true, agent_mode: 'rules' });
    expect(info.scenarios.map((s: { id: string }) => s.id)).toContain('fraud');

    const signIn = await demo.inject({ method: 'POST', url: '/api/demo/sign-in', payload: { role: 'finance_manager' } });
    expect(signIn.statusCode).toBe(200);
    const { token, operator } = signIn.json();
    expect(operator).toMatchObject({ role: 'finance_manager', name: expect.stringMatching(/^Demo finance manager [0-9a-f]{4}$/) });

    const me = await demo.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.json()).toMatchObject({ id: operator.id });

    // sending needs a signed-in operator
    expect((await demo.inject({ method: 'POST', url: '/api/demo/invoices', payload: { scenario: 'happy' } })).statusCode).toBe(401);
    const sent = await demo.inject({ method: 'POST', url: '/api/demo/invoices', headers: { authorization: `Bearer ${token}` }, payload: { scenario: 'mismatch' } });
    expect(sent.statusCode).toBe(202);
    const c = await pool.query("SELECT payload->>'po_number' AS po, state, idempotency_key FROM cases WHERE id = $1", [sent.json().case_id]);
    expect(c.rows[0]).toMatchObject({ po: 'PO-1003', state: 'received', idempotency_key: expect.stringMatching(/^demo-ui-/) });

    expect((await demo.inject({ method: 'POST', url: '/api/demo/invoices', headers: { authorization: `Bearer ${token}` }, payload: { scenario: 'nope' } })).statusCode).toBe(400);
  });

  it('enforces the hourly limits', async () => {
    const limited = buildServer({ pool, boss, webhookSecret: 's', logger: false, demo: { enabled: true, agentMode: 'rules', invoicesPerHour: 0, signInsPerHour: 0 } });
    await limited.ready();
    expect((await limited.inject({ method: 'POST', url: '/demo/sign-in', payload: { role: 'operations' } })).statusCode).toBe(429);
    const { token } = (await demo.inject({ method: 'POST', url: '/api/demo/sign-in', payload: { role: 'operations' } })).json();
    expect((await limited.inject({ method: 'POST', url: '/demo/invoices', headers: { authorization: `Bearer ${token}` }, payload: { scenario: 'happy' } })).statusCode).toBe(429);
    await limited.close();
  });
});
