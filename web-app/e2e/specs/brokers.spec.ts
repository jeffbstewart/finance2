// Exemplar e2e spec (docs/design/ui-testing.md): seeded portfolio,
// real server, real browser, authenticated via the shared
// storageState. Per-page test agents copy this shape.
import { expect, test } from '@playwright/test';
import { readTable, seedPortfolio, setToggle } from '../support/material';

test.beforeEach(async () => {
  await seedPortfolio();
});

test('brokers list shows the seeded portfolio with totals', async ({ page }) => {
  await page.goto('/app/brokers');
  const table = await readTable(page);
  const names = table.rows.map((row) => row[0]);
  expect(names).toContain('Vanguard');
  expect(names).toContain('EuroBank');
  expect(names).not.toContain('Old Broker');
  expect(table.footer[0]).toBe('Total');
});

test('show-hidden reveals and unhides the hidden broker', async ({ page }) => {
  await page.goto('/app/brokers');
  await setToggle(page, 'Show hidden', true);
  await expect(page.getByRole('link', { name: 'Old Broker' })).toBeVisible();
});
