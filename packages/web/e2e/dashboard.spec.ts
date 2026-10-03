// The reviewer's journey through the dashboard, against real API + worker + database.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { createOperator } from '../../../testing/fixtures.ts';
import { testDatabaseUrl, testWorkerDatabaseUrl } from '../../../testing/testDb.ts';
import { E2E } from '../playwright.config.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const shots = process.env.SCREENSHOT_DIR; // set to save screenshots of each page

let worker: ChildProcess;
let pool: pg.Pool;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  worker = spawn('npm', ['run', 'start', '-w', '@oa/worker'], {
    cwd: repoRoot,
    env: { ...process.env, WORKER_DATABASE_URL: testWorkerDatabaseUrl(), AGENT_MODE: 'rules' },
    stdio: 'ignore',
    detached: true, // own process group, so afterAll can stop npm and the worker together
  });
});
test.afterAll(async () => {
  if (worker.pid) process.kill(-worker.pid, 'SIGTERM');
  await pool.end();
});

async function sendInvoice(invoice: Record<string, unknown>) {
  const body = JSON.stringify(invoice);
  const res = await fetch(`http://localhost:${E2E.apiPort}/webhooks/invoice`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `e2e-${crypto.randomUUID()}`,
      'x-signature': 'sha256=' + crypto.createHmac('sha256', E2E.webhookSecret).update(body).digest('hex'),
    },
    body,
  });
  expect(res.status).toBe(202);
  return (await res.json()).case_id as string;
}

const base = (overrides: Record<string, unknown> = {}) => ({
  invoice_number: `INV-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
  vendor_id: 'a1000000-0000-4000-8000-000000000001', vendor_name: 'Northwind Office Supplies Ltd',
  po_number: 'PO-1001', amount: 1250, currency: 'GBP', issue_date: '2026-09-20', due_date: '2026-10-20',
  line_items: [{ description: 'Office chairs', quantity: 5, unit_price: 250 }],
  ...overrides,
});

async function signIn(page: Page, token: string) {
  await page.goto('/');
  await page.getByLabel('Operator token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible(); // landing page
  await page.getByRole('navigation').getByRole('link', { name: 'Cases' }).click();
  await expect(page.getByRole('heading', { name: 'Cases', exact: true })).toBeVisible();
}

test('sign in, follow a case, approve it, and see it paid', async ({ page }) => {
  const operator = await createOperator(pool, 'operations');

  // A bad token is refused
  await page.goto('/');
  await page.getByLabel('Operator token').fill('op_not_a_real_token');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('not valid for an active operator')).toBeVisible();

  await signIn(page, operator.token);
  await expect(page.getByTestId('chain-status')).toContainText('Audit chain intact');

  // A few invoices arrive; the worker decides them
  const happy = base();
  const happyId = await sendInvoice(happy);
  await sendInvoice(base({ vendor_id: 'a1000000-0000-4000-8000-000000000002', vendor_name: 'Brightline Cloud Hosting', po_number: 'PO-1003', amount: 3950, line_items: [{ description: 'Hosting', quantity: 1, unit_price: 3950 }] }));
  await sendInvoice(base({ po_number: undefined, due_date: undefined }));
  const big = base({ vendor_id: 'a1000000-0000-4000-8000-000000000002', vendor_name: 'Brightline Cloud Hosting', po_number: 'PO-1004', amount: 14400, line_items: [{ description: 'Annual hosting', quantity: 12, unit_price: 1200 }] });
  await sendInvoice(big);

  // The list updates by itself
  const row = page.locator(`tr[data-case-id="${happyId}"]`);
  await expect(row.getByTestId('state-badge')).toHaveText('Awaiting approval', { timeout: 20_000 });
  await expect(row).toContainText('Rules-only (no LLM)');
  if (shots) await page.screenshot({ path: `${shots}/1-cases.png`, fullPage: true });

  // Case detail: decision and audit timeline
  await row.click();
  await expect(page.getByRole('heading', { name: happy.invoice_number })).toBeVisible();
  await expect(page.getByText('Payment proposed')).toBeVisible();
  await expect(page.getByText('All coded policy checks passed.')).toBeVisible();
  await expect(page.locator('[data-action="case.received"]')).toBeVisible();
  await expect(page.locator('[data-action="decision.propose_payment"]')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/2-case-detail.png`, fullPage: true });

  // Approvals inbox: the 14,400 payment needs a finance manager, so this operator cannot approve it
  await page.getByRole('link', { name: /Approvals/ }).click();
  const bigCard = page.getByTestId('approval-card').filter({ hasText: big.invoice_number as string });
  await expect(bigCard).toBeVisible({ timeout: 20_000 }); // the worker may still be deciding it; the inbox refreshes itself
  await expect(bigCard.getByRole('button', { name: 'Approve payment' })).toBeDisabled();
  await expect(bigCard).toContainText('Needs a finance manager');
  if (shots) await page.screenshot({ path: `${shots}/3-approvals.png`, fullPage: true });

  // Approve the 1,250 one
  const card = page.getByTestId('approval-card').filter({ hasText: happy.invoice_number });
  await card.getByRole('button', { name: 'Approve payment' }).click();
  await expect(card).toHaveCount(0);

  // The worker pays (simulated) and completes the case
  await page.goto(`/cases/${happyId}`);
  await expect(page.getByTestId('state-badge').first()).toHaveText('Completed', { timeout: 20_000 });
  await expect(page.getByText(/Paid \(simulated\)/)).toBeVisible();
  await expect(page.locator('[data-action="approval.approved"]')).toContainText('Approved by Test operations');
  await expect(page.locator('[data-action="payment.executed"]')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/4-case-paid.png`, fullPage: true });
});

test('rejecting requires a reason and escalates the case', async ({ page }) => {
  const operator = await createOperator(pool, 'finance_manager');
  const invoice = base();
  const caseId = await sendInvoice(invoice);
  await signIn(page, operator.token);

  await page.goto('/approvals');
  const card = page.getByTestId('approval-card').filter({ hasText: invoice.invoice_number });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(card.getByRole('button', { name: 'Reject payment' })).toBeDisabled(); // no reason yet
  await card.getByLabel('Why are you rejecting this payment?').fill('Goods were never delivered.');
  await card.getByRole('button', { name: 'Reject payment' }).click();

  await page.goto(`/cases/${caseId}`);
  await expect(page.getByTestId('state-badge').first()).toHaveText('Escalated', { timeout: 20_000 });
  await expect(page.getByText('Goods were never delivered.').first()).toBeVisible();
});
