// Gathers everything the code knows about a case from the database. Used by:
//   - the read-only tools (so Claude sees exactly what the guardrails will check)
//   - the guardrails, which re-run this inside the decision transaction
//   - the rules-only engine
import type pg from 'pg';
import type { InvoicePayload } from '@oa/shared';
import {
  approvalAuthority, matchPurchaseOrder, validateInvoice,
  type PoMatchResult, type PurchaseOrderRow, type ValidationResult,
} from './checks.ts';

export type Queryable = Pick<pg.ClientBase, 'query'>;

export interface VendorRow {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'suspended' | 'pending';
}

export interface CaseRow {
  id: string;
  payload: InvoicePayload;
  created_at: Date;
}

export type BlockerCode =
  | 'invalid_invoice' | 'unknown_vendor' | 'vendor_not_active' | 'vendor_mismatch'
  | 'suspected_duplicate' | 'po_mismatch' | 'over_approval_limit';

export interface Blocker {
  code: BlockerCode;
  message: string;
  policy: string; // which policy document says so
}

export interface CaseFacts {
  validation: ValidationResult;
  vendor: VendorRow | null;
  duplicateOf: string | null; // id of an earlier case with the same vendor + invoice number
  poMatch: PoMatchResult | null;
  blockers: Blocker[]; // empty = a payment may be proposed
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exact resolution only. "Close enough" vendor names are never treated as a match (policy 03). */
export async function resolveVendor(db: Queryable, invoice: InvoicePayload): Promise<{ vendor: VendorRow | null; nameMismatch: boolean }> {
  let vendor: VendorRow | null = null;
  if (typeof invoice.vendor_id === 'string' && UUID.test(invoice.vendor_id)) {
    vendor = (await db.query<VendorRow>('SELECT id, name, email, status FROM vendors WHERE id = $1', [invoice.vendor_id])).rows[0] ?? null;
  } else if (typeof invoice.vendor_name === 'string' && invoice.vendor_name.trim()) {
    vendor = (await db.query<VendorRow>('SELECT id, name, email, status FROM vendors WHERE lower(name) = lower($1)', [invoice.vendor_name.trim()])).rows[0] ?? null;
  }
  const nameMismatch = Boolean(
    vendor && typeof invoice.vendor_name === 'string' && invoice.vendor_name.trim() &&
      invoice.vendor_name.trim().toLowerCase() !== vendor.name.toLowerCase(),
  );
  return { vendor, nameMismatch };
}

export async function findPurchaseOrder(db: Queryable, poNumber: string): Promise<PurchaseOrderRow | null> {
  const r = await db.query<PurchaseOrderRow>(
    'SELECT po_number, vendor_id, amount, currency, status FROM purchase_orders WHERE po_number = $1',
    [poNumber],
  );
  return r.rows[0] ?? null;
}

/** Policy 05: the same invoice number from the same vendor must only be paid once. */
export async function findDuplicate(db: Queryable, caseRow: CaseRow, vendor: VendorRow): Promise<string | null> {
  const invoiceNumber = caseRow.payload.invoice_number;
  if (typeof invoiceNumber !== 'string' || !invoiceNumber.trim()) return null;
  const r = await db.query<{ id: string }>(
    `SELECT id FROM cases
     WHERE id <> $1 AND state <> 'failed'
       -- compared in SQL: a JS Date would drop the microseconds and miss near-simultaneous duplicates
       AND created_at < (SELECT created_at FROM cases WHERE id = $1)
       AND payload->>'invoice_number' = $2
       AND (payload->>'vendor_id' = $3 OR lower(payload->>'vendor_name') = lower($4))
     ORDER BY created_at LIMIT 1`,
    [caseRow.id, invoiceNumber, vendor.id, vendor.name],
  );
  return r.rows[0]?.id ?? null;
}

export async function gatherFacts(db: Queryable, caseRow: CaseRow, today: string): Promise<CaseFacts> {
  const invoice = caseRow.payload;
  const blockers: Blocker[] = [];

  const validation = validateInvoice(invoice, today);
  if (!validation.valid) {
    blockers.push({ code: 'invalid_invoice', message: `missing or invalid fields: ${validation.issues.map((i) => i.field).join(', ')}`, policy: '01' });
  }

  const { vendor, nameMismatch } = await resolveVendor(db, invoice);
  if (!vendor) {
    if (invoice.vendor_id || invoice.vendor_name) {
      blockers.push({ code: 'unknown_vendor', message: 'vendor on the invoice is not in the vendor register', policy: '03' });
    }
  } else {
    if (vendor.status !== 'active') blockers.push({ code: 'vendor_not_active', message: `vendor status is ${vendor.status}`, policy: '03' });
    if (nameMismatch) blockers.push({ code: 'vendor_mismatch', message: `vendor_name "${invoice.vendor_name}" does not match the registered name "${vendor.name}" for that vendor_id`, policy: '03' });
  }

  const duplicateOf = vendor ? await findDuplicate(db, caseRow, vendor) : null;
  if (duplicateOf) blockers.push({ code: 'suspected_duplicate', message: `invoice number already received from this vendor (case ${duplicateOf})`, policy: '05' });

  let poMatch: PoMatchResult | null = null;
  if (typeof invoice.po_number === 'string' && invoice.po_number.trim()) {
    const po = await findPurchaseOrder(db, invoice.po_number.trim());
    poMatch = matchPurchaseOrder(po, {
      po_number: invoice.po_number.trim(),
      vendor_id: vendor?.id ?? null,
      amount: typeof invoice.amount === 'number' ? invoice.amount : null,
      currency: typeof invoice.currency === 'string' ? invoice.currency : null,
    });
    if (!poMatch.matched) blockers.push({ code: 'po_mismatch', message: poMatch.problems.join('; '), policy: '02' });
  }

  if (typeof invoice.amount === 'number' && !approvalAuthority(invoice.amount).allowed) {
    blockers.push({ code: 'over_approval_limit', message: 'amount above 50,000.00 must go to the finance director', policy: '04' });
  }

  return { validation, vendor, duplicateOf, poMatch, blockers };
}

export async function loadCase(db: Queryable, caseId: string): Promise<CaseRow> {
  const r = await db.query<CaseRow>('SELECT id, payload, created_at FROM cases WHERE id = $1', [caseId]);
  if (!r.rows[0]) throw new Error(`case ${caseId} not found`);
  return r.rows[0];
}

export const todayUtc = () => new Date().toISOString().slice(0, 10);
