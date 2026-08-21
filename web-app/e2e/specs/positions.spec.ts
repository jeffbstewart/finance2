// E2E spec for PositionsPage + BuyDialog + HoldingDialog
// (docs/design/ui-testing.md, inventory "PositionsPage"). The seeded
// portfolio gives every branch a home: Brokerage is taxable with lots,
// Roth IRA is tax-deferred with holdings (manual + plaid provenance),
// EUR Brokerage prices in euros, and Closed Account is empty.
import { expect, test, type Page } from '@playwright/test';
import {
  acceptConfirms,
  expectSnackbar,
  fillField,
  pickSelect,
  readTable,
  seedPortfolio,
} from '../support/material';

let ids: Record<string, bigint>;

test.beforeEach(async () => {
  ids = await seedPortfolio();
});

/** The positions page scoped to a seeded account key. */
async function gotoAccount(page: Page, key: string): Promise<void> {
  await page.goto(`/app/positions?account=${ids[key]}`);
}

/** A cell from the positions table, polled so a post-mutation reload
 *  is awaited rather than raced. */
async function cellFor(page: Page, ticker: string, column: number): Promise<string | undefined> {
  const table = await readTable(page);
  return table.rows.find((row) => row[0].startsWith(ticker))?.[column];
}

/** The ticker cell also carries the provenance chip ("VTImanual"), so
 *  rows are matched by prefix rather than by equality. */
function rowFor(rows: string[][], ticker: string): string[] {
  const row = rows.find((r) => r[0].startsWith(ticker));
  if (!row) throw new Error(`no ${ticker} row in ${JSON.stringify(rows.map((r) => r[0]))}`);
  return row;
}

function tickersOf(rows: string[][]): string[] {
  return rows.map((row) => /^[A-Z]+/.exec(row[0])?.[0] ?? row[0]);
}

/** Column order: Ticker, Trend, Shares, Basis, Current Value, ST, LT. */
const TICKER = 0;
const SHARES = 2;
const BASIS = 3;
const VALUE = 4;

test('portfolio-wide list shows every held security with footer totals', async ({ page }) => {
  await page.goto('/app/positions');
  await expect(page.locator('mat-card-title')).toHaveText('Positions in All Accounts');
  // No scope: no subtitle detail and no edit-account button.
  await expect(page.getByRole('button', { name: 'Edit account' })).toHaveCount(0);

  const table = await readTable(page);
  expect(table.header.slice(0, 7)).toEqual([
    'Ticker', 'Trend', 'Shares', 'Basis', 'Current Value', 'ST Gain', 'LT Gain',
  ]);
  expect(tickersOf(table.rows).sort()).toEqual(['BONDX', 'EUFUND', 'GOLD', 'VTI']);

  // VTI aggregates the two Brokerage lots (19 + 16 still held) with the
  // Roth holding (12), priced off the pinned final bar of $201.90.
  expect(rowFor(table.rows, 'VTI')[SHARES]).toBe('47');
  expect(rowFor(table.rows, 'VTI')[VALUE]).toBe('$9,489.30');
  expect(rowFor(table.rows, 'BONDX')[SHARES]).toBe('100');
  expect(rowFor(table.rows, 'BONDX')[VALUE]).toBe('$1,050.00');
  // Holdings rows have no lots, hence no basis.
  expect(rowFor(table.rows, 'GOLD')[SHARES]).toBe('5');
  expect(rowFor(table.rows, 'GOLD')[BASIS]).toBe('$0.00');
  expect(rowFor(table.rows, 'GOLD')[VALUE]).toBe('$16,792.50');
  // Row amounts stay in the security's own currency (build-scope §5).
  expect(rowFor(table.rows, 'EUFUND')[VALUE]).toBe('€10,400.00');

  expect(table.footer[TICKER]).toBe('Total');
  expect(table.footer[VALUE]).toMatch(/^\$[\d,]+\.\d\d$/);
  await expect(page.locator('.empty-note')).toHaveCount(0);
});

// BUG: FUNCTIONAL_SPEC §9.6 requires "Default sort: current value
// descending" for the all-positions list (PositionsPage's own docstring
// repeats the claim), but neither ListPositions nor the page sorts —
// rows arrive in lot/holding insertion order. GOLD is the most valuable
// position and still is not first. Pinning current behavior.
test('portfolio-wide list is NOT sorted by current value descending', async ({ page }) => {
  await page.goto('/app/positions');
  const table = await readTable(page);
  expect(tickersOf(table.rows)[0]).not.toBe('GOLD');
  const money = (s: string) => Number(s.replace(/[^0-9.]/g, ''));
  const values = table.rows.map((row) => money(row[VALUE]));
  const descending = [...values].sort((a, b) => b - a);
  expect(values).not.toEqual(descending);
});

