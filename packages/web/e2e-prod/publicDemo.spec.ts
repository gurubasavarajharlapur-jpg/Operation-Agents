// What a reviewer does on the public URL: no token, no terminal.
import { expect, test } from '@playwright/test';

const shots = process.env.SCREENSHOT_DIR;

test('a visitor tries the public demo end to end', async ({ page }) => {
  await page.goto('/');
  if (shots) await page.screenshot({ path: `${shots}/demo-sign-in.png` });
  await page.getByRole('button', { name: 'Try as an operations reviewer' }).click();
  await expect(page.getByTestId('demo-hint')).toBeVisible(); // lands on the Overview
  await page.getByRole('navigation').getByRole('link', { name: 'Cases' }).click();

  await expect(page.getByTestId('demo-banner')).toContainText('payments are simulated');
  await expect(page.getByTestId('demo-banner')).toContainText('rules-only engine');

  // Send two sample invoices from the dashboard
  const panel = page.getByTestId('demo-panel');
  await panel.getByLabel('Send a sample invoice').selectOption('mismatch');
  await expect(panel).toContainText('Expected: Escalated');
  await panel.getByRole('button', { name: 'Send invoice' }).click();
  await expect(panel).toContainText('Sent.');
  await panel.getByLabel('Send a sample invoice').selectOption('finance');
  await panel.getByRole('button', { name: 'Send invoice' }).click();

  // The worker (in the same process, as ops_worker) decides them; the list updates by itself
  // Newest first: the two rows just sent are on top (the test database also holds older runs).
  const rows = page.getByTestId('cases-table').locator('tbody tr');
  const big = rows.nth(0);
  await expect(big).toContainText('£14,400.00');
  await expect(rows.nth(1)).toContainText('£3,950.00');
  await expect(big.getByTestId('state-badge')).toHaveText('Awaiting approval', { timeout: 20_000 });
  await expect(rows.nth(1).getByTestId('state-badge')).toHaveText('Escalated', { timeout: 20_000 });
  if (shots) await page.screenshot({ path: `${shots}/demo-cases.png`, fullPage: true });

  // An operations reviewer cannot approve 14,400...
  await big.click();
  await expect(page.getByRole('button', { name: 'Approve payment' })).toBeDisabled();
  const caseUrl = page.url();

  // ...a finance manager can
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: /Try as a finance manager/ }).click();
  await expect(page.getByText('Finance manager', { exact: true })).toBeVisible(); // signed in
  await page.goto(caseUrl); // deep link to a client-side route: the server must return the app
  await page.getByRole('button', { name: 'Approve payment' }).click();
  await expect(page.getByTestId('state-badge').first()).toHaveText('Completed', { timeout: 20_000 });
  await expect(page.locator('[data-action="approval.approved"]')).toContainText('Approved by Demo finance manager');
  await expect(page.getByTestId('chain-status')).toContainText('Audit chain intact');
});

test('a simulated outage: retries with backoff, dead letter, then a manual retry succeeds', async ({ page }) => {
  test.setTimeout(150_000); // 4 real attempts with real backoff (about 5s, 10s, 20s)
  await page.goto('/');
  await page.getByRole('button', { name: 'Try as an operations reviewer' }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Cases' }).click();

  const panel = page.getByTestId('demo-panel');
  await panel.getByLabel('Send a sample invoice').selectOption('happy');
  await panel.getByLabel('Simulate a failure').selectOption('never_recovers');
  await panel.getByRole('button', { name: 'Send invoice' }).click();
  await expect(panel).toContainText('permanent outage');

  const row = page.getByTestId('cases-table').locator('tbody tr').first();
  await expect(row.getByTestId('state-badge')).toContainText('Retrying · attempt 2 of 4', { timeout: 20_000 });
  if (shots) await page.screenshot({ path: `${shots}/retrying.png`, fullPage: false });
  await expect(row.getByTestId('state-badge')).toHaveText('Failed', { timeout: 90_000 });

  await row.click();
  await expect(page.getByText('Failed after 4 attempts', { exact: true })).toBeVisible();
  await expect(page.locator('[data-action="job.attempt_failed"]')).toHaveCount(4);
  await expect(page.locator('[data-action="job.dead_lettered"]')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/failed.png`, fullPage: true });

  // The outage is over: a manual retry goes through
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('state-badge').first()).toHaveText('Awaiting approval', { timeout: 20_000 });
  await expect(page.locator('[data-action="case.retried"]')).toContainText('Retried by Demo operator');
});

test('the overview counts move with the work, and every number links to the matching cases', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try as an operations reviewer' }).click();
  const overview = page.getByTestId('overview');
  await expect(overview).toBeVisible();
  const count = async () => Number((await page.getByTestId('tile-cases').locator('.tile-value').innerText()).replace(/,/g, ''));
  const before = await count();

  await page.getByRole('navigation').getByRole('link', { name: 'Cases' }).click();
  const panel = page.getByTestId('demo-panel');
  await panel.getByLabel('Send a sample invoice').selectOption('suspended');
  await panel.getByRole('button', { name: 'Send invoice' }).click();
  await expect(page.getByTestId('cases-table').locator('tbody tr').first().getByTestId('state-badge')).toHaveText('Escalated', { timeout: 20_000 });

  await page.getByRole('navigation').getByRole('link', { name: 'Overview' }).click();
  await expect.poll(count).toBe(before + 1);
  await expect(page.getByTestId('tile-chain')).toContainText('Intact');
  if (shots) await page.screenshot({ path: `${shots}/overview.png`, fullPage: true });

  // Click a bar: the case list opens, filtered to that escalation reason
  await page.getByTestId('categories').getByRole('button', { name: /Vendor not active/ }).click();
  await expect(page.getByTestId('filter-chip')).toContainText('Vendor not active');
  const rows = page.getByTestId('cases-table').locator('tbody tr');
  await expect(rows.first()).toContainText('Sterling Security Systems');
  for (const row of await rows.all()) await expect(row.getByTestId('state-badge')).toHaveText('Escalated');
});
