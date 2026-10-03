import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAuditEvent, verifyAuditChain } from '@oa/db';
import { createPool } from '../src/db.ts';
import { testDatabaseUrl } from '../../../testing/testDb.ts';
import type pg from 'pg';

let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(testDatabaseUrl());
});
afterAll(async () => {
  await pool.end();
});

async function inTransaction(fn: (c: pg.PoolClient) => Promise<void>, commit = true) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
  } finally {
    client.release();
  }
}

describe('audit hash chain', () => {
  it('links each event to the previous one and verifies as intact', async () => {
    // One transaction: the chain lock is held throughout, so no event from a test running in
    // parallel can land between these two and the link can be checked exactly.
    let first = '';
    let second = '';
    await inTransaction(async (c) => {
      first = (await appendAuditEvent(c, { caseId: null, actor: 'system', action: 'test.one', input: { a: 1, nested: { z: 1, y: [1, 2] } } })).hash;
      second = (await appendAuditEvent(c, { caseId: null, actor: 'agent', action: 'test.two', output: { ok: true }, tokens: 1234, costUsd: 0.0123456 })).hash;
    });

    const row = await pool.query('SELECT prev_hash FROM audit_events WHERE hash = $1', [second]);
    expect(row.rows[0].prev_hash).toBe(first);
    const result = await verifyAuditChain(pool);
    expect(result.intact).toBe(true);
    expect(result.events_checked).toBeGreaterThanOrEqual(2);
  });

  it('keeps the chain linear when many writers append at the same time', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        inTransaction(async (c) => {
          await appendAuditEvent(c, { caseId: null, actor: 'system', action: 'test.concurrent', input: { i } });
        }),
      ),
    );
    expect((await verifyAuditChain(pool)).intact).toBe(true);
  });

  it('rejects UPDATE and DELETE at the database level', async () => {
    await expect(pool.query("UPDATE audit_events SET action = 'tampered'")).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
  });

  it('detects tampering by someone who bypasses the trigger (e.g. a superuser)', async () => {
    // Done inside a rolled-back transaction so the test database is left untouched.
    await inTransaction(async (c) => {
      await c.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete');
      const target = await c.query("SELECT id FROM audit_events WHERE action = 'test.two' ORDER BY id DESC LIMIT 1");
      await c.query("UPDATE audit_events SET output = '{\"ok\": false}' WHERE id = $1", [target.rows[0].id]);

      const result = await verifyAuditChain(c);
      expect(result.intact).toBe(false);
      expect(result.broken_at).toMatchObject({ id: target.rows[0].id, reason: expect.stringMatching(/modified/) });
    }, false);

    expect((await verifyAuditChain(pool)).intact).toBe(true); // rolled back
  });

  it('detects a deleted event in the middle of the chain', async () => {
    await inTransaction(async (c) => {
      await c.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete');
      const middle = await c.query("SELECT id FROM audit_events WHERE action = 'test.concurrent' ORDER BY id LIMIT 1 OFFSET 5");
      await c.query('DELETE FROM audit_events WHERE id = $1', [middle.rows[0].id]);

      const result = await verifyAuditChain(c);
      expect(result.intact).toBe(false);
      expect(result.broken_at?.reason).toMatch(/removed or reordered/);
    }, false);
  });
});