test('a taxable account scope titles, subtitles, and filters the list', async ({ page }) => {
  await gotoAccount(page, 'account.brokerage');
  await expect(page.locator('mat-card-title')).toHaveText('Positions at Vanguard : Brokerage');
  const subtitle = page.locator('mat-card-subtitle');
  await expect(subtitle).toContainText('X-1 (USD)');
  await expect(subtitle).toContainText('Taxable');
  await expect(subtitle).toContainText('Sweeps: $500.00');

  const table = await readTable(page);
  expect(tickersOf(table.rows).sort()).toEqual(['BONDX', 'VTI']);
  expect(rowFor(table.rows, 'VTI')[SHARES]).toBe('35');

  // Ticker links carry the scope through to lot details.
  await expect(page.getByRole('link', { name: 'VTI' })).toHaveAttribute(
    'href',
    `/app/positions/${ids['security.vti']}?account=${ids['account.brokerage']}`,
  );
  await expect(page.getByRole('button', { name: 'Buy security' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit account' })).toBeVisible();
});

test('a tax-deferred account shows holdings with their provenance', async ({ page }) => {
  await gotoAccount(page, 'account.roth');
  await expect(page.locator('mat-card-title')).toHaveText('Positions at Vanguard : Roth IRA');
  const subtitle = page.locator('mat-card-subtitle');
  await expect(subtitle).toContainText('Tax Deferred');
  await expect(subtitle).toContainText('Sweeps: $55.25');

  const table = await readTable(page);
  expect(tickersOf(table.rows).sort()).toEqual(['GOLD', 'VTI']);
  // The provenance chip renders inside the ticker cell.
  expect(rowFor(table.rows, 'VTI')[TICKER]).toContain('manual');
  expect(rowFor(table.rows, 'GOLD')[TICKER]).toContain('plaid');
  expect(rowFor(table.rows, 'VTI')[SHARES]).toBe('12');

  // Tax-deferred accounts take holdings, not purchases.
  await expect(page.getByRole('button', { name: 'Set holding' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy security' })).toHaveCount(0);
});

test('the EUR account prices its position in euros', async ({ page }) => {
  await gotoAccount(page, 'account.eur');
  await expect(page.locator('mat-card-title')).toHaveText(
    'Positions at EuroBank : EUR Brokerage',
  );
  await expect(page.locator('mat-card-subtitle')).toContainText('X-3 (EUR)');
  const table = await readTable(page);
  expect(tickersOf(table.rows)).toEqual(['EUFUND']);
  expect(table.rows[0][SHARES]).toBe('100');
  expect(table.rows[0][VALUE]).toBe('€10,400.00');
});

test('an empty scoped account offers hide and delete', async ({ page }) => {
  await gotoAccount(page, 'account.closed');
  await expect(page.locator('.empty-note')).toHaveText('No positions yet.');
  await expect(page.getByRole('button', { name: 'Hide this empty account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete this empty account' })).toBeVisible();

  // Portfolio-wide there is nothing to hide or delete.
  await page.goto('/app/positions');
  await expect(page.getByRole('button', { name: 'Hide this empty account' })).toHaveCount(0);
});

test('deleting an empty account confirms and returns to the broker', async ({ page }) => {
  acceptConfirms(page);
  await gotoAccount(page, 'account.closed');
  await page.getByRole('button', { name: 'Delete this empty account' }).click();
  await expectSnackbar(page, 'Account deleted');
  await expect(page).toHaveURL(new RegExp(`/app/brokers/${ids['broker.vanguard']}$`));
});

test('hiding an empty account returns to the broker', async ({ page }) => {
  await gotoAccount(page, 'account.closed');
  await page.getByRole('button', { name: 'Hide this empty account' }).click();
  await expectSnackbar(page, 'Account hidden');
  await expect(page).toHaveURL(new RegExp(`/app/brokers/${ids['broker.vanguard']}$`));
});

test('the buy dialog omits tax-deferred accounts and records a purchase', async ({ page }) => {
  await page.goto('/app/positions');
  await page.getByRole('button', { name: 'Buy security' }).click();
  await expect(page.getByRole('heading', { name: 'Purchase Security' })).toBeVisible();
  await expect(page.getByText('If you paid no commission, enter 0 here.')).toBeVisible();

  // Tax-deferred accounts don't take lot purchases (build-scope §1).
  await page.getByRole('combobox', { name: 'Account' }).click();
  const options = await page.getByRole('option').allInnerTexts();
  expect(options.map((o) => o.trim())).toEqual([
    'Vanguard : Brokerage (USD)',
    'EuroBank : EUR Brokerage (EUR)',
  ]);
  await page.getByRole('option', { name: 'Vanguard : Brokerage (USD)' }).click();

  await pickSelect(page, 'Security', 'BONDX: Aggregate Bond Fund');
  const today = new Date();
  await fillField(
    page,
    'Date',
    `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`,
  );
  await fillField(page, 'Shares', '40');
  await fillField(page, 'Price Per Share', '10.25');
  await fillField(page, 'Commission', '0');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expectSnackbar(page, 'Purchase recorded');
  // The BONDX lot from the seeder (100 sh) plus the 40 just bought.
  await expect.poll(() => cellFor(page, 'BONDX', SHARES)).toBe('140');
});

test('Submit stays disabled until the buy form is complete', async ({ page }) => {
  await gotoAccount(page, 'account.brokerage');
  await page.getByRole('button', { name: 'Buy security' }).click();
  const submit = page.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeDisabled();

  const today = new Date();
  await fillField(
    page,
    'Date',
    `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`,
  );
  await pickSelect(page, 'Security', 'VTI: Total Market ETF');
  await fillField(page, 'Shares', '1');
  await fillField(page, 'Price Per Share', '200');
  await expect(submit).toBeDisabled(); // commission is required
  await fillField(page, 'Commission', '0');
  await expect(submit).toBeEnabled();

  // Negative and exponent forms are not plain decimals.
  await fillField(page, 'Shares', '-1');
  await expect(submit).toBeDisabled();
  await fillField(page, 'Shares', '1e3');
  await expect(submit).toBeDisabled();
  await fillField(page, 'Shares', '1.5');
  await expect(submit).toBeEnabled();
});

test('cancelling the buy dialog leaves the list unchanged', async ({ page }) => {
  await gotoAccount(page, 'account.brokerage');
  const before = await readTable(page);
  await page.getByRole('button', { name: 'Buy security' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Purchase Security' })).toHaveCount(0);
  const after = await readTable(page);
  expect(after.rows).toEqual(before.rows);
});

test('the holding dialog sets a tax-deferred position', async ({ page }) => {
  await gotoAccount(page, 'account.roth');
  await page.getByRole('button', { name: 'Set holding' }).click();
  await expect(page.getByRole('heading', { name: 'Set Holding — Roth IRA' })).toBeVisible();

  const submit = page.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeDisabled();
  await pickSelect(page, 'Security', 'BONDX: Aggregate Bond Fund');
  await fillField(page, 'Shares Held', '7');
  await expect(submit).toBeEnabled();
  await submit.click();

  await expectSnackbar(page, 'Holding saved');
  await expect.poll(() => cellFor(page, 'BONDX', SHARES)).toBe('7');
  // Holdings written through the UI carry manual provenance.
  await expect.poll(() => cellFor(page, 'BONDX', TICKER)).toContain('manual');
});

// BUG: HoldingDialog's docstring and the UI inventory both say
// "quantity 0 deletes" the holding, and the dialog's validator accepts
// "0" — but SetHolding rejects any non-positive quantity, so the only
// thing 0 produces is an error snackbar. There is a DeleteHolding RPC
// the dialog never calls. Pinning current behavior.
test('quantity 0 is accepted by the form but rejected by the server', async ({ page }) => {
  await gotoAccount(page, 'account.roth');
  await page.getByRole('button', { name: 'Set holding' }).click();
  await pickSelect(page, 'Security', 'VTI: Total Market ETF');
  await fillField(page, 'Shares Held', '0');
  const submit = page.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expectSnackbar(page, 'quantity must be positive; delete the holding to remove it');
  // The dialog stays open so the entry can be corrected.
  await expect(page.getByRole('heading', { name: 'Set Holding — Roth IRA' })).toBeVisible();
});

test('the edit-account dialog opens preloaded from the scoped account', async ({ page }) => {
  await gotoAccount(page, 'account.brokerage');
  await page.getByRole('button', { name: 'Edit account' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Account' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Account Name' })).toHaveValue('Brokerage');
  await expect(page.getByRole('textbox', { name: 'Account Number' })).toHaveValue('X-1');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Account' })).toHaveCount(0);
});
