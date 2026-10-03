import crypto from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import type { InvoicePayload } from '@oa/shared';
import type { CreateMessage } from '../src/llm.ts';
import { testDatabaseUrl, testWorkerDatabaseUrl } from '../../../testing/testDb.ts';

export const TODAY = '2026-10-03';

// Seeded vendor IDs (packages/db/seed/vendors.json)
export const V = {
  northwind: 'a1000000-0000-4000-8000-000000000001', // active
  brightline: 'a1000000-0000-4000-8000-000000000002', // active
  harbour: 'a1000000-0000-4000-8000-000000000004', // active
  pinecrest: 'a1000000-0000-4000-8000-000000000006', // active
  sterling: 'a1000000-0000-4000-8000-000000000009', // suspended
  nova: 'a1000000-0000-4000-8000-000000000010', // pending
};

// admin: sets up fixtures and checks results. worker: runs the code under test, as the restricted
// ops_worker user the real worker uses, so tests prove the worker needs no more permissions.
export const createTestPool = () => new pg.Pool({ connectionString: testDatabaseUrl(), max: 10 });
export const createWorkerPool = () => new pg.Pool({ connectionString: testWorkerDatabaseUrl(), max: 10 });

/** A complete, valid invoice against PO-1001 (Northwind, 1250.00 GBP, open). Override per test. */
export function invoice(overrides: Partial<InvoicePayload> = {}): InvoicePayload {
  return {
    invoice_number: `INV-${crypto.randomUUID().slice(0, 8)}`, // unique so duplicate checks don't collide across tests
    vendor_id: V.northwind,
    vendor_name: 'Northwind Office Supplies Ltd',
    po_number: 'PO-1001',
    amount: 1250.0,
    currency: 'GBP',
    issue_date: '2026-09-20',
    due_date: '2026-10-20',
    line_items: [{ description: 'Office chairs', quantity: 5, unit_price: 250.0 }],
    ...overrides,
  };
}

/** Inserts a case directly in the given state (skipping the webhook, which has its own tests). */
export async function createCase(pool: pg.Pool, payload: InvoicePayload, state = 'received'): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO cases (idempotency_key, payload_hash, payload, state) VALUES ($1, 'test', $2, $3) RETURNING id`,
    [`test-${crypto.randomUUID()}`, payload, state],
  );
  return r.rows[0].id;
}

export async function getCase(pool: pg.Pool, id: string) {
  return (await pool.query('SELECT state, outcome FROM cases WHERE id = $1', [id])).rows[0];
}

export async function auditActions(pool: pg.Pool, caseId: string): Promise<string[]> {
  const r = await pool.query<{ action: string }>('SELECT action FROM audit_events WHERE case_id = $1 ORDER BY id', [caseId]);
  return r.rows.map((x) => x.action);
}

export async function approvalsFor(pool: pg.Pool, caseId: string) {
  return (await pool.query('SELECT amount, currency, status, required_role FROM approvals WHERE case_id = $1', [caseId])).rows;
}

// ---- Scripted fake Claude -------------------------------------------------------------

let nextId = 0;
export const toolUse = (name: string, input: Record<string, unknown> = {}): Anthropic.Beta.BetaToolUseBlock =>
  ({ type: 'tool_use', id: `toolu_${++nextId}`, name, input }) as Anthropic.Beta.BetaToolUseBlock;
export const text = (t: string) => ({ type: 'text', text: t, citations: null }) as Anthropic.Beta.BetaTextBlock;

export function reply(
  content: Anthropic.Beta.BetaContentBlock[],
  stop_reason: Anthropic.Beta.BetaStopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_${++nextId}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason,
    stop_sequence: null, stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

/**
 * A fake createMessage that returns the scripted replies in order and records every request
 * (deep-copied, because the loop keeps appending to the same messages array).
 */
export function scriptedClaude(replies: Anthropic.Beta.BetaMessage[]) {
  const requests: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  const createMessage: CreateMessage = async (params) => {
    requests.push(structuredClone(params));
    const next = replies.shift();
    if (!next) throw new Error('scripted Claude ran out of replies');
    return next;
  };
  return { createMessage, requests };
}
