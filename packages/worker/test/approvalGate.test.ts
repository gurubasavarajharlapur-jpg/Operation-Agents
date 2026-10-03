import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { verifyAuditChain } from '@oa/db';
import { finalizeApproval } from '../src/finalizeApproval.ts';
import { createOperator } from '../../../testing/fixtures.ts';
import { auditActions, createCase, createTestPool, createWorkerPool, getCase, invoice } from './helpers.ts';

let pool: pg.Pool; // admin: plays the API's part (deciding approvals) and checks results
let workerPool: pg.Pool; // ops_worker: the code under test
beforeAll(() => { pool = createTestPool(); workerPool = createWorkerPool(); });
afterAll(async () => { await pool.end(); await workerPool.end(); });

/** A case awaiting approval with a pending approval, as the agent would leave it. */
async function proposed(amount = 1250) {
  const caseId = await createCase(pool, invoice({ amount, line_items: [{ quantity: 1, unit_price: amount }] }), 'awaiting_approval');
  const a = await pool.query<{ id: string }>(
    "INSERT INTO approvals (case_id, proposed_action, amount, currency) VALUES ($1, 'pay_invoice', $2, 'GBP') RETURNING id",
    [caseId, amount],
  );
  return { caseId, approvalId: a.rows[0].id };
}

async function decide(approvalId: string, status: 'approved' | 'rejected', operatorId: string, note: string | null = null) {
  await pool.query('UPDATE approvals SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $4', [status, operatorId, note, approvalId]);
}

const paymentsFor = async (caseId: string) => (await pool.query('SELECT amount, currency, reference FROM payments WHERE case_id = $1', [caseId])).rows;

describe('finalizeApproval (approval.finalize job)', () => {
  it('pays (simulated) and completes the case after a human approval', async () => {
    const op = await createOperator(pool, 'operations');
    const { caseId, approvalId } = await proposed();
    await decide(approvalId, 'approved', op.id);

    const result = await finalizeApproval(workerPool, approvalId);

    expect(result).toMatchObject({ status: 'completed', paymentReference: expect.stringMatching(/^SIM-\d{8}-[0-9A-F]{6}$/) });
    expect(await paymentsFor(caseId)).toEqual([{ amount: '1250.00', currency: 'GBP', reference: (result as { paymentReference: string }).paymentReference }]);
    const c = await getCase(pool, caseId);
    expect(c.state).toBe('completed');
    expect(c.outcome.resolution).toMatchObject({ type: 'paid', approved_by: 'Test operations', simulated: true });
    expect(await auditActions(pool, caseId)).toEqual(['payment.executed', 'state.changed']);
  });

  it('escalates with the reason after a rejection, and pays nothing', async () => {
    const op = await createOperator(pool, 'operations');
    const { caseId, approvalId } = await proposed();
    await decide(approvalId, 'rejected', op.id, 'Vendor called: invoice was sent in error.');

    expect(await finalizeApproval(workerPool, approvalId)).toMatchObject({ status: 'escalated' });
    expect(await paymentsFor(caseId)).toEqual([]);
    expect((await getCase(pool, caseId)).outcome.resolution).toMatchObject({ category: 'rejected_by_approver', reason: 'Vendor called: invoice was sent in error.' });
  });

  it('never pays twice when the job is delivered twice, even concurrently', async () => {
    const op = await createOperator(pool, 'operations');
    const { caseId, approvalId } = await proposed();
    await decide(approvalId, 'approved', op.id);

    const results = await Promise.allSettled([1, 2, 3].map(() => finalizeApproval(workerPool, approvalId)));
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await paymentsFor(caseId)).toHaveLength(1);
    expect(results.map((r) => (r as PromiseFulfilledResult<{ status: string }>).value.status).sort()).toEqual(['completed', 'skipped', 'skipped']);
  });

  it('refuses to pay if the invoice amount no longer matches what was approved', async () => {
    const op = await createOperator(pool, 'operations');
    const { caseId, approvalId } = await proposed();
    await decide(approvalId, 'approved', op.id);
    await pool.query("UPDATE cases SET payload = jsonb_set(payload, '{amount}', '9999') WHERE id = $1", [caseId]);

    expect(await finalizeApproval(workerPool, approvalId)).toMatchObject({ status: 'escalated', reason: expect.stringMatching(/no longer matches/) });
    expect(await paymentsFor(caseId)).toEqual([]);
  });

  it('refuses to pay if the approver has since been deactivated', async () => {
    const op = await createOperator(pool, 'operations');
    const { caseId, approvalId } = await proposed();
    await decide(approvalId, 'approved', op.id);
    await pool.query('UPDATE operators SET active = false WHERE id = $1', [op.id]);

    expect(await finalizeApproval(workerPool, approvalId)).toMatchObject({ status: 'escalated' });
    expect(await paymentsFor(caseId)).toEqual([]);
    expect((await verifyAuditChain(pool)).intact).toBe(true);
  });
});

describe('safety invariant, enforced by the database itself', () => {
  it('the worker database user cannot approve anything', async () => {
    const op = await createOperator(pool, 'finance_manager');
    const { approvalId } = await proposed();
    await expect(
      workerPool.query("UPDATE approvals SET status = 'approved', decided_by = $1, decided_at = now() WHERE id = $2", [op.id, approvalId]),
    ).rejects.toThrow(/permission denied for table approvals/);
  });

  it('the worker cannot read operator token hashes', async () => {
    await expect(workerPool.query('SELECT token_hash FROM operators')).rejects.toThrow(/permission denied/);
  });

  it('a payment row for a pending approval is refused, whoever inserts it', async () => {
    const { caseId, approvalId } = await proposed();
    for (const db of [workerPool, pool]) {
      await expect(
        db.query("INSERT INTO payments (approval_id, case_id, amount, currency, reference) VALUES ($1, $2, 1250, 'GBP', $3)", [approvalId, caseId, `SIM-${Math.random()}`]),
      ).rejects.toThrow(/payment refused: approval .* is pending, not approved/);
    }
  });

  it('a payment row for a different amount than approved is refused', async () => {
    const op = await createOperator(pool, 'operations');
    const { caseId, approvalId } = await proposed();
    await decide(approvalId, 'approved', op.id);
    await expect(
      pool.query("INSERT INTO payments (approval_id, case_id, amount, currency, reference) VALUES ($1, $2, 1300, 'GBP', 'SIM-X')", [approvalId, caseId]),
    ).rejects.toThrow(/amount or currency differs/);
  });

  it('an approval cannot be marked approved without a human (CHECK constraint)', async () => {
    const { approvalId } = await proposed();
    await expect(pool.query("UPDATE approvals SET status = 'approved' WHERE id = $1", [approvalId])).rejects.toThrow(/approvals_decision_has_human/);
  });

  it('payments cannot be edited or deleted', async () => {
    await expect(pool.query("UPDATE payments SET amount = 1")).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM payments')).rejects.toThrow(/append-only/);
  });
});
