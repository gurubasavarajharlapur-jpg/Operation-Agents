import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { verifyAuditChain } from '@oa/db';

// GET /audit/verify recomputes the whole hash chain from the stored rows and reports whether it
// is intact. head_hash is the latest hash: anchoring it somewhere external (a daily email, a
// public commit) also catches someone rebuilding the entire chain from scratch.
export async function auditRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  app.get('/audit/verify', async () => verifyAuditChain(deps.pool));
}
