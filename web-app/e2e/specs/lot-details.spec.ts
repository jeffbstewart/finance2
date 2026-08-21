// E2E spec for LotDetailsPage + SellDialog (docs/design/ui-testing.md,
// inventory "LotDetailsPage"). The seeded VTI ledger in Vanguard :
// Brokerage is two open lots (30 @ $150 less 11 sold, 20 @ $180 less 4
// sold) against 220 pinned daily bars ending at $201.90, plus the two
// seeded sales; BONDX is the sale-free lot used for the delete path.
import { expect, test, type Page } from '@playwright/test';
import { acceptConfirms, expectSnackbar, readTable, seedPortfolio, setToggle } from '../support/material';

const thisYear = new Date().getFullYear();
const lastYear = thisYear - 1;

const LOT_HEADER = [
  '', 'Bought', 'Shares', 'Buy $/Share', 'Now $/Share', 'Comm.',
  'Still Held', 'Basis', 'Current Value', 'ST Gain', 'LT Gain', '',
];

let ids: Record<string, bigint>;

test.beforeEach(async () => {
  ids = await seedPortfolio();
});

/** `/app/positions/:security`, optionally scoped to an account. */
function lotUrl(security: bigint, account?: bigint): string {
  return account === undefined
    ? `/app/positions/${security}`
    : `/app/positions/${security}?account=${account}`;
}

/** Splits a lot row into ST/LT gain, whichever side the clock puts it on. */
function gains(row: string[]): { zero: string; gain: string } {
  const [st, lt] = [row[row.length - 3], row[row.length - 2]];
  return st === '$0.00' ? { zero: st, gain: lt } : { zero: lt, gain: st };
}

async function checkLot(page: Page, index: number): Promise<void> {
  const box = page.getByRole('checkbox', { name: 'Select lot' }).nth(index);
  await box.check();
  await expect(box).toBeChecked();
}

/** Retrying row count for the table at `index`; readTable is a one-shot
 *  read, so wait on the shape first after any mutation. */
function bodyRows(page: Page, index: number) {
  return page.locator('table[mat-table]').nth(index).locator('tr[mat-row]');
}

test('scoped view lists the account lots with basis, value and gain', async ({ page }) => {
  await page.goto(lotUrl(ids['security.vti'], ids['account.brokerage']));
  await expect(page.locator('mat-card-title')).toHaveText(
    'Positions for VTI in Vanguard : Brokerage',
  );

  const lots = await readTable(page, 0);
  expect(lots.header).toEqual(LOT_HEADER);
  expect(lots.rows).toHaveLength(2);

  // 30 bought at $150 + $5 commission, 11 shares consumed by the two
  // seeded sales: 19 still held, $5 costs pro-rated 6/5/19 → $3.1667.
  const [older, newer] = lots.rows;
  expect(older.slice(0, 9)).toEqual([
    '', `${lastYear - 1}-03-01`, '30', '$150.00', '$201.90', '$5.00', '19',
    '$2,853.1667', '$3,836.10',
  ]);
  expect(gains(older)).toEqual({ zero: '$0.00', gain: '$982.9333' });

  // 20 bought at $180 + $5, 4 sold: 16 held, $4.00 of costs, no rounding
  // remainder — basis is exactly 16 × $180 + $4.
  expect(newer.slice(0, 9)).toEqual([
    '', `${lastYear}-01-20`, '20', '$180.00', '$201.90', '$5.00', '16',
    '$2,884.00', '$3,230.40',
  ]);
  expect(gains(newer)).toEqual({ zero: '$0.00', gain: '$346.40' });
});

test('unscoped view adds the Account column and titles for all accounts', async ({ page }) => {
  await page.goto(lotUrl(ids['security.vti']));
  await expect(page.locator('mat-card-title')).toHaveText('Positions for VTI in All Accounts');
  const lots = await readTable(page, 0);
  expect(lots.header).toEqual(['', 'Account', ...LOT_HEADER.slice(1)]);
  expect(lots.rows.map((row) => row[1])).toEqual(['Brokerage', 'Brokerage']);
});

