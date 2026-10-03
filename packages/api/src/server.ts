import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { auditRoutes } from './routes/audit.ts';
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

  app.get('/health', async () => {
    await deps.pool.query('SELECT 1');
    return { status: 'ok' };
  });

  app.register(webhookRoutes, deps);
  app.register(auditRoutes, deps);
  return app;
}
