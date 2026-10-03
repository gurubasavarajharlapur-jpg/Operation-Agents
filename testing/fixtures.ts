import crypto from 'node:crypto';
import type pg from 'pg';
import { hashOperatorToken, newOperatorToken } from '@oa/db';

/** Creates an operator with a fresh token, for tests. Returns the plain token. */
export async function createOperator(pool: pg.Pool, role: 'operations' | 'finance_manager', active = true) {
  const token = newOperatorToken();
  const r = await pool.query<{ id: string }>(
    'INSERT INTO operators (name, email, role, token_hash, active) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [`Test ${role}`, `${crypto.randomUUID()}@test.example`, role, hashOperatorToken(token), active],
  );
  return { id: r.rows[0].id, token };
}
