// Append-only, hash-chained audit log.
//
// Every event stores the hash of the event before it, and its own hash is
//   sha256(prev_hash + canonical JSON of the event)
// so changing, deleting or reordering any past event breaks every hash after it.
// The database trigger (migration 002) already blocks UPDATE/DELETE; the chain makes tampering
// detectable even by someone who bypasses the trigger (e.g. a superuser).
import crypto from 'node:crypto';
import type pg from 'pg';
import { canonicalJson } from '@oa/shared';

export type AuditActor = 'agent' | 'human' | 'system';

export interface AuditEventInput {
  caseId: string | null;
  actor: AuditActor;
  action: string; // e.g. 'case.received', 'tool.lookup_vendor', 'llm.call', 'state.changed'
  input?: unknown;
  output?: unknown;
  tokens?: number | null;
  costUsd?: number | null;
}

// Anything with .query(): a Pool, a Client or a PoolClient.
type Queryable = Pick<pg.ClientBase, 'query'>;

// One global lock id: audit writes are serialised so two writers can never both read the same
// "last hash" and fork the chain. (Fine at this scale; see README trade-offs.)
const AUDIT_CHAIN_LOCK = 727002;

// The exact fields that are hashed, in the same form they come back out of Postgres.
interface HashedRecord {
  case_id: string | null;
  actor: AuditActor;
  action: string;
  input: unknown;
  output: unknown;
  tokens: number | null;
  cost_usd: string | null; // numeric(10,6) comes back from pg as a string, so hash it as one
  created_at: string; // ISO 8601, millisecond precision (what a JS Date holds)
}

export function computeAuditHash(prevHash: string | null, record: HashedRecord): string {
  return crypto.createHash('sha256').update((prevHash ?? '') + canonicalJson(record)).digest('hex');
}

// jsonb stores what JSON.stringify produces (undefined dropped, Dates as strings), so normalise
// first; then the hash we compute now equals the hash recomputed from the stored row later.
function toJsonValue(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/**
 * Appends one event. MUST be called inside a transaction (BEGIN ... COMMIT) on `client`:
 * the advisory lock is released at commit, and the event commits or rolls back together
 * with whatever business change it describes.
 */
export async function appendAuditEvent(client: Queryable, event: AuditEventInput): Promise<{ id: string; hash: string }> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_CHAIN_LOCK]);
  const last = await client.query<{ hash: string }>('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1');
  const prevHash = last.rows[0]?.hash ?? null;

  const record: HashedRecord = {
    case_id: event.caseId,
    actor: event.actor,
    action: event.action,
    input: toJsonValue(event.input),
    output: toJsonValue(event.output),
    tokens: event.tokens ?? null,
    cost_usd: event.costUsd == null ? null : event.costUsd.toFixed(6),
    created_at: new Date().toISOString(),
  };
  const hash = computeAuditHash(prevHash, record);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO audit_events (case_id, actor, action, input, output, tokens, cost_usd, prev_hash, hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      record.case_id, record.actor, record.action,
      JSON.stringify(record.input), JSON.stringify(record.output),
      record.tokens, record.cost_usd, prevHash, hash, record.created_at,
    ],
  );
  return { id: inserted.rows[0].id, hash };
}

export interface ChainVerification {
  intact: boolean;
  events_checked: number;
  head_hash: string | null; // publish/anchor this externally to also detect a rewritten chain
  broken_at?: { id: string; reason: string };
}

/** Recomputes every hash from the stored rows, oldest first, and checks each link. */
export async function verifyAuditChain(db: Queryable, batchSize = 1000): Promise<ChainVerification> {
  let prevHash: string | null = null;
  let lastId = '0';
  let checked = 0;

  for (;;) {
    const { rows } = await db.query<{
      id: string; case_id: string | null; actor: AuditActor; action: string; input: unknown; output: unknown;
      tokens: number | null; cost_usd: string | null; prev_hash: string | null; hash: string; created_at: Date;
    }>(
      `SELECT id, case_id, actor, action, input, output, tokens, cost_usd, prev_hash, hash, created_at
       FROM audit_events WHERE id > $1 ORDER BY id LIMIT $2`,
      [lastId, batchSize],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      if (row.prev_hash !== prevHash) {
        return { intact: false, events_checked: checked, head_hash: prevHash, broken_at: { id: row.id, reason: 'prev_hash does not match the previous event (event removed or reordered)' } };
      }
      const recomputed = computeAuditHash(prevHash, {
        case_id: row.case_id, actor: row.actor, action: row.action, input: row.input, output: row.output,
        tokens: row.tokens, cost_usd: row.cost_usd, created_at: row.created_at.toISOString(),
      });
      if (recomputed !== row.hash) {
        return { intact: false, events_checked: checked, head_hash: prevHash, broken_at: { id: row.id, reason: 'event content does not match its hash (event modified)' } };
      }
      prevHash = row.hash;
      lastId = row.id;
      checked++;
    }
  }
  return { intact: true, events_checked: checked, head_hash: prevHash };
}

/** Appends one event in its own short transaction (for events not tied to another write). */
export async function recordAuditEvent(pool: pg.Pool, event: AuditEventInput): Promise<{ id: string; hash: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await appendAuditEvent(client, event);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
