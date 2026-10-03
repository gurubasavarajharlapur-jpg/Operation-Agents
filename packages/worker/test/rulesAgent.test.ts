import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { runRulesAgent } from '../src/agent/rulesAgent.ts';
import { TODAY, V, approvalsFor, createCase, createTestPool, getCase, invoice } from './helpers.ts';

let pool: pg.Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

// The rules engine on each seeded scenario. These double as the "expected answer" for
// clear-cut cases, which the Claude agent must also get right (Day 2 evals).
async function decide(payload: Parameters<typeof invoice>[0]) {
  const id = await createCase(pool, invoice(payload), 'validating');
  await runRulesAgent(pool, id, TODAY);
  return { id, ...(await getCase(pool, id)) };
}

describe('rules-only engine', () => {
  it('proposes payment for a clean invoice, with the amount taken from the invoice', async () => {
    const c = await decide({});
    expect(c.state).toBe('awaiting_approval');
    expect(c.outcome).toMatchObject({ decision: 'propose_payment', amount: 1250, currency: 'GBP', required_role: 'operations', decided_by_mode: 'rules' });
    expect(await approvalsFor(pool, c.id)).toEqual([{ amount: '1250.00', currency: 'GBP', status: 'pending', required_role: 'operations' }]);
  });

  it('requests missing info by name, emailing the REGISTERED vendor address', async () => {
    const c = await decide({ po_number: undefined, due_date: undefined });
    expect(c.state).toBe('needs_info');
    expect(c.outcome.missing_fields.map((f: { field: string }) => f.field)).toEqual(['po_number', 'due_date']);
    expect(c.outcome.email.to).toBe('accounts@northwind-office.example');
    expect(c.outcome.email.body).toContain('po_number: missing');
  });

  it('escalates an amount over tolerance with the exact difference', async () => {
    const c = await decide({ vendor_id: V.brightline, vendor_name: 'Brightline Cloud Hosting', po_number: 'PO-1003', amount: 3950, line_items: [{ quantity: 1, unit_price: 3950 }] });
    expect(c.state).toBe('escalated');
    expect(c.outcome).toMatchObject({ category: 'po_mismatch' });
    expect(c.outcome.reason).toContain('exceeds PO by 350.00, tolerance is 50.00');
  });

  it('proposes an invoice within tolerance', async () => {
    const c = await decide({ vendor_id: V.brightline, vendor_name: 'Brightline Cloud Hosting', po_number: 'PO-1003', amount: 3640, line_items: [{ quantity: 1, unit_price: 3640 }] });
    expect(c.state).toBe('awaiting_approval');
  });

  it('escalates a suspended vendor even when everything else matches', async () => {
    const c = await decide({ vendor_id: V.sterling, vendor_name: 'Sterling Security Systems', po_number: 'PO-1017', amount: 7800, line_items: [{ quantity: 1, unit_price: 7800 }] });
    expect(c.outcome).toMatchObject({ decision: 'escalate_to_human', category: 'vendor_not_active' });
  });

  it('escalates a pending (not onboarded) vendor', async () => {
    const c = await decide({ vendor_id: V.nova, vendor_name: 'Nova Data Analytics GmbH', po_number: 'PO-1019', amount: 2500, currency: 'EUR', line_items: [{ quantity: 1, unit_price: 2500 }] });
    expect(c.outcome).toMatchObject({ category: 'vendor_not_active' });
  });

  it('escalates an unknown vendor and never emails it, even with fields missing', async () => {
    const c = await decide({ vendor_id: undefined, vendor_name: 'Totally Legit Supplies', due_date: undefined });
    expect(c.outcome).toMatchObject({ decision: 'escalate_to_human', category: 'unknown_vendor' });
  });

  it('escalates a vendor name that does not match the vendor_id', async () => {
    const c = await decide({ vendor_name: 'Northwind Office' });
    expect(c.outcome).toMatchObject({ category: 'vendor_mismatch' });
  });

  it('escalates anything above 50,000 to the finance director', async () => {
    const c = await decide({ vendor_id: V.harbour, vendor_name: 'Harbour Logistics plc', po_number: 'PO-1008', amount: 61000, line_items: [{ quantity: 1, unit_price: 61000 }] });
    expect(c.outcome.blockers_at_decision.map((b: { code: string }) => b.code)).toContain('over_approval_limit');
    expect(c.state).toBe('escalated');
  });

  it('marks proposals above 10,000 for a finance manager', async () => {
    const c = await decide({ vendor_id: V.brightline, vendor_name: 'Brightline Cloud Hosting', po_number: 'PO-1004', amount: 14400, line_items: [{ quantity: 12, unit_price: 1200 }] });
    expect(c.outcome).toMatchObject({ decision: 'propose_payment', required_role: 'finance_manager' });
  });

  it('escalates a currency mismatch and a closed PO', async () => {
    const usd = await decide({ vendor_id: V.pinecrest, vendor_name: 'Pinecrest IT Services', po_number: 'PO-1012', amount: 780, line_items: [{ quantity: 1, unit_price: 780 }] });
    expect(usd.outcome.reason).toMatch(/currency mismatch/);
    const closed = await decide({ po_number: 'PO-1002', amount: 480.5, line_items: [{ quantity: 1, unit_price: 480.5 }] });
    expect(closed.outcome.reason).toMatch(/PO is closed/);
  });

  it('escalates the second invoice with the same number from the same vendor', async () => {
    const first = invoice();
    await createCase(pool, first, 'awaiting_approval');
    const c = await decide({ invoice_number: first.invoice_number });
    expect(c.outcome).toMatchObject({ category: 'suspected_duplicate' });
  });
});
