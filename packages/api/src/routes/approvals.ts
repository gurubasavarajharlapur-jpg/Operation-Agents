// The human side of the approval gate. These are the ONLY endpoints that can decide an approval,
// they need an operator token, and the worker's database user cannot do this at all.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { appendAuditEvent } from '@oa/db';
import { APPROVAL_FINALIZE_QUEUE } from '@oa/shared';
import { requireOperator, type Operator } from '../auth.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function approvalRoutes(app: FastifyInstance, deps: { pool: pg.Pool; boss: PgBoss }) {
  app.addHook('preHandler', requireOperator(deps.pool));

  // The approvals inbox.
  app.get<{ Querystring: { status?: string } }>('/approvals', async (request, reply) => {
    const status = request.query.status ?? 'pending';
    if (!['pending', 'approved', 'rejected'].includes(status)) return reply.code(400).send({ error: 'status must be pending, approved or rejected' });
    const r = await deps.pool.query(
      `SELECT a.id, a.case_id, a.amount, a.currency, a.required_role, a.status, a.created_at,
              a.decided_at, o.name AS decided_by, a.decision_note,
              c.payload->>'invoice_number' AS invoice_number,
              coalesce(v.name, c.payload->>'vendor_name') AS vendor,
              c.payload->>'po_number' AS po_number, c.due_date,
              c.outcome->>'summary' AS agent_summary, c.outcome->'flags' AS flags,
              c.outcome->>'decided_by_mode' AS proposed_by_mode
       FROM approvals a
       JOIN cases c ON c.id = a.case_id
       LEFT JOIN vendors v ON v.id::text = c.payload->>'vendor_id'
       LEFT JOIN operators o ON o.id = a.decided_by
       WHERE a.status = $1
       ORDER BY c.due_date NULLS LAST, a.created_at`,
      [status],
    );
    return { approvals: r.rows };
  });

  app.post<{ Params: { id: string }; Body: { note?: unknown } | undefined }>('/approvals/:id/approve', async (request, reply) => {
    const note = request.body?.note;
    if (note !== undefined && (typeof note !== 'string' || note.length > 2000)) return reply.code(400).send({ error: 'note must be a string of at most 2000 characters' });
    return decide(request.params.id, request.operator!, 'approved', note ?? null, reply);
  });

  app.post<{ Params: { id: string }; Body: { reason?: unknown } | undefined }>('/approvals/:id/reject', async (request, reply) => {
    const reason = request.body?.reason;
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) {
      return reply.code(400).send({ error: 'reason is required (1-2000 characters): the agent and the audit trail need to know why' });
    }
    return decide(request.params.id, request.operator!, 'rejected', reason.trim(), reply);
  });

  async function decide(approvalId: string, operator: Operator, status: 'approved' | 'rejected', note: string | null, reply: import('fastify').FastifyReply) {
    if (!UUID.test(approvalId)) return reply.code(404).send({ error: 'approval not found' });

    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      // Row lock: two people clicking at the same moment are serialised; the second sees "already decided".
      const r = await client.query<{ id: string; case_id: string; status: string; required_role: string; amount: string; currency: string }>(
        'SELECT id, case_id, status, required_role, amount, currency FROM approvals WHERE id = $1 FOR NO KEY UPDATE',
        [approvalId],
      );
      const approval = r.rows[0];
      if (!approval) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'approval not found' });
      }
      if (approval.status !== 'pending') {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: `approval is already ${approval.status}`, status: approval.status });
      }
      // Policy 04: above 10,000 only a finance manager may approve. Anyone may reject (stopping a payment is always allowed).
      if (status === 'approved' && approval.required_role === 'finance_manager' && operator.role !== 'finance_manager') {
        await client.query('ROLLBACK');
        return reply.code(403).send({ error: 'this payment requires approval by a finance manager (policy 04)' });
      }

      await client.query(
        'UPDATE approvals SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $4',
        [status, operator.id, note, approvalId],
      );
      await appendAuditEvent(client, {
        caseId: approval.case_id,
        actor: 'human',
        action: `approval.${status}`,
        input: { approval_id: approvalId, note },
        output: { operator: { id: operator.id, name: operator.name, role: operator.role }, amount: approval.amount, currency: approval.currency },
      });
      // The worker finishes the case. Queued in this transaction, so a decision always has its job.
      await deps.boss.send(APPROVAL_FINALIZE_QUEUE, { approvalId }, {
        singletonKey: approvalId,
        db: { executeSql: (text, values) => client.query(text, values) },
      });
      await client.query('COMMIT');
      return reply.code(202).send({ approval_id: approvalId, case_id: approval.case_id, status, decided_by: operator.name });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
