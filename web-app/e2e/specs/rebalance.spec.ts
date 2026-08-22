// E2E spec for RebalancePage + RebalanceBuyDialog
// (docs/design/ui-testing.md, inventory "RebalancePage"). Nothing here
// persists: every assertion is about the scorer's shopping list.
//
// The figures that are pinned exactly depend only on the seeder's
// prices and sweeps, never on the whole portfolio's value:
//   * Brokerage sweeps $500.00 fund the plan ("Still to Spend").
//   * BONDX's latest private price is $10.50, VTI's last pinned bar
//     is $201.90.
//   * With no added funds the scorer sizes the plan so the most
//     overweight non-Cash class reaches target. That is Other
//     (GOLD 5 x $3,358.50 against a 10% target - an order of
//     magnitude past every other class), so Other's residual is
//     exactly $0.00 and its buy affordance is disabled.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectSnackbar, fillField, pickSelect, readTable, seedPortfolio } from '../support/material';

const CLASS_NAMES = ['Cash', 'US Stock', 'Non US Stock', 'Bond', 'Other'];

test.beforeEach(async () => {
  await seedPortfolio();
});

/** The "Spent So Far" / "Still to Spend" read-only stat values. */
function stat(page: Page, label: string): Locator {
  return page.locator('.readonly-stat').filter({ hasText: label }).locator('.stat-value');
}

/** Rows of the allocation table; `tableIndex` is 1 once the cart
 *  table is on screen. Indexes match CLASS_NAMES. */
function classRow(page: Page, name: string, tableIndex = 0): Locator {
  return page
    .locator('table[mat-table]')
    .nth(tableIndex)
    .locator('tr[mat-row]')
    .nth(CLASS_NAMES.indexOf(name));
}

/** Picks the destination account and waits for the first score. */
async function scoreFromBrokerage(page: Page): Promise<void> {
  await page.goto('/app/allocation/rebalance');
  await pickSelect(page, 'Account', 'Vanguard : Brokerage');
  await expect(page.locator('table[mat-table]')).toHaveCount(1);
}

test('offers every visible account, tax-deferred included, and scores nothing first', async ({
  page,
}) => {
  await page.goto('/app/allocation/rebalance');
  await expect(page.locator('.empty-note')).toHaveText('Pick an account to score the plan.');
  await expect(page.locator('table[mat-table]')).toHaveCount(0);
  await expect(page.locator('mat-card-title')).toHaveText('Rebalance');

  await page.getByRole('combobox', { name: 'Account' }).click();
  const options = page.getByRole('option');
  await expect(options).toHaveCount(3);
  // getPurchaseFormInfo does not filter tax-deferred accounts here - 
  // a rebalance may buy into the Roth IRA. Hidden accounts are gone.
  // Ordered by broker name, then account name - EuroBank first; the
  // EUR account's sweeps are shown in its own currency.
  await expect(options).toHaveText([
    /EuroBank : EUR Brokerage - sweeps .?250\.00/,
    'Vanguard : Brokerage - sweeps $500.00',
    'Vanguard : Roth IRA - sweeps $55.25',
  ]);
});

test('scores the seeded plan in buy-only mode', async ({ page }) => {
  await scoreFromBrokerage(page);
  await expect(page.locator('.empty-note')).toHaveCount(0);

  const table = await readTable(page, 0);
  expect(table.header).toEqual(['Name', 'Before', 'After', 'Target', 'Residual Imbalance', '']);
  expect(table.rows.map((row) => row[0])).toEqual(CLASS_NAMES);
  // The seeded target allocation: 10 / 40 / 20 / 20 / 10.
  expect(table.rows.map((row) => row[3])).toEqual(['10%', '40%', '20%', '20%', '10%']);
  // Buy-only mode: the plan is sized so the most overweight class
  // exactly reaches target, so Other's After lands on its 10% target
  // with a zero residual. (Before and After are fractions of
  // different totals - the current one and the plan's - so they do
  // not agree even with an empty cart.)
  const other = table.rows[CLASS_NAMES.indexOf('Other')];
  expect(other[2]).toBe('10%');
  expect(other[4]).toBe('$0.00');

  await expect(stat(page, 'Spent So Far')).toHaveText('$0.00');
  await expect(stat(page, 'Still to Spend')).toHaveText('$500.00');
  await expect(page.locator('mat-hint')).toHaveText('0 = buy-only mode');
});

test('disables the buy affordance at target and where no fund is concentrated', async ({ page }) => {
  await scoreFromBrokerage(page);
  const buy = (name: string) => classRow(page, name).getByRole('button', { name: 'Propose purchase' });
  // No seeded security carries any Cash weight, so Cash has no
  // candidate funds even though it is under target.
  await expect(buy('Cash')).toBeDisabled();
  await expect(buy('Other')).toBeDisabled();
  await expect(buy('US Stock')).toBeEnabled();
  await expect(buy('Non US Stock')).toBeEnabled();
  await expect(buy('Bond')).toBeEnabled();
});

