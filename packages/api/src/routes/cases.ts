// Read-only endpoints for the dashboard. All require an operator token: invoices are business data.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { appendAuditEvent } from '@oa/db';
import { APPROVAL_FINALIZE_QUEUE, CASE_STATES, INVOICE_QUEUE, MAX_ATTEMPTS } from '@oa/shared';
import { requireOperator } from '../auth.ts';
import { ATTENTION_SQL, CATEGORY_SQL, type Attention } from './overview.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Shared by the list and the detail view. Amount is only returned when the invoice really
// contains a number (invoices are untrusted input and may not).
const CASE_COLUMNS = `
  c.id, c.state, c.due_date, c.created_at, c.updated_at,
  c.payload->>'invoice_number' AS invoice_number,
  coalesce(v.name, c.payload->>'vendor_name') AS vendor,
  CASE WHEN jsonb_typeof(c.payload->'amount') = 'number' THEN (c.payload->>'amount')::numeric END AS amount,
  c.payload->>'currency' AS currency,
  c.payload->>'po_number' AS po_number,
  c.outcome->>'decision' AS decision,
  c.outcome->>'category' AS category,
  run.input->>'mode' AS mode,
  run.input->>'model' AS model,
  coalesce(llm.calls, 0)::int AS llm_calls,
  coalesce(llm.tokens, 0)::int AS tokens,
  coalesce(llm.cost, 0)::float AS cost_usd,
  coalesce(fails.n, 0)::int AS failed_attempts`;

const CASE_JOINS = `
  LEFT JOIN vendors v ON v.id::text = c.payload->>'vendor_id'
  LEFT JOIN LATERAL (
    SELECT input FROM audit_events
    WHERE case_id = c.id AND action IN ('agent.started', 'agent.restarted')
    ORDER BY id DESC LIMIT 1
  ) run ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS calls, sum(tokens) AS tokens, sum(cost_usd) AS cost
    FROM audit_events WHERE case_id = c.id AND action = 'llm.call'
  ) llm ON true
  LEFT JOIN LATERAL (
    -- failed attempts since the last manual retry (a retry starts a fresh set of 4 attempts)
    SELECT count(*) AS n FROM audit_events f
    WHERE f.case_id = c.id AND f.action = 'job.attempt_failed'
      AND f.id > coalesce((SELECT max(id) FROM audit_events r WHERE r.case_id = c.id AND r.action = 'case.retried'), 0)
  ) fails ON true`;

