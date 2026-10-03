import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { verifyAuditChain } from '@oa/db';
import { processCase, type WorkerDeps } from '../src/processCase.ts';
import { TODAY, approvalsFor, auditActions, createCase, createTestPool, createWorkerPool, getCase, invoice, reply, scriptedClaude, toolUse } from './helpers.ts';

let pool: pg.Pool; // admin: fixtures and assertions
let workerPool: pg.Pool; // ops_worker: the code under test
beforeAll(() => { pool = createTestPool(); workerPool = createWorkerPool(); });
afterAll(async () => { await pool.end(); await workerPool.end(); });

const deps = (overrides: Partial<WorkerDeps> = {}): WorkerDeps => ({
  pool: workerPool, mode: 'rules', model: 'claude-opus-5-5', effort: 'medium', maxTurns: 8, today: TODAY, ...overrides,
});

describe('processCase (one pg-boss job)', () => {
  it('moves received -> validating -> decision, and records which mode decided', async () => {
    const id = await createCase(pool, invoice());
    const result = await processCase(deps(), id);
    expect(result).toMatchObject({ status: 'processed', state: 'awaiting_approval' });
    expect(await auditActions(pool, id)).toEqual(['state.changed', 'agent.started', 'rules.evaluated', 'decision.propose_payment', 'state.changed']);
  });

  it('is a no-op when the same job is delivered twice (at-least-once delivery)', async () => {
    const id = await createCase(pool, invoice());
    await processCase(deps(), id);
    const again = await processCase(deps(), id, 1);
    expect(again).toEqual({ status: 'skipped', state: 'awaiting_approval' });
    expect(await approvalsFor(pool, id)).toHaveLength(1);
  });

  it('leaves the case in validating when the LLM call fails, so the pg-boss retry starts over cleanly', async () => {
    const id = await createCase(pool, invoice());
    const failing = { createMessage: async () => { throw new Error('529 overloaded'); } };
    await expect(processCase(deps({ mode: 'llm', ...failing }), id)).rejects.toThrow('529 overloaded');
    expect((await getCase(pool, id)).state).toBe('validating');

    // the retry: Claude is back
    const claude = scriptedClaude([reply([toolUse('propose_payment', { summary: 'ok', policy_refs: [] })])]);
    const retry = await processCase(deps({ mode: 'llm', createMessage: claude.createMessage }), id, 1);
    expect(retry).toMatchObject({ status: 'processed', state: 'awaiting_approval' });
    expect(await auditActions(pool, id)).toContain('agent.restarted');
    expect(await approvalsFor(pool, id)).toHaveLength(1);
  });

  it('never lets two workers decide the same case', async () => {
    const id = await createCase(pool, invoice());
    await Promise.allSettled([processCase(deps(), id), processCase(deps(), id)]);
    expect(await approvalsFor(pool, id)).toHaveLength(1);
  });

  it('survives 10 cases each delivered 3 times concurrently: no deadlock, one decision each, chain intact', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => createCase(pool, invoice())));
    const runs = ids.flatMap((id) => [0, 1, 2].map((attempt) => processCase(deps(), id, attempt)));
    const results = await Promise.allSettled(runs);

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    for (const id of ids) {
      expect((await getCase(pool, id)).state).toBe('awaiting_approval');
      expect(await approvalsFor(pool, id)).toHaveLength(1);
    }
    expect((await verifyAuditChain(pool)).intact).toBe(true);
  });
});

describe('daily Claude budget (public demo safety net)', () => {
  it('falls back to rules-only once today\'s Claude spend reaches the budget', async () => {
    // Record some Claude spend for today
    const spendCase = await createCase(pool, invoice(), 'escalated');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { appendAuditEvent } = await import('@oa/db');
      await appendAuditEvent(client, { caseId: spendCase, actor: 'agent', action: 'llm.call', tokens: 1, costUsd: 0.5 });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const id = await createCase(pool, invoice());
    const claude = { createMessage: async () => { throw new Error('Claude must not be called over budget'); } };
    const result = await processCase(deps({ mode: 'llm', ...claude, dailyLlmBudgetUsd: 0.25 }), id);

    expect(result).toMatchObject({ status: 'processed', state: 'awaiting_approval', costUsd: 0 });
    const started = await pool.query("SELECT input FROM audit_events WHERE case_id = $1 AND action = 'agent.started'", [id]);
    expect(started.rows[0].input).toMatchObject({ mode: 'rules', reason: 'daily Claude budget reached' });
  });
});
