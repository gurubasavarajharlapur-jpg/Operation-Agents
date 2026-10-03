import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { INVOICE_QUEUE, canonicalJson, type InvoicePayload, type WebhookResponse } from '@oa/shared';
import { appendAuditEvent } from '@oa/db';
import { isValidSignature } from '../signature.ts';

interface WebhookDeps {
  pool: pg.Pool;
  boss: PgBoss;
  webhookSecret: string;
  faultInjection?: boolean;
}

// Demo only (ENABLE_FAULT_INJECTION=true): a signed request may ask the worker to fail some
// attempts, to show retries and the dead letter live. Never read from the invoice body.
const FAULT_MODES = { recovers: 2, never_recovers: 4 } as const;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;

export async function webhookRoutes(app: FastifyInstance, deps: WebhookDeps) {
  app.post('/webhooks/invoice', async (request, reply) => {
    // 1. Authenticate: the body must be signed with the shared secret.
    const signature = request.headers['x-signature'];
    if (!isValidSignature(request.rawBody ?? '', typeof signature === 'string' ? signature : undefined, deps.webhookSecret)) {
      return reply.code(401).send({ error: 'invalid or missing X-Signature' });
    }

    // 2. Check the request shape. Missing invoice FIELDS are fine here: finding those is the agent's job.
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      return reply.code(400).send({ error: 'Idempotency-Key header is required (1-255 chars: letters, digits, . _ : -)' });
    }
    const payload = request.body;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return reply.code(400).send({ error: 'body must be a JSON object' });
    }

    const invoice = payload as InvoicePayload;
    const payloadHash = crypto.createHash('sha256').update(canonicalJson(invoice)).digest('hex');

    // 3. Insert the case and enqueue its job in ONE transaction: either both happen or neither does.
    //    There is never a case without a job, or a job without a case.
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string; state: string }>(
        `INSERT INTO cases (idempotency_key, payload_hash, payload, due_date)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id, state`,
        [key, payloadHash, invoice, parseDueDate(invoice.due_date)],
      );

      if (inserted.rows.length === 1) {
        const created = inserted.rows[0];
        const fault = request.headers['x-simulate-failure'];
        if (deps.faultInjection && typeof fault === 'string' && fault in FAULT_MODES) {
          // Same transaction as the case, so the worker can never pick the job up before the fault exists.
          await client.query('INSERT INTO fault_injections (case_id, mode, failures_remaining) VALUES ($1, $2, $3)', [
            created.id, fault, FAULT_MODES[fault as keyof typeof FAULT_MODES],
          ]);
        }
        await deps.boss.send(
          INVOICE_QUEUE,
          { caseId: created.id },
          {
            singletonKey: created.id, // second guard: pg-boss will not hold two live jobs for one case
            db: { executeSql: (text, values) => client.query(text, values) }, // same transaction
          },
        );
        await appendAuditEvent(client, {
          caseId: created.id,
          actor: 'system',
          action: 'case.received',
          input: { idempotency_key: key, payload_hash: payloadHash },
          output: { state: created.state, queue: INVOICE_QUEUE },
        });
        await client.query('COMMIT');
        request.log.info({ caseId: created.id }, 'case created and queued');
        return reply.code(202).send({ case_id: created.id, state: created.state, duplicate: false } satisfies WebhookResponse);
      }

      // ON CONFLICT DO NOTHING returned no row: this key was already used. Nothing to commit.
      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // 4. Duplicate key. If a concurrent request with the same key was mid-transaction, Postgres made
    //    our INSERT wait for it, so the existing row is committed and visible by now.
    const existing = await deps.pool.query<{ id: string; state: string; payload_hash: string }>(
      'SELECT id, state, payload_hash FROM cases WHERE idempotency_key = $1',
      [key],
    );
    const found = existing.rows[0];
    const conflict = found.payload_hash !== payloadHash;
    // Record the rejected or ignored resubmission too: the audit trail shows every attempt.
    await withTransaction(deps.pool, (tx) =>
      appendAuditEvent(tx, {
        caseId: found.id,
        actor: 'system',
        action: conflict ? 'webhook.idempotency_conflict' : 'webhook.duplicate_ignored',
        input: { idempotency_key: key, payload_hash: payloadHash },
        output: { existing_payload_hash: found.payload_hash },
      }),
    );
    if (conflict) {
      return reply.code(409).send({
        error: 'Idempotency-Key was already used with a different payload',
        case_id: found.id,
      });
    }
    return reply.code(200).send({ case_id: found.id, state: found.state, duplicate: true } satisfies WebhookResponse);
  });
}

async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Store due_date only if it is a real calendar date in YYYY-MM-DD form; otherwise leave it null
// and let the agent flag it. (new Date('2026-02-31') silently rolls over, so we round-trip check.)
function parseDueDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}