test('the sale history lists both seeded sales', async ({ page }) => {
  await page.goto(lotUrl(ids['security.vti'], ids['account.brokerage']));
  await expect(page.locator('h3.section-title')).toHaveText('Sale History');
  const sales = await readTable(page, 1);
  expect(sales.header).toEqual([
    'Sold', 'Shares', '$/Share', 'Sale Costs', 'ST Gain', 'LT Gain', '',
  ]);
  expect(sales.rows).toHaveLength(2);
  // 6 LT + 4 ST shares at $190 less $9 of costs (the tax report's
  // documented LT $233.60 / ST $35.40).
  expect(sales.rows[0].slice(0, 6)).toEqual([
    `${lastYear}-06-15`, '10', '$190.00', '$9.00', '$35.40', '$233.60',
  ]);
  // 5 more from the long-term lot at $200, no sale costs.
  expect(sales.rows[1].slice(1, 6)).toEqual(['5', '$200.00', '$0.00', '$0.00', '$249.1667']);
});

test('a ticker with no sales shows no sale-history table', async ({ page }) => {
  await page.goto(lotUrl(ids['security.bondx'], ids['account.brokerage']));
  const lots = await readTable(page, 0);
  expect(lots.rows).toHaveLength(1);
  // 100 @ $10.00 with no commission, marked at the latest private price.
  expect(lots.rows[0].slice(2, 11)).toEqual([
    '100', '$10.00', '$10.50', '$0.00', '100', '$1,000.00', '$1,050.00', '$50.00', '$0.00',
  ]);
  await expect(page.locator('table[mat-table]')).toHaveCount(1);
  await expect(page.locator('h3.section-title')).toHaveCount(0);
});

test('the inflation toggle daggers the cost columns and adds the footnote', async ({ page }) => {
  await page.goto(lotUrl(ids['security.vti'], ids['account.brokerage']));
  await expect(page.locator('p.footnote')).toHaveCount(0);
  const before = await readTable(page, 0);
  expect(before.header.filter((h) => h.includes('†'))).toEqual([]);

  await setToggle(page, 'Adjust costs for inflation', true);
  await expect(page.locator('p.footnote')).toHaveText("† restated in today's dollars via CPI");
  const after = await readTable(page, 0);
  expect(after.header.filter((h) => h.includes('†'))).toEqual([
    'Buy $/Share †', 'Comm. †', 'Basis †', 'ST Gain †', 'LT Gain †',
  ]);
  // Current prices are never restated; costs are.
  expect(after.rows[0][4]).toBe('$201.90');
  expect(after.rows[0][8]).toBe('$3,836.10');
  expect(Number(after.rows[0][7].replace(/[$,]/g, ''))).toBeGreaterThanOrEqual(2853.1667);

  await setToggle(page, 'Adjust costs for inflation', false);
  await expect(page.locator('p.footnote')).toHaveCount(0);
  expect((await readTable(page, 0)).rows[0][7]).toBe('$2,853.1667');
});

test('Sell stays disabled until a lot is checked', async ({ page }) => {
  await page.goto(lotUrl(ids['security.vti'], ids['account.brokerage']));
  const sell = page.getByRole('button', { name: 'Sell', exact: false });
  await expect(sell).toBeDisabled();
  await checkLot(page, 0);
  await expect(sell).toBeEnabled();
  await page.getByRole('checkbox', { name: 'Select lot' }).first().uncheck();
  await expect(sell).toBeDisabled();
});

