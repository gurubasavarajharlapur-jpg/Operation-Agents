// Pure business checks: no database, no LLM. Each one returns facts, not decisions.
// The tools, the guardrails and the rules-only engine all call these same functions.
import { POLICY, type InvoicePayload } from '@oa/shared';

export interface FieldIssue {
  field: string; // which invoice field is missing or wrong
  issue: string; // human-readable explanation
}

export interface ValidationResult {
  valid: boolean;
  issues: FieldIssue[];
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isPositiveNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

// 'YYYY-MM-DD' that is a real calendar date (rejects 2026-02-31).
export function parseIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Policy 01: required fields and consistency. `today` is a parameter so tests are deterministic. */
export function validateInvoice(invoice: InvoicePayload, today: string): ValidationResult {
  const issues: FieldIssue[] = [];

  if (!isNonEmptyString(invoice.invoice_number)) issues.push({ field: 'invoice_number', issue: 'missing' });
  if (!isNonEmptyString(invoice.vendor_id) && !isNonEmptyString(invoice.vendor_name)) {
    issues.push({ field: 'vendor', issue: 'missing: neither vendor_id nor vendor_name given' });
  }
  if (!isNonEmptyString(invoice.po_number)) issues.push({ field: 'po_number', issue: 'missing' });
  if (invoice.amount === undefined || invoice.amount === null) issues.push({ field: 'amount', issue: 'missing' });
  else if (!isPositiveNumber(invoice.amount)) issues.push({ field: 'amount', issue: 'must be a positive number' });
  if (!isNonEmptyString(invoice.currency)) issues.push({ field: 'currency', issue: 'missing' });
  else if (!/^[A-Z]{3}$/.test(invoice.currency)) issues.push({ field: 'currency', issue: 'must be a 3-letter ISO code such as GBP' });

  const issueDate = parseIsoDate(invoice.issue_date);
  const dueDate = parseIsoDate(invoice.due_date);
  if (invoice.issue_date === undefined) issues.push({ field: 'issue_date', issue: 'missing' });
  else if (!issueDate) issues.push({ field: 'issue_date', issue: 'not a valid YYYY-MM-DD date' });
  if (invoice.due_date === undefined) issues.push({ field: 'due_date', issue: 'missing' });
  else if (!dueDate) issues.push({ field: 'due_date', issue: 'not a valid YYYY-MM-DD date' });
  if (issueDate && dueDate && dueDate < issueDate) issues.push({ field: 'due_date', issue: 'earlier than issue_date' });
  if (issueDate && issueDate > today) issues.push({ field: 'issue_date', issue: 'in the future' });

  const items = invoice.line_items;
  if (!Array.isArray(items) || items.length === 0) {
    issues.push({ field: 'line_items', issue: 'missing: at least one line item is required' });
  } else {
    const malformed = items.some((li) => typeof li?.quantity !== 'number' || typeof li?.unit_price !== 'number');
    if (malformed) {
      issues.push({ field: 'line_items', issue: 'every line item needs a numeric quantity and unit_price' });
    } else if (isPositiveNumber(invoice.amount)) {
      const sum = round2(items.reduce((total, li) => total + li.quantity! * li.unit_price!, 0));
      if (Math.abs(sum - invoice.amount) > POLICY.lineItemRoundingTolerance) {
        issues.push({ field: 'amount', issue: `line items add up to ${sum.toFixed(2)} but the invoice total is ${invoice.amount.toFixed(2)}` });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export interface PurchaseOrderRow {
  po_number: string;
  vendor_id: string;
  amount: string; // numeric comes back from pg as a string
  currency: string;
  status: 'open' | 'closed' | 'cancelled';
}

export interface PoMatchResult {
  found: boolean;
  matched: boolean; // true only if every check below passes
  po_number: string;
  po_status?: string;
  po_amount?: number;
  invoice_amount?: number;
  amount_difference?: number; // invoice minus PO; positive = invoiced more than ordered
  allowed_over_by?: number;
  problems: string[]; // each one names the policy it breaks
}

/** Policy 02: the invoice must match an open PO of the same vendor, currency and amount (within tolerance). */
export function matchPurchaseOrder(
  po: PurchaseOrderRow | null,
  invoice: { po_number: string; vendor_id: string | null; amount: number | null; currency: string | null },
): PoMatchResult {
  if (!po) {
    return { found: false, matched: false, po_number: invoice.po_number, problems: [`PO ${invoice.po_number} does not exist (policy 02)`] };
  }
  const poAmount = Number(po.amount);
  const problems: string[] = [];
  if (po.status !== 'open') problems.push(`PO is ${po.status}, not open (policy 02)`);
  if (invoice.vendor_id && po.vendor_id !== invoice.vendor_id) problems.push('PO belongs to a different vendor (policy 02)');
  if (invoice.currency && po.currency !== invoice.currency) {
    problems.push(`currency mismatch: invoice ${invoice.currency}, PO ${po.currency}; no conversion allowed (policy 02)`);
  }

  const allowedOverBy = round2(Math.min(poAmount * POLICY.poMatchPercentTolerance, POLICY.poMatchAbsoluteTolerance));
  let difference: number | undefined;
  if (invoice.amount != null) {
    difference = round2(invoice.amount - poAmount);
    // Under the PO amount is a partial invoice, which policy 02 allows.
    if (difference > allowedOverBy) {
      problems.push(`invoice exceeds PO by ${difference.toFixed(2)}, tolerance is ${allowedOverBy.toFixed(2)} (policy 02)`);
    }
  }

  return {
    found: true,
    matched: problems.length === 0,
    po_number: po.po_number,
    po_status: po.status,
    po_amount: poAmount,
    invoice_amount: invoice.amount ?? undefined,
    amount_difference: difference,
    allowed_over_by: allowedOverBy,
    problems,
  };
}

/** Policy 04: who may approve, or whether the agent may propose at all. */
export function approvalAuthority(amount: number): { allowed: boolean; required_role: 'operations' | 'finance_manager' } {
  if (amount > POLICY.maxProposableAmount) return { allowed: false, required_role: 'finance_manager' };
  return { allowed: true, required_role: amount > POLICY.operationsApprovalLimit ? 'finance_manager' : 'operations' };
}
