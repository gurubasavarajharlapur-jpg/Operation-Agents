import { describe, expect, it } from 'vitest';
import { approvalAuthority, matchPurchaseOrder, validateInvoice } from '../src/agent/checks.ts';
import { paymentFlags } from '../src/agent/decisions.ts';
import { TODAY, invoice } from './helpers.ts';

const fields = (inv: Parameters<typeof validateInvoice>[0]) => validateInvoice(inv, TODAY).issues.map((i) => i.field);

describe('validateInvoice (policy 01)', () => {
  it('accepts a complete, consistent invoice', () => {
    expect(validateInvoice(invoice(), TODAY)).toEqual({ valid: true, issues: [] });
  });

  it('names every missing field', () => {
    expect(fields({ invoice_number: 'X' })).toEqual(['vendor', 'po_number', 'amount', 'currency', 'issue_date', 'due_date', 'line_items']);
  });

  it('flags line items that do not add up to the total', () => {
    const r = validateInvoice(invoice({ amount: 1300 }), TODAY);
    expect(r.issues).toEqual([{ field: 'amount', issue: 'line items add up to 1250.00 but the invoice total is 1300.00' }]);
  });

  it('allows a rounding difference of up to 0.01', () => {
    const inv = invoice({ amount: 100.0, line_items: [{ quantity: 3, unit_price: 33.333 }] });
    expect(validateInvoice(inv, TODAY).valid).toBe(true);
  });

  it('rejects impossible dates, due before issue, and future issue dates', () => {
    expect(fields(invoice({ due_date: '2026-02-31' }))).toEqual(['due_date']);
    expect(fields(invoice({ issue_date: '2026-09-20', due_date: '2026-09-01' }))).toEqual(['due_date']);
    expect(fields(invoice({ issue_date: '2026-12-01', due_date: '2026-12-31' }))).toEqual(['issue_date']);
  });

  it('rejects a lowercase or wrong-length currency', () => {
    expect(fields(invoice({ currency: 'gbp' }))).toEqual(['currency']);
  });
});

describe('matchPurchaseOrder (policy 02)', () => {
  const po = { po_number: 'PO-1003', vendor_id: 'v1', amount: '3600.00', currency: 'GBP', status: 'open' as const };
  const inv = { po_number: 'PO-1003', vendor_id: 'v1', amount: 3600, currency: 'GBP' };

  it('matches an exact invoice', () => {
    expect(matchPurchaseOrder(po, inv)).toMatchObject({ matched: true, amount_difference: 0 });
  });

  it('uses the smaller of 2% and 50.00 as the tolerance', () => {
    // 2% of 3600 is 72, so the 50.00 cap applies
    expect(matchPurchaseOrder(po, { ...inv, amount: 3650 })).toMatchObject({ matched: true, allowed_over_by: 50 });
    expect(matchPurchaseOrder(po, { ...inv, amount: 3650.01 }).matched).toBe(false);
    // 2% of 1000 is 20, smaller than 50
    expect(matchPurchaseOrder({ ...po, amount: '1000.00' }, { ...inv, amount: 1020.01 }).matched).toBe(false);
  });

  it('allows partial invoices below the PO amount', () => {
    expect(matchPurchaseOrder(po, { ...inv, amount: 1000 }).matched).toBe(true);
  });

  it('rejects closed POs, another vendor, a different currency, and missing POs', () => {
    expect(matchPurchaseOrder({ ...po, status: 'closed' }, inv).problems[0]).toMatch(/closed/);
    expect(matchPurchaseOrder(po, { ...inv, vendor_id: 'v2' }).problems[0]).toMatch(/different vendor/);
    expect(matchPurchaseOrder(po, { ...inv, currency: 'EUR' }).problems[0]).toMatch(/currency mismatch/);
    expect(matchPurchaseOrder(null, inv)).toMatchObject({ found: false, matched: false });
  });
});

describe('approvalAuthority (policy 04)', () => {
  it('routes by amount', () => {
    expect(approvalAuthority(10_000)).toEqual({ allowed: true, required_role: 'operations' });
    expect(approvalAuthority(10_000.01)).toEqual({ allowed: true, required_role: 'finance_manager' });
    expect(approvalAuthority(50_000.01).allowed).toBe(false);
  });
});

describe('paymentFlags (policy 05)', () => {
  it('flags overdue invoices and short payment terms', () => {
    expect(paymentFlags('2026-09-01', '2026-09-10', TODAY)).toEqual(['overdue', 'short_payment_terms']);
    expect(paymentFlags('2026-09-20', '2026-10-20', TODAY)).toEqual([]);
  });
});
