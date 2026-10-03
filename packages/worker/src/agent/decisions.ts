// The three ways a case can leave 'validating'. This is the ONLY code that moves a case to
// needs_info / awaiting_approval / escalated, and every move re-checks the facts first,
// inside the same transaction as the write. Whatever Claude says, these checks decide.
import type pg from 'pg';
import { appendAuditEvent, type AuditActor } from '@oa/db';
import { canTransition, type CaseState } from '@oa/shared';
import { approvalAuthority } from './checks.ts';
import { gatherFacts, loadCase, todayUtc, type BlockerCode } from './facts.ts';

export const ESCALATION_CATEGORIES = [
  'unknown_vendor', 'vendor_not_active', 'vendor_mismatch', 'po_mismatch', 'suspected_duplicate',
  'over_approval_limit', 'suspicious_content', 'agent_failure', 'other',
] as const;
export type EscalationCategory = (typeof ESCALATION_CATEGORIES)[number];

export type Decision =
  | { type: 'propose_payment'; summary: string; policy_refs: string[] }
  | { type: 'request_missing_info'; fields: string[]; email_subject: string; email_body: string }
  | { type: 'escalate_to_human'; category: EscalationCategory; reason: string; policy_refs: string[] };

export type DecisionResult =
  | { ok: true; state: CaseState; outcome: Record<string, unknown> }
  // alreadyDecided: another worker decided this case first (e.g. a duplicate job delivery).
  // Not an error; the caller should simply stop.
  | { ok: false; error: string; alreadyDecided?: boolean };

export interface DecisionContext {
  pool: pg.Pool;
  caseId: string;
  actor: AuditActor; // 'agent' for Claude, 'system' for the rules engine or forced escalations
  mode: 'llm' | 'rules';
  today?: string;
}

class Rejected extends Error {}
class AlreadyDecided extends Rejected {}

export async function applyDecision(ctx: DecisionContext, decision: Decision): Promise<DecisionResult> {
  const today = ctx.today ?? todayUtc();
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the case so two workers can never decide the same case at the same time.
    // NO KEY UPDATE (not FOR UPDATE): it still blocks other deciders, but not the foreign-key
    // checks of audit_events inserts for this case. FOR UPDATE would deadlock against a
    // transaction holding the audit-chain lock while inserting an event for this case.
    const locked = await client.query<{ state: CaseState }>('SELECT state FROM cases WHERE id = $1 FOR NO KEY UPDATE', [ctx.caseId]);
    const from = locked.rows[0]?.state;
    if (from !== 'validating') throw new AlreadyDecided(`case is in state "${from}", not "validating"; no decision can be made now`);

    const caseRow = await loadCase(client, ctx.caseId);
    const facts = await gatherFacts(client, caseRow, today);
    const invoice = caseRow.payload;
    let to: CaseState;
    let outcome: Record<string, unknown>;

    if (decision.type === 'propose_payment') {
      // GUARDRAIL: a payment can only be proposed when every policy check passes.
      if (facts.blockers.length > 0) {
        throw new Rejected(`propose_payment refused: ${facts.blockers.map((b) => `${b.message} (policy ${b.policy})`).join('; ')}`);
      }
      // The amount comes from the stored invoice, never from the model's input.
      const amount = invoice.amount as number;
      const currency = invoice.currency as string;
      const { required_role } = approvalAuthority(amount);
      const approval = await client.query<{ id: string }>(
        `INSERT INTO approvals (case_id, proposed_action, amount, currency, required_role)
         VALUES ($1, 'pay_invoice', $2, $3, $4) RETURNING id`,
        [ctx.caseId, amount, currency, required_role],
      );
      to = 'awaiting_approval';
      outcome = {
        decision: 'propose_payment', approval_id: approval.rows[0].id, amount, currency, required_role,
        summary: decision.summary, policy_refs: decision.policy_refs, flags: paymentFlags(invoice.issue_date, invoice.due_date, today),
      };
    } else if (decision.type === 'request_missing_info') {
      // GUARDRAIL: only for a known, active vendor (we email their REGISTERED address, never one
      // from the invoice), and the fields named must be exactly the fields that are wrong.
      if (!facts.vendor) throw new Rejected('request_missing_info refused: vendor is unknown; escalate instead (policy 03)');
      if (facts.vendor.status !== 'active') throw new Rejected(`request_missing_info refused: vendor is ${facts.vendor.status}; escalate instead (policy 03)`);
      if (facts.duplicateOf) throw new Rejected('request_missing_info refused: suspected duplicate; escalate instead (policy 05)');
      const actual = [...new Set(facts.validation.issues.map((i) => i.field))].sort();
      if (actual.length === 0) throw new Rejected('request_missing_info refused: validate_invoice reports no missing or invalid fields');
      const named = [...new Set(decision.fields)].sort();
      if (named.join(',') !== actual.join(',')) {
        throw new Rejected(`request_missing_info refused: the fields to request must be exactly [${actual.join(', ')}] but you named [${named.join(', ')}] (policy 01)`);
      }
      to = 'needs_info';
      outcome = {
        decision: 'request_missing_info', missing_fields: facts.validation.issues,
        email: { to: facts.vendor.email, subject: decision.email_subject, body: decision.email_body, status: 'drafted' },
      };
    } else {
      to = 'escalated';
      outcome = { decision: 'escalate_to_human', category: decision.category, reason: decision.reason, policy_refs: decision.policy_refs };
    }

    if (!canTransition(from, to)) throw new Rejected(`transition ${from} -> ${to} is not allowed`);
    outcome = { ...outcome, decided_by_mode: ctx.mode, blockers_at_decision: facts.blockers };

    await client.query('UPDATE cases SET state = $1, outcome = $2 WHERE id = $3', [to, outcome, ctx.caseId]);
    await appendAuditEvent(client, { caseId: ctx.caseId, actor: ctx.actor, action: `decision.${decision.type}`, input: decision, output: outcome });
    await appendAuditEvent(client, { caseId: ctx.caseId, actor: ctx.actor, action: 'state.changed', input: { from, to }, output: { state: to } });
    await client.query('COMMIT');
    return { ok: true, state: to, outcome };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof Rejected) return { ok: false, error: err.message, alreadyDecided: err instanceof AlreadyDecided };
    throw err;
  } finally {
    client.release();
  }
}

/** Policy 05: things the approver should see (overdue, short payment terms). */
export function paymentFlags(issueDate: unknown, dueDate: unknown, today: string): string[] {
  const flags: string[] = [];
  if (typeof dueDate === 'string' && dueDate < today) flags.push('overdue');
  if (typeof issueDate === 'string' && typeof dueDate === 'string') {
    const days = (Date.parse(dueDate) - Date.parse(issueDate)) / 86_400_000;
    if (days < 14) flags.push('short_payment_terms');
  }
  return flags;
}

/** Maps a guardrail blocker to the escalation category the rules engine and forced escalations use. */
export function categoryFor(code: BlockerCode): EscalationCategory {
  return code === 'invalid_invoice' ? 'other' : code;
}
