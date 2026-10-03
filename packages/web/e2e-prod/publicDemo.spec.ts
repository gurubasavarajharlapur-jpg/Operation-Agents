// What a reviewer does on the public URL: no token, no terminal.
import { expect, test } from '@playwright/test';

const shots = process.env.SCREENSHOT_DIR;

test('a visitor tries the public demo end to end', async ({ page }) => {
  await page.goto('/');
  if (shots) await page.screenshot({ path: `${shots}/demo-sign-in.png` });
  await page.getByRole('button', { name: 'Try as an operations reviewer' }).click();

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
