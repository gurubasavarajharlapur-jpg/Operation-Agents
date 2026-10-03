// Read-only endpoints for the dashboard. All require an operator token: invoices are business data.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { CASE_STATES } from '@oa/shared';
import { requireOperator } from '../auth.ts';

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
  coalesce(llm.cost, 0)::float AS cost_usd`;

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
  ) llm ON true`;

export async function caseRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  app.addHook('preHandler', requireOperator(deps.pool));

  app.get('/me', async (request) => request.operator);

  app.get('/stats', async () => {
    const states = await deps.pool.query<{ state: string; n: number }>('SELECT state, count(*)::int AS n FROM cases GROUP BY state');
    const pending = await deps.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM approvals WHERE status = 'pending'");
    const by_state = Object.fromEntries(CASE_STATES.map((s) => [s, 0]));
    for (const row of states.rows) by_state[row.state] = row.n;
    return { by_state, total: states.rows.reduce((t, r) => t + r.n, 0), pending_approvals: pending.rows[0].n };
  });

  app.get<{ Querystring: { state?: string } }>('/cases', async (request, reply) => {
    const state = request.query.state || null;
    if (state && !(CASE_STATES as readonly string[]).includes(state)) return reply.code(400).send({ error: `unknown state ${state}` });
    const r = await deps.pool.query(
      `SELECT ${CASE_COLUMNS} FROM cases c ${CASE_JOINS}
       WHERE ($1::text IS NULL OR c.state = $1)
       ORDER BY c.created_at DESC LIMIT 200`,
      [state],
    );
    return { cases: r.rows };
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
