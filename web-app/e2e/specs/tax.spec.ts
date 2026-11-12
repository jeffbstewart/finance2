// E2E spec for TaxPage (docs/design/ui-testing.md, inventory "TaxPage").
// The seeded lastYear VTI sale yields exactly LT $233.60 / ST $35.40,
// and the lastYear EUFUND mark lands in the PFIC table - both fall in
// the page's default previous-calendar-year range.
import { expect, test } from '@playwright/test';
import { fillField, readTable, seedPortfolio } from '../support/material';

const thisYear = new Date().getFullYear();
const lastYear = thisYear - 1;

test.beforeEach(async () => {
  await seedPortfolio();
});

test('defaults to the previous calendar year and shows the seeded sale', async ({ page }) => {
  await page.goto('/app/tax');
  await expect(page.getByRole('textbox', { name: 'From' })).toHaveValue(`1/1/${lastYear}`);
  await expect(page.getByRole('textbox', { name: 'To' })).toHaveValue(`12/31/${lastYear}`);

  const sales = await readTable(page, 0);
  expect(sales.header).toEqual([
    'Broker', 'Account', 'Ticker', 'Date Bought', 'Date Sold',
    'Purchase Price/Share', 'Sale Price/Share', 'Purchase Costs', 'Sale Costs',
    'Short Term Gain', 'Long Term Gain',
  ]);
  // One row per consumed lot: 6 sh from the LT lot, 4 sh from the ST lot.
  expect(sales.rows).toHaveLength(2);
  for (const row of sales.rows) {
    expect(row.slice(0, 3)).toEqual(['Vanguard', 'Brokerage', 'VTI']);
    expect(row[4]).toBe(`${lastYear}-06-15`);
    expect(row[6]).toBe('$190.00');
  }
  const lt = sales.rows.find((row) => row[3] === `${lastYear - 1}-03-01`)!;
  const st = sales.rows.find((row) => row[3] === `${lastYear}-01-20`)!;
  expect(lt).toBeTruthy();
  expect(st).toBeTruthy();
  expect(lt[5]).toBe('$150.00');
  expect(lt[9]).toBe(''); // zero ST gain renders blank
  expect(lt[10]).toBe('$233.60');
  expect(st[5]).toBe('$180.00');
  expect(st[9]).toBe('$35.40');
  expect(st[10]).toBe(''); // zero LT gain renders blank

  expect(sales.footer[0]).toBe('Total');
  expect(sales.footer[9]).toBe('$35.40');
  expect(sales.footer[10]).toBe('$233.60');
  await expect(page.locator('.totals-line')).toHaveText('Total gain: $269.00');
  await expect(page.locator('.empty-note')).toHaveCount(0);
  // The seeder has no non-USD sales, so no exclusion footnote.
  await expect(page.locator('.footnote')).toHaveCount(0);
});

test('lists the lastYear PFIC mark-to-market income', async ({ page }) => {
  await page.goto('/app/tax');
  await expect(page.getByRole('heading', { name: 'PFIC Mark-to-Market Ordinary Income' })).toBeVisible();
  const mtm = await readTable(page, 1);
  expect(mtm.header).toEqual(['Ticker', 'Tax Year', 'Marked', 'FMV (USD)', 'Basis Before', 'Ordinary Income']);
  expect(mtm.rows).toHaveLength(1);
  const [row] = mtm.rows;
  expect(row.slice(0, 3)).toEqual(['EUFUND', String(lastYear), `${lastYear}-12-31`]);
  // EUR 10,000 x 1.08; basis carried from the lastYear-1 mark
  // (EUR 9,500 x 1.05 = $9,975, above the $9,911 cost floor).
  expect(row[3]).toBe('$10,800.00');
  expect(row[4]).toBe('$9,975.00');
  expect(row[5]).toBe('$825.00');
  expect(mtm.footer[0]).toBe('Total');
  expect(mtm.footer[5]).toBe('$825.00');
});

test('re-queries for an edited range on Submit', async ({ page }) => {
  await page.goto('/app/tax');
  await expect(page.locator('table[mat-table]')).toHaveCount(2);

  await fillField(page, 'From', `1/1/${thisYear}`);
  await fillField(page, 'To', `12/31/${thisYear}`);
  await page.getByRole('button', { name: 'Submit' }).click();

  // This year: the 5-share sale from the LT lot; no year-end mark yet.
  await expect(page.locator('table[mat-table]')).toHaveCount(1);
  const sales = await readTable(page, 0);
  expect(sales.rows).toHaveLength(1);
  expect(sales.rows[0].slice(0, 3)).toEqual(['Vanguard', 'Brokerage', 'VTI']);
  expect(sales.rows[0][3]).toBe(`${lastYear - 1}-03-01`);
  expect(sales.rows[0][6]).toBe('$200.00');
  expect(sales.rows[0][8]).toBe(''); // zero sale costs render blank
  expect(sales.rows[0][9]).toBe('');
  expect(sales.rows[0][10]).not.toBe('');
  expect(sales.footer[9]).toBe('$0.00'); // footer totals are not blanked
  await expect(page.locator('.empty-note')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'PFIC Mark-to-Market Ordinary Income' })).toHaveCount(0);
});

test('shows the empty note for a range with no activity', async ({ page }) => {
  await page.goto('/app/tax');
  await fillField(page, 'From', `1/1/${lastYear - 5}`);
  await fillField(page, 'To', `12/31/${lastYear - 5}`);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('.empty-note')).toHaveText('No taxable sales in this range.');
  const sales = await readTable(page, 0);
  expect(sales.rows).toHaveLength(0);
  await expect(page.locator('.totals-line')).toHaveText('Total gain: $0.00');
  await expect(page.locator('table[mat-table]')).toHaveCount(1);
});

test('disables Submit with an inline message when From is after To', async ({ page }) => {
  await page.goto('/app/tax');
  const submit = page.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeEnabled();
  await expect(page.locator('.validation-error')).toHaveCount(0);

  await fillField(page, 'From', `1/1/${thisYear}`);
  await expect(submit).toBeDisabled();
  await expect(page.locator('.validation-error')).toHaveText('From must be on or before To');
  // The previously loaded report stays on screen.
  await expect(page.locator('table[mat-table]')).toHaveCount(2);

  await fillField(page, 'To', `1/1/${thisYear}`); // From == To is valid
  await expect(submit).toBeEnabled();
  await expect(page.locator('.validation-error')).toHaveCount(0);
});
