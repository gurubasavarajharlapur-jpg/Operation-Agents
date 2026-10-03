// GET /overview: the numbers on the dashboard's Overview page, all computed from the database so they
// always agree with the case list and the audit trail. Money is grouped per currency, never summed across.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { CASE_STATES } from '@oa/shared';
import { requireOperator } from '../auth.ts';

// One definition of "category" used here and by the case list filter: a rejection by an approver
// is recorded on the resolution, everything else on the agent's decision.
export const CATEGORY_SQL = `coalesce(c.outcome->'resolution'->>'category', c.outcome->>'category')`;

// "Needs attention" filters, shared with GET /cases?attention=...
export const ATTENTION_SQL = {
  failed: `c.state = 'failed'`,
  overdue: `c.due_date < current_date AND c.state NOT IN ('completed', 'failed')`,
  stale: `EXISTS (SELECT 1 FROM approvals a WHERE a.case_id = c.id AND a.status = 'pending' AND a.created_at < now() - interval '24 hours')`,
} as const;
export type Attention = keyof typeof ATTENTION_SQL;

type MoneyRow = { currency: string; amount: string };

export async function overviewRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  app.addHook('preHandler', requireOperator(deps.pool));

  app.get('/overview', async () => {
    const q = <T extends pg.QueryResultRow>(sql: string) => deps.pool.query<T>(sql).then((r) => r.rows);

    const [states, attention, categories, refusals, pending, proposed, approved, rejected, paid, blocked, llm, modes] = await Promise.all([
      q<{ state: string; n: number }>('SELECT state, count(*)::int AS n FROM cases GROUP BY state'),
      q<{ failed: number; overdue: number; stale: number; open_escalations: number }>(`
        SELECT count(*) FILTER (WHERE ${ATTENTION_SQL.failed})::int AS failed,
               count(*) FILTER (WHERE ${ATTENTION_SQL.overdue})::int AS overdue,
               count(*) FILTER (WHERE ${ATTENTION_SQL.stale})::int AS stale,
               count(*) FILTER (WHERE c.state = 'escalated')::int AS open_escalations,
               count(*) FILTER (WHERE ${ATTENTION_SQL.failed} OR ${ATTENTION_SQL.overdue} OR ${ATTENTION_SQL.stale})::int AS needs_attention
        FROM cases c`),
      q<{ category: string; n: number }>(`
        SELECT ${CATEGORY_SQL} AS category, count(*)::int AS n FROM cases c
        WHERE c.state = 'escalated' AND ${CATEGORY_SQL} IS NOT NULL
        GROUP BY 1 ORDER BY n DESC, category`),
      q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'guardrail.refused.%' AND created_at > now() - interval '7 days'`),
      q<MoneyRow & { n: number }>(`SELECT currency, sum(amount)::text AS amount, count(*)::int AS n FROM approvals WHERE status = 'pending' GROUP BY currency ORDER BY currency`),
      q<MoneyRow>(`SELECT currency, sum(amount)::text AS amount FROM approvals GROUP BY currency ORDER BY currency`),
      q<MoneyRow>(`SELECT currency, sum(amount)::text AS amount FROM approvals WHERE status = 'approved' GROUP BY currency ORDER BY currency`),
      q<MoneyRow>(`SELECT currency, sum(amount)::text AS amount FROM approvals WHERE status = 'rejected' GROUP BY currency ORDER BY currency`),
      q<MoneyRow>(`SELECT currency, sum(amount)::text AS amount FROM payments GROUP BY currency ORDER BY currency`),
      // Invoice value the AGENT escalated instead of proposing. A proposal a person later rejected
      // is counted under "rejected", not here, so nothing is counted twice.
      q<MoneyRow & { n: number }>(`
        SELECT c.payload->>'currency' AS currency, sum((c.payload->>'amount')::numeric)::text AS amount, count(*)::int AS n
        FROM cases c
        WHERE c.state = 'escalated' AND c.outcome->>'decision' = 'escalate_to_human'
          AND jsonb_typeof(c.payload->'amount') = 'number' AND c.payload->>'currency' ~ '^[A-Z]{3}$'
        GROUP BY 1 ORDER BY 1`),
      q<{ calls: number; tokens: number; cost: number }>(`
        SELECT count(*)::int AS calls, coalesce(sum(tokens), 0)::int AS tokens, coalesce(sum(cost_usd), 0)::float AS cost
        FROM audit_events WHERE action = 'llm.call'`),
      // Who decided each case: the mode on its latest agent run.
      q<{ mode: string; n: number }>(`
        SELECT run.input->>'mode' AS mode, count(*)::int AS n FROM cases c
        JOIN LATERAL (SELECT input FROM audit_events WHERE case_id = c.id AND action IN ('agent.started', 'agent.restarted') ORDER BY id DESC LIMIT 1) run ON true
        GROUP BY 1`),
    ]);

    const by_state = Object.fromEntries(CASE_STATES.map((s) => [s, 0])) as Record<string, number>;
    for (const r of states) by_state[r.state] = r.n;
    const llmCases = modes.find((m) => m.mode === 'llm')?.n ?? 0;

    return {
      total: states.reduce((t, r) => t + r.n, 0),
      by_state,
      attention: { ...attention[0], guardrail_refusals_7d: refusals[0].n },
      escalation_categories: categories,
      awaiting_approval: { count: pending.reduce((t, r) => t + r.n, 0), by_currency: pending.map(({ currency, amount }) => ({ currency, amount })) },
      money: { proposed, approved, rejected, paid, blocked: blocked.map(({ currency, amount }) => ({ currency, amount })) },
      claude: {
        calls: llm[0].calls,
        tokens: llm[0].tokens,
        cost_usd: llm[0].cost,
        cases_by_mode: { llm: llmCases, rules: modes.find((m) => m.mode === 'rules')?.n ?? 0 },
        cost_per_llm_case_usd: llmCases ? llm[0].cost / llmCases : 0,
      },
    };
  });
}
