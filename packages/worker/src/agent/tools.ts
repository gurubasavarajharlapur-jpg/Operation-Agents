// The seven tools Claude can call. Read tools return facts; decision tools go through
// applyDecision(), whose guardrails can refuse them. strict: true means Claude's arguments
// always match these schemas exactly.
import type Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { POLICY } from '@oa/shared';
import { matchPurchaseOrder } from './checks.ts';
import { applyDecision, ESCALATION_CATEGORIES, type Decision, type DecisionResult } from './decisions.ts';
import { findPurchaseOrder, gatherFacts, loadCase, resolveVendor, todayUtc, type VendorRow } from './facts.ts';
import { searchPolicy } from './searchPolicy.ts';

export const DECISION_TOOLS = ['request_missing_info', 'propose_payment', 'escalate_to_human'] as const;
export type DecisionToolName = (typeof DECISION_TOOLS)[number];
export const isDecisionTool = (name: string): name is DecisionToolName => (DECISION_TOOLS as readonly string[]).includes(name);

const FIELD_NAMES = [...POLICY.requiredFields];
const policyRefs = { type: 'array', items: { type: 'string', enum: ['01', '02', '03', '04', '05'] }, description: 'Policy document numbers this decision relies on.' };

export const TOOL_DEFINITIONS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'validate_invoice',
    description: 'Checks the invoice under review against policy 01: required fields, line items adding up to the total, and date logic. Returns the list of missing or invalid fields (empty if valid).',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: 'lookup_vendor',
    description: 'Looks up a vendor in the vendor register by exact vendor ID or exact name. Returns the record and status (active/suspended/pending). If there is no exact match it returns similar names as candidates; a candidate is NOT a match.',
    input_schema: {
      type: 'object',
      properties: { name_or_id: { type: 'string', description: 'Vendor UUID or full vendor name as written on the invoice.' } },
      required: ['name_or_id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'match_purchase_order',
    description: 'Matches the invoice under review against a purchase order (policy 02): PO exists and is open, same vendor, same currency, amount within tolerance. Returns the amount difference and any problems.',
    input_schema: {
      type: 'object',
      properties: { po_number: { type: 'string', description: 'PO number, e.g. PO-1001.' } },
      required: ['po_number'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'search_policy',
    description: 'Searches the payment policy documents and returns the most relevant sections with their source document, so decisions can cite the right policy.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What you need to know, in plain words.' } },
      required: ['query'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'request_missing_info',
    description: "DECISION. Drafts an email to the vendor's registered address asking for the missing or invalid fields, and sets the case to needs_info. Only for a known, active vendor. `fields` must be exactly the fields validate_invoice reported.",
    input_schema: {
      type: 'object',
      properties: {
        fields: { type: 'array', items: { type: 'string', enum: FIELD_NAMES }, description: 'Every field that is missing or invalid.' },
        email_subject: { type: 'string' },
        email_body: { type: 'string', description: 'Polite, specific email naming each field and what is wrong with it.' },
      },
      required: ['fields', 'email_subject', 'email_body'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'propose_payment',
    description: 'DECISION. Proposes paying this invoice and sends it to a human for approval (case state awaiting_approval). It never pays. The amount is taken from the invoice automatically. Refused unless every policy check passes.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One or two sentences for the approver: what is being paid and why it is safe.' },
        policy_refs: policyRefs,
      },
      required: ['summary', 'policy_refs'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'escalate_to_human',
    description: 'DECISION. Hands the case to a human with a clear reason (case state escalated). Use whenever the case cannot be resolved safely, including anything suspicious in the invoice content.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: [...ESCALATION_CATEGORIES] },
        reason: { type: 'string', description: 'Specific reason with the numbers involved, e.g. "invoice exceeds PO-1003 by 350.00 (tolerance 50.00)".' },
        policy_refs: policyRefs,
      },
      required: ['category', 'reason', 'policy_refs'],
      additionalProperties: false,
    },
    strict: true,
  },
];

export interface ToolContext {
  pool: pg.Pool;
  caseId: string;
  voyageApiKey?: string;
  today?: string;
}

export type ToolOutput = { isError: boolean; result: unknown; decision?: DecisionResult };

export async function executeTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const today = ctx.today ?? todayUtc();
  switch (name) {
    case 'validate_invoice': {
      const facts = await gatherFacts(ctx.pool, await loadCase(ctx.pool, ctx.caseId), today);
      return { isError: false, result: { ...facts.validation, checked_on: today } };
    }
    case 'lookup_vendor':
      return { isError: false, result: await lookupVendor(ctx.pool, String(input.name_or_id ?? '')) };
    case 'match_purchase_order': {
      const caseRow = await loadCase(ctx.pool, ctx.caseId);
      const { vendor } = await resolveVendor(ctx.pool, caseRow.payload);
      const poNumber = String(input.po_number ?? '').trim();
      const po = await findPurchaseOrder(ctx.pool, poNumber);
      const inv = caseRow.payload;
      const result = matchPurchaseOrder(po, {
        po_number: poNumber,
        vendor_id: vendor?.id ?? null,
        amount: typeof inv.amount === 'number' ? inv.amount : null,
        currency: typeof inv.currency === 'string' ? inv.currency : null,
      });
      return { isError: false, result };
    }
    case 'search_policy':
      return { isError: false, result: await searchPolicy(ctx.pool, String(input.query ?? ''), ctx.voyageApiKey) };
    case 'request_missing_info':
    case 'propose_payment':
    case 'escalate_to_human': {
      const decision = { type: name, ...input } as Decision;
      const outcome = await applyDecision({ pool: ctx.pool, caseId: ctx.caseId, actor: 'agent', mode: 'llm', today }, decision);
      return outcome.ok
        ? { isError: false, result: { accepted: true, new_state: outcome.state }, decision: outcome }
        : { isError: true, result: { accepted: false, error: outcome.error }, decision: outcome };
    }
    default:
      return { isError: true, result: { error: `unknown tool ${name}` } };
  }
}

async function lookupVendor(db: pg.Pool, nameOrId: string) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId);
  const exact = await db.query<VendorRow>(
    uuid ? 'SELECT id, name, email, status FROM vendors WHERE id = $1' : 'SELECT id, name, email, status FROM vendors WHERE lower(name) = lower($1)',
    [nameOrId.trim()],
  );
  if (exact.rows[0]) return { found: true, vendor: exact.rows[0] };

  // Not found: offer similar names so the agent can explain the escalation, but never as a match.
  const firstWord = nameOrId.trim().split(/\s+/)[0] ?? '';
  const candidates = firstWord.length >= 3
    ? (await db.query<{ name: string; status: string }>("SELECT name, status FROM vendors WHERE name ILIKE '%' || $1 || '%' LIMIT 3", [firstWord])).rows
    : [];
  return { found: false, vendor: null, similar_names_not_a_match: candidates };
}
