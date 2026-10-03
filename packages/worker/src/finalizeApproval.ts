// Handles one approval.finalize job, queued by the API when a human approves or rejects.
// This is the ONLY code that "pays" (simulated), and it pays only when, in one transaction:
//   - the approval is approved, by an active human operator
//   - the case is still awaiting approval
//   - the approved amount and currency still equal the stored invoice
// The payments table's trigger (migration 005) checks the approval again, and its UNIQUE
// approval_id makes a second payment impossible, even if this job runs twice.
import crypto from 'node:crypto';
import type pg from 'pg';
import { appendAuditEvent } from '@oa/db';
import { canTransition, type CaseState, type InvoicePayload } from '@oa/shared';

export type FinalizeResult =
  | { status: 'completed'; paymentReference: string }
  | { status: 'escalated'; reason: string }
  | { status: 'skipped'; reason: string };

export async function finalizeApproval(pool: pg.Pool, approvalId: string): Promise<FinalizeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = await client.query<{
      id: string; case_id: string; status: string; amount: string; currency: string;
      decided_by: string | null; decision_note: string | null; approver_name: string | null; approver_active: boolean | null;
    }>(
      `SELECT a.id, a.case_id, a.status, a.amount, a.currency, a.decided_by, a.decision_note,
              o.name AS approver_name, o.active AS approver_active
       FROM approvals a LEFT JOIN operators o ON o.id = a.decided_by
       WHERE a.id = $1`,
      [approvalId],
    );
    const approval = a.rows[0];
    if (!approval) throw new Error(`approval ${approvalId} not found`);

    // Lock the case (NO KEY UPDATE, see decisions.ts) so nothing else moves it meanwhile.
    const c = await client.query<{ state: CaseState; payload: InvoicePayload }>(
      'SELECT state, payload FROM cases WHERE id = $1 FOR NO KEY UPDATE',
      [approval.case_id],
    );
    const caseRow = c.rows[0];
    const caseId = approval.case_id;

    if (caseRow.state !== 'awaiting_approval') {
      // Already finished (a re-delivered job) or moved on: nothing to do, and never pay twice.
      const reason = `case is ${caseRow.state}, not awaiting_approval`;
      await appendAuditEvent(client, { caseId, actor: 'system', action: 'job.skipped', input: { approval_id: approvalId }, output: { reason } });
      await client.query('COMMIT');
      return { status: 'skipped', reason };
    }
    if (approval.status === 'pending') throw new Error(`approval ${approvalId} is still pending`); // should never be queued

    let to: CaseState;
    let resolution: Record<string, unknown>;
    let result: FinalizeResult;

    if (approval.status === 'rejected') {
      // Policy 04: a rejected proposal is escalated with the reason, never re-proposed.
      to = 'escalated';
      resolution = { type: 'rejected_by_approver', category: 'rejected_by_approver', reason: approval.decision_note, decided_by: approval.approver_name };
      result = { status: 'escalated', reason: `rejected: ${approval.decision_note}` };
    } else {
      const problem = checkApprovedPayment(approval, caseRow.payload);
      if (problem) {
        to = 'escalated';
        resolution = { type: 'payment_blocked', category: 'approval_mismatch', reason: problem };
        result = { status: 'escalated', reason: problem };
      } else {
        const reference = `SIM-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        await client.query(
          'INSERT INTO payments (approval_id, case_id, amount, currency, reference) VALUES ($1, $2, $3, $4, $5)',
          [approval.id, caseId, approval.amount, approval.currency, reference],
        );
        await appendAuditEvent(client, {
          caseId, actor: 'system', action: 'payment.executed',
          input: { approval_id: approval.id, approved_by: { id: approval.decided_by, name: approval.approver_name } },
          output: { reference, amount: approval.amount, currency: approval.currency, simulated: true },
        });
        to = 'completed';
        resolution = { type: 'paid', payment_reference: reference, amount: Number(approval.amount), currency: approval.currency, approved_by: approval.approver_name, simulated: true };
        result = { status: 'completed', paymentReference: reference };
      }
    }

    if (!canTransition(caseRow.state, to)) throw new Error(`transition ${caseRow.state} -> ${to} is not allowed`);
    await client.query("UPDATE cases SET state = $1, outcome = coalesce(outcome, '{}'::jsonb) || jsonb_build_object('resolution', $2::jsonb) WHERE id = $3", [to, resolution, caseId]);
    await appendAuditEvent(client, { caseId, actor: 'system', action: 'state.changed', input: { from: caseRow.state, to }, output: { state: to, resolution } });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Returns why an approved payment must NOT be made, or null if it may. */
function checkApprovedPayment(
  approval: { decided_by: string | null; approver_active: boolean | null; amount: string; currency: string },
  invoice: InvoicePayload,
): string | null {
  if (!approval.decided_by || approval.approver_active !== true) return 'approval was not made by an active human operator';
  if (typeof invoice.amount !== 'number' || Number(approval.amount) !== invoice.amount || approval.currency !== invoice.currency) {
    return `approved ${approval.amount} ${approval.currency} no longer matches the invoice (${invoice.amount} ${invoice.currency})`;
  }
  return null;
}
