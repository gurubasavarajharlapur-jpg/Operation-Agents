// Public demo helpers (only registered when DEMO_MODE=true): one-click sign-in as a demo operator,
// and a way to send sample invoices from the dashboard. Payments are simulated either way.
// Global rate limits are counted in the database, so they hold across restarts.
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { hashOperatorToken, newOperatorToken } from '@oa/db';
import { requireOperator } from '../auth.ts';
import { signBody } from '../signature.ts';
import { SCENARIOS } from '../demo/scenarios.ts';

export interface DemoOptions {
  enabled: boolean;
  agentMode: 'llm' | 'rules';
  invoicesPerHour: number;
  signInsPerHour: number;
}

export async function demoRoutes(app: FastifyInstance, deps: { pool: pg.Pool; webhookSecret: string; demo: DemoOptions; apiPrefix: string }) {
  const { demo, pool } = deps;

  app.get('/demo', async () => ({
    enabled: true,
    agent_mode: demo.agentMode,
    scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label, expect: s.expect })),
    limits: { invoices_per_hour: demo.invoicesPerHour },
  }));

  // Each visitor gets their own demo operator, so approvals in the audit trail say who clicked.
  app.post<{ Body: { role?: string } }>('/demo/sign-in', async (request, reply) => {
    const role = request.body?.role;
    if (role !== 'operations' && role !== 'finance_manager') return reply.code(400).send({ error: 'role must be operations or finance_manager' });
    const recent = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM operators WHERE email LIKE 'demo-%' AND created_at > now() - interval '1 hour'");
    if (recent.rows[0].n >= demo.signInsPerHour) return reply.code(429).send({ error: 'Too many demo sign-ins this hour. Please try again later.' });

    const token = newOperatorToken();
    const suffix = crypto.randomBytes(2).toString('hex');
    const name = `Demo ${role === 'finance_manager' ? 'finance manager' : 'operator'} ${suffix}`;
    const r = await pool.query<{ id: string }>(
      'INSERT INTO operators (name, email, role, token_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, `demo-${suffix}-${crypto.randomUUID()}@demo.invalid`, role, hashOperatorToken(token)],
    );
    return { token, operator: { id: r.rows[0].id, name, role } };
  });

  // Sends a sample invoice through the real, signed webhook: the same path a real invoice takes.
  app.post<{ Body: { scenario?: string } }>('/demo/invoices', { preHandler: requireOperator(pool) }, async (request, reply) => {
    const scenario = SCENARIOS[request.body?.scenario ?? ''];
    if (!scenario) return reply.code(400).send({ error: `scenario must be one of: ${Object.keys(SCENARIOS).join(', ')}` });
    const recent = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM cases WHERE idempotency_key LIKE 'demo-ui-%' AND created_at > now() - interval '1 hour'");
    if (recent.rows[0].n >= demo.invoicesPerHour) return reply.code(429).send({ error: `Demo limit reached (${demo.invoicesPerHour} invoices per hour). Please try again later.` });

    const body = JSON.stringify(scenario.invoice());
    const res = await app.inject({
      method: 'POST',
      url: `${deps.apiPrefix}/webhooks/invoice`,
      headers: { 'content-type': 'application/json', 'idempotency-key': `demo-ui-${crypto.randomUUID()}`, 'x-signature': signBody(body, deps.webhookSecret) },
      payload: body,
    });
    return reply.code(res.statusCode).send(res.json());
  });
}
