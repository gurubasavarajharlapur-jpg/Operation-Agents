// Rules-only mode: the same facts and the same guarded decisions, but a fixed if/else instead of
// Claude. It handles clear-cut cases like the agent does, cannot judge anything the rules don't
// anticipate (odd wording, fraud hints in free text), and costs $0. Used as a fallback when no
// API key is configured, and as the baseline the Day 2 evals compare Claude against.
import type pg from 'pg';
import { applyDecision, categoryFor, type Decision } from './decisions.ts';
import { gatherFacts, loadCase, todayUtc } from './facts.ts';
import { recordAuditEvent } from '@oa/db';
import type { AgentRunResult } from './loop.ts';

export async function runRulesAgent(pool: pg.Pool, caseId: string, today = todayUtc()): Promise<AgentRunResult> {
  const caseRow = await loadCase(pool, caseId);
  const facts = await gatherFacts(pool, caseRow, today);
  const has = (code: string) => facts.blockers.find((b) => b.code === code);

  let decision: Decision;
  const vendorBlocker = has('vendor_not_active') ?? has('vendor_mismatch') ?? has('suspected_duplicate');
  if (!facts.vendor) {
    decision = { type: 'escalate_to_human', category: 'unknown_vendor', reason: 'Vendor is missing from the invoice or not in the vendor register.', policy_refs: ['03'] };
  } else if (vendorBlocker) {
    decision = { type: 'escalate_to_human', category: categoryFor(vendorBlocker.code), reason: vendorBlocker.message, policy_refs: [vendorBlocker.policy] };
  } else if (!facts.validation.valid) {
    const fields = [...new Set(facts.validation.issues.map((i) => i.field))];
    decision = {
      type: 'request_missing_info',
      fields,
      email_subject: `Invoice ${caseRow.payload.invoice_number ?? '(no number)'}: information needed`,
      email_body: [
        `Dear ${facts.vendor.name},`,
        '',
        'We could not process your invoice because of the following:',
        ...facts.validation.issues.map((i) => `- ${i.field}: ${i.issue}`),
        '',
        'Please send a corrected invoice.',
        '',
        'Accounts Payable',
      ].join('\n'),
    };
  } else if (facts.blockers.length > 0) {
    const first = facts.blockers[0];
    decision = { type: 'escalate_to_human', category: categoryFor(first.code), reason: facts.blockers.map((b) => b.message).join('; '), policy_refs: [...new Set(facts.blockers.map((b) => b.policy))] };
  } else {
    decision = {
      type: 'propose_payment',
      summary: `Invoice matches ${caseRow.payload.po_number} for active vendor ${facts.vendor.name}; all checks passed.`,
      policy_refs: ['01', '02', '03', '04'],
    };
  }

  await recordAuditEvent(pool, {
    caseId, actor: 'system', action: 'rules.evaluated',
    input: { mode: 'rules' }, output: { blockers: facts.blockers, validation: facts.validation, chosen: decision.type },
  });
  const result = await applyDecision({ pool, caseId, actor: 'system', mode: 'rules', today }, decision);
  if (!result.ok && result.alreadyDecided) return { state: null, endReason: 'already_decided', turns: 0, tokens: 0, costUsd: 0 };
  if (!result.ok) throw new Error(`rules engine decision was refused: ${result.error}`); // would be a bug in the rules
  return { state: result.state, endReason: 'decision', turns: 0, tokens: 0, costUsd: 0 };
}