export async function caseRoutes(app: FastifyInstance, deps: { pool: pg.Pool; boss: PgBoss }) {
  app.addHook('preHandler', requireOperator(deps.pool));

  app.get('/me', async (request) => request.operator);

  app.get('/stats', async () => {
    const states = await deps.pool.query<{ state: string; n: number }>('SELECT state, count(*)::int AS n FROM cases GROUP BY state');
    const pending = await deps.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM approvals WHERE status = 'pending'");
    const by_state = Object.fromEntries(CASE_STATES.map((s) => [s, 0]));
    for (const row of states.rows) by_state[row.state] = row.n;
    return { by_state, total: states.rows.reduce((t, r) => t + r.n, 0), pending_approvals: pending.rows[0].n };
  });

  // Filters: ?state=, ?category= (escalation reason), ?attention=failed|overdue|stale. They combine.
  app.get<{ Querystring: { state?: string; category?: string; attention?: string } }>('/cases', async (request, reply) => {
    const state = request.query.state || null;
    const category = request.query.category || null;
    const attention = request.query.attention || null;
    if (state && !(CASE_STATES as readonly string[]).includes(state)) return reply.code(400).send({ error: `unknown state ${state}` });
    if (attention && !(attention in ATTENTION_SQL)) return reply.code(400).send({ error: `attention must be one of ${Object.keys(ATTENTION_SQL).join(', ')}` });
    // The attention clause comes from a fixed map above, never from the request text.
    const attentionSql = attention ? `AND ${ATTENTION_SQL[attention as Attention]}` : '';
    const r = await deps.pool.query(
      `SELECT ${CASE_COLUMNS} FROM cases c ${CASE_JOINS}
       WHERE ($1::text IS NULL OR c.state = $1)
         AND ($2::text IS NULL OR (c.state = 'escalated' AND ${CATEGORY_SQL} = $2))
         ${attentionSql}
       ORDER BY c.created_at DESC LIMIT 200`,
      [state, category],
    );
    return { cases: r.rows, max_attempts: MAX_ATTEMPTS };
  });

  // Manual retry of a failed case: re-runs the step that failed (the agent, or the payment step
  // for an approval that was already given) with a fresh set of attempts.
  app.post<{ Params: { id: string } }>('/cases/:id/retry', async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'case not found' });
    const caseId = request.params.id;
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const c = await client.query<{ state: string; outcome: Record<string, any> | null }>(
        'SELECT state, outcome FROM cases WHERE id = $1 FOR NO KEY UPDATE',
        [caseId],
      );
      if (!c.rows[0]) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'case not found' });
      }
      if (c.rows[0].state !== 'failed') {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: `only failed cases can be retried; this one is ${c.rows[0].state}` });
      }
      const outcome = c.rows[0].outcome ?? {};
      const paymentStep = outcome.failed_step === 'payment' && outcome.approval_id;
      const to = paymentStep ? 'awaiting_approval' : 'received';
      const db = { executeSql: (text: string, values?: unknown[]) => client.query(text, values) };
      const jobId = paymentStep
        ? await deps.boss.send(APPROVAL_FINALIZE_QUEUE, { approvalId: outcome.approval_id }, { singletonKey: outcome.approval_id, db })
        : await deps.boss.send(INVOICE_QUEUE, { caseId }, { singletonKey: caseId, db });
      if (!jobId) throw new Error('could not queue the retry job');

      // The failure details stay in the audit trail; the case starts the step again cleanly.
      const kept = paymentStep ? { ...outcome } : {};
      delete kept.decision; delete kept.failed_step; delete kept.reason; delete kept.attempts; delete kept.payment_made;
      if (paymentStep) kept.decision = 'propose_payment';
      await client.query('UPDATE cases SET state = $1, outcome = $2 WHERE id = $3', [to, paymentStep ? kept : null, caseId]);
      await appendAuditEvent(client, {
        caseId, actor: 'human', action: 'case.retried',
        input: { step: paymentStep ? 'payment' : 'agent', previous_error: outcome.reason ?? null },
        output: { operator: request.operator, state: to },
      });
      await appendAuditEvent(client, { caseId, actor: 'human', action: 'state.changed', input: { from: 'failed', to }, output: { state: to } });
      await client.query('COMMIT');
      return reply.code(202).send({ case_id: caseId, state: to });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.get<{ Params: { id: string } }>('/cases/:id', async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'case not found' });
    const c = await deps.pool.query(
      `SELECT ${CASE_COLUMNS}, c.payload, c.outcome, c.idempotency_key FROM cases c ${CASE_JOINS} WHERE c.id = $1`,
      [request.params.id],
    );
    if (!c.rows[0]) return reply.code(404).send({ error: 'case not found' });

    const [approvals, payments, events] = await Promise.all([
      deps.pool.query(
        `SELECT a.id, a.amount, a.currency, a.status, a.required_role, a.created_at, a.decided_at, a.decision_note,
                o.name AS decided_by
         FROM approvals a LEFT JOIN operators o ON o.id = a.decided_by
         WHERE a.case_id = $1 ORDER BY a.created_at`,
        [request.params.id],
      ),
      deps.pool.query('SELECT id, approval_id, amount, currency, reference, executed_at FROM payments WHERE case_id = $1', [request.params.id]),
      deps.pool.query(
        `SELECT id, actor, action, input, output, tokens, cost_usd::float AS cost_usd, prev_hash, hash, created_at
         FROM audit_events WHERE case_id = $1 ORDER BY id`,
        [request.params.id],
      ),
    ]);
    return { case: c.rows[0], approvals: approvals.rows, payments: payments.rows, events: events.rows };
  });
}