test('re-scores when funds are added and skips an invalid amount silently', async ({ page }) => {
  await scoreFromBrokerage(page);
  await expect(stat(page, 'Still to Spend')).toHaveText('$500.00');

  await fillField(page, 'Add Funds to Sweeps', '10000');
  await page.getByRole('textbox', { name: 'Add Funds to Sweeps' }).press('Enter');
  await expect(stat(page, 'Still to Spend')).toHaveText('$10,500.00');

  // A non-decimal amount never reaches the server: the previous score
  // stays on screen, with no error and no validation message.
  await fillField(page, 'Add Funds to Sweeps', 'lots');
  await page.getByRole('textbox', { name: 'Add Funds to Sweeps' }).blur();
  await expect(stat(page, 'Still to Spend')).toHaveText('$10,500.00');
  await expect(page.locator('mat-error')).toHaveCount(0);
  await expect(page.locator('mat-snack-bar-container')).toHaveCount(0);

  await fillField(page, 'Add Funds to Sweeps', '0');
  await page.getByRole('textbox', { name: 'Add Funds to Sweeps' }).press('Enter');
  await expect(stat(page, 'Still to Spend')).toHaveText('$500.00');
});

test('builds a cart through the buy dialog and re-scores with it', async ({ page }) => {
  await scoreFromBrokerage(page);
  await classRow(page, 'Bond').getByRole('button', { name: 'Propose purchase' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Propose Security Purchase for Rebalance');
  // Only the security select shows until a candidate is picked.
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Add to Plan' })).toBeDisabled();

  await dialog.getByRole('combobox', { name: 'Security' }).click();
  await expect(page.getByRole('option')).toHaveText(['BONDX - 100% in Bond']);
  await page.getByRole('option', { name: 'BONDX' }).click();

  const price = dialog.getByRole('textbox', { name: 'Price Per Share' });
  await expect(price).toHaveValue('$10.50');
  await expect(price).toHaveJSProperty('readOnly', true);
  // The server's suggestion auto-fills; its size depends on the whole
  // portfolio, so only its shape is pinned here.
  const shares = dialog.getByRole('textbox', { name: 'Shares', exact: true });
  await expect(shares).not.toHaveValue('');

  // Net Cost and Shares recompute through the read-only price.
  const beforeTrade = await readTable(page, 0);
  await dialog.getByRole('textbox', { name: 'Net Cost' }).fill('105');
  await expect(shares).toHaveValue('10');
  await dialog.getByRole('button', { name: 'Add to Plan' }).click();

  await expect(page.locator('table[mat-table]')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Rebalance Purchases' })).toBeVisible();
  const cart = await readTable(page, 0);
  expect(cart.header).toEqual(['Ticker', 'Buy Shares', 'Cost', '']);
  expect(cart.rows).toHaveLength(1);
  expect(cart.rows[0].slice(0, 3)).toEqual(['BONDX', '10', '105']);

  await expect(stat(page, 'Spent So Far')).toHaveText('$105.00');
  await expect(stat(page, 'Still to Spend')).toHaveText('$395.00');
  // The planned buy moved Bond's After fraction.
  const scored = await readTable(page, 1);
  const bondIndex = CLASS_NAMES.indexOf('Bond');
  expect(scored.rows[bondIndex][2]).not.toBe(beforeTrade.rows[bondIndex][2]);

  await page.getByRole('button', { name: 'Remove from plan' }).click();
  await expect(page.locator('table[mat-table]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Rebalance Purchases' })).toHaveCount(0);
  await expect(stat(page, 'Spent So Far')).toHaveText('$0.00');
  await expect(stat(page, 'Still to Spend')).toHaveText('$500.00');
});

test('cancelling the buy dialog leaves the plan untouched', async ({ page }) => {
  await scoreFromBrokerage(page);
  await classRow(page, 'Bond').getByRole('button', { name: 'Propose purchase' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Security' }).click();
  await page.getByRole('option', { name: 'BONDX' }).click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('table[mat-table]')).toHaveCount(1);
  await expect(stat(page, 'Spent So Far')).toHaveText('$0.00');
});

test('a whole-share security priced by net cost is rejected by the scorer', async ({ page }) => {
  await scoreFromBrokerage(page);
  await classRow(page, 'US Stock').getByRole('button', { name: 'Propose purchase' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Security' }).click();
  await page.getByRole('option', { name: 'VTI' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Price Per Share' })).toHaveValue('$201.90');

  // Exact decimal division, truncated to 8 places: 100 / 201.90.
  await dialog.getByRole('textbox', { name: 'Net Cost' }).fill('100');
  await expect(dialog.getByRole('textbox', { name: 'Shares', exact: true })).toHaveValue(
    '0.4952947',
  );
  await dialog.getByRole('button', { name: 'Add to Plan' }).click();

  // BUG: the dialog offers a Net Cost field for every candidate, but
  // only mutual funds are bought in dollar amounts - VTI is an ETF, so
  // the server rejects the fractional-share trade. The rejected trade
  // stays in the cart alongside a score that never saw it.
  await expectSnackbar(page, 'whole shares');
  await expect(page.locator('table[mat-table]')).toHaveCount(2);
  const cart = await readTable(page, 0);
  expect(cart.rows[0].slice(0, 3)).toEqual(['VTI', '0.4952947', '100']);
  await expect(stat(page, 'Spent So Far')).toHaveText('$0.00');
});
