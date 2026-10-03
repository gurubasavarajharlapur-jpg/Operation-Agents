import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { approvalRoutes } from './routes/approvals.ts';
import { auditRoutes } from './routes/audit.ts';
import { caseRoutes } from './routes/cases.ts';
import { demoRoutes, type DemoOptions } from './routes/demo.ts';
import { webhookRoutes } from './routes/webhooks.ts';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string; // the exact bytes received, needed to verify the HMAC signature
  }
}

export interface ServerDeps {
  pool: pg.Pool;
  boss: PgBoss;
  webhookSecret: string;
  logger?: boolean;
  // '' in development (Vite strips /api); '/api' in production, next to the dashboard. Not called
  // "prefix": these deps are passed as plugin options, and Fastify reads a "prefix" option as a route prefix.
  apiPrefix?: string;
  demo?: DemoOptions;
  faultInjection?: boolean; // demo only: lets signed webhook requests simulate worker failures
}

// Builds the app without starting it, so tests can call it with app.inject() and their own database.
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true, bodyLimit: 1024 * 1024 });

  // Keep the raw body for signature checks, then parse it as JSON ourselves.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error('body is not valid JSON'), { statusCode: 400 }), undefined);
    }
  });

  const prefix = deps.apiPrefix ?? '';
  app.register(
    async (api) => {
      api.get('/health', async () => {
        await deps.pool.query('SELECT 1');
        return { status: 'ok' };
      });
      api.register(webhookRoutes, deps);
      api.register(auditRoutes, deps);
      api.register(approvalRoutes, deps); // all routes in these two plugins require an operator token
      api.register(caseRoutes, deps);
      if (deps.demo?.enabled) api.register(demoRoutes, { ...deps, demo: deps.demo, apiPrefix: prefix });
    },
    { prefix },
  );
  return app;
}