test('the sell stepper records a sale and the page picks it up', async ({ page }) => {
  await page.goto(lotUrl(ids['security.vti'], ids['account.brokerage']));
  await checkLot(page, 0);
  await page.getByRole('button', { name: 'Sell', exact: false }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Sell VTI');
  await expect(dialog).toContainText('Vanguard : Brokerage');

  const today = new Date();
  await dialog
    .getByRole('textbox', { name: 'Sale Date' })
    .fill(`${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`);
  await dialog.getByRole('textbox', { name: 'Shares to Sell' }).fill('4');
  await dialog.getByRole('textbox', { name: 'Price Per Share' }).fill('210');
  await dialog.getByRole('textbox', { name: 'Commission' }).fill('0');
  await dialog.getByRole('button', { name: 'Next' }).click();

  // Step 2 opens with the sum-to-total complaint until a lot is picked.
  await expect(dialog.locator('p.validation-error')).toHaveText(
    'Per-lot shares must sum to 4',
  );
  await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Sell Shares' }).fill('4');
  await expect(dialog.locator('p.validation-error')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Next' }).click();

  await expect(dialog).toContainText('Sell 4 shares of VTI at 210 per share');
  await expect(dialog).toContainText('from 1 lot.');
  await dialog.getByRole('button', { name: 'Sell Lots' }).click();

  await expectSnackbar(page, 'Sale recorded');
  await expect(bodyRows(page, 1)).toHaveCount(3);
  const lots = await readTable(page, 0);
  expect(lots.rows[0][6]).toBe('15'); // 19 − 4 still held
  const sales = await readTable(page, 1);
  expect(sales.rows.map((row) => row[2])).toContain('$210.00');
  // The reload clears the selection, so Sell is disabled again.
  await expect(page.getByRole('button', { name: 'Sell', exact: false })).toBeDisabled();
});

test('the sell stepper caps a pick at the lot still held', async ({ page }) => {
  await page.goto(lotUrl(ids['security.vti'], ids['account.brokerage']));
  await checkLot(page, 0);
  await page.getByRole('button', { name: 'Sell', exact: false }).click();

  const dialog = page.getByRole('dialog');
  const today = new Date();
  await dialog
    .getByRole('textbox', { name: 'Sale Date' })
    .fill(`${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`);
  await dialog.getByRole('textbox', { name: 'Shares to Sell' }).fill('25');
  await dialog.getByRole('textbox', { name: 'Price Per Share' }).fill('210');
  await dialog.getByRole('textbox', { name: 'Commission' }).fill('0');
  await dialog.getByRole('button', { name: 'Next' }).click();

  await dialog.getByRole('textbox', { name: 'Sell Shares' }).fill('25');
  await expect(dialog.locator('p.validation-error')).toHaveText(
    `Lot bought ${lastYear - 1}-03-01: only 19 still held`,
  );
  await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect((await readTable(page, 1)).rows).toHaveLength(2); // nothing recorded
});

test('deleting a seeded sale returns its shares to the lots', async ({ page }) => {
  acceptConfirms(page);
  await page.goto(lotUrl(ids['security.vti'], ids['account.brokerage']));
  await page.getByRole('button', { name: 'Delete sale' }).first().click();
  await expectSnackbar(page, 'Sale deleted');
  await expect(bodyRows(page, 1)).toHaveCount(1);

  const lots = await readTable(page, 0);
  expect(lots.rows.map((row) => row[6])).toEqual(['25', '20']); // 19+6, 16+4
});

test('a lot with sales refuses to be deleted', async ({ page }) => {
  acceptConfirms(page);
  await page.goto(lotUrl(ids['security.vti'], ids['account.brokerage']));
  await page.getByRole('button', { name: 'Delete lot' }).first().click();
  await expectSnackbar(page, 'the lot has recorded sales; delete those first');
  expect((await readTable(page, 0)).rows).toHaveLength(2);
});

test('deleting the only sale-free lot empties the view', async ({ page }) => {
  acceptConfirms(page);
  await page.goto(lotUrl(ids['security.bondx'], ids['account.brokerage']));
  await page.getByRole('button', { name: 'Delete lot' }).click();
  await expectSnackbar(page, 'Lot deleted');
  await expect(page.locator('p.empty-note')).toHaveText('No lots for BONDX here.');
  // Scoped views never offer the hide-security shortcut.
  await expect(page.getByRole('button', { name: 'Hide this Security' })).toHaveCount(0);
});

test('an empty unscoped view offers to hide the security, and the server guards it', async ({
  page,
}) => {
  // GOLD's only position is the tax-deferred Roth holding, so the lot
  // ledger is empty but the security still has positions.
  await page.goto(lotUrl(ids['security.gold']));
  await expect(page.locator('p.empty-note')).toHaveText('No lots for GOLD here.');
  await page.getByRole('button', { name: 'Hide this Security' }).click();
  await expectSnackbar(page, 'the security still has positions');
  await expect(page).toHaveURL(new RegExp(`/app/positions/${ids['security.gold']}$`));
});

test('hiding a position-free security returns to the securities list', async ({ page }) => {
  acceptConfirms(page);
  // BONDX's single lot has no sales, so emptying its ledger leaves a
  // security the hide guard rail will accept.
  await page.goto(lotUrl(ids['security.bondx']));
  await page.getByRole('button', { name: 'Delete lot' }).click();
  await expect(page.locator('p.empty-note')).toHaveText('No lots for BONDX here.');

  await page.getByRole('button', { name: 'Hide this Security' }).click();
  await expectSnackbar(page, 'BONDX hidden');
  await expect(page).toHaveURL(/\/app\/securities$/);
  await expect(page.locator('table[mat-table]')).not.toContainText('BONDX');
});

test('the security details link carries the routed id', async ({ page }) => {
  await page.goto(lotUrl(ids['security.vti'], ids['account.brokerage']));
  await page
    .getByRole('link', { name: 'Security Details', exact: false })
    .click();
  await expect(page).toHaveURL(new RegExp(`/app/securities/${ids['security.vti']}$`));
});
