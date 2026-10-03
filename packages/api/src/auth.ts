import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { hashOperatorToken } from '@oa/db';

export interface Operator {
  id: string;
  name: string;
  role: 'operations' | 'finance_manager';
}

declare module 'fastify' {
  interface FastifyRequest {
    operator?: Operator;
  }
}

/** preHandler: requires "Authorization: Bearer <token>" belonging to an active operator. */
export function requireOperator(pool: pg.Pool) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
    if (!match) return reply.code(401).send({ error: 'Authorization: Bearer <operator token> required' });
    const r = await pool.query<Operator>(
      'SELECT id, name, role FROM operators WHERE token_hash = $1 AND active',
      [hashOperatorToken(match[1])],
    );
    if (!r.rows[0]) return reply.code(401).send({ error: 'invalid or inactive operator token' });
    request.operator = r.rows[0];
  };
}
