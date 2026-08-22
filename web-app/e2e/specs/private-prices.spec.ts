// E2E spec for PrivatePricesPage + PrivatePriceDialog
// (docs/design/ui-testing.md, inventory "PrivatePricesPage").
// The seeder gives GOLD two private prices - today-90 at $3,100.00 and
// today-5 at $3,358.50 - and gives VTI (MARKET locus) none, which is
// where the server-side locus guard shows up.
import { expect, test, type Page } from '@playwright/test';
import { acceptConfirms, expectSnackbar, fillField, seedPortfolio } from '../support/material';

let ids: Record<string, bigint>;

test.beforeEach(async () => {
  ids = await seedPortfolio();
});

/** The seeder's dates are relative to the server clock; the e2e runner
 *  shares that clock and timezone. */
function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

/** `YYYY-MM-DD`, the display form the server sends. */
function iso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `M/D/YYYY`, what the native date adapter parses in the datepicker. */
function typed(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

async function gotoPrices(page: Page, key: string): Promise<void> {
  await page.goto(`/app/securities/${ids[key]}/prices`);
}

/** Date + price cells of every row, top to bottom (the actions cell
 *  holds only icon buttons). One-shot read: callers assert through
 *  `expect.poll` so post-mutation reads retry until the page's reload
 *  has re-rendered (the success snackbar fires before the dialog
 *  closes and the table refreshes). */
async function priceRows(page: Page): Promise<string[][]> {
  const table = page.locator('table[mat-table]');
  await expect(table).toBeVisible();
  return table.locator('tr[mat-row]').evaluateAll((rows) =>
    rows.map((row) => Array.from(row.querySelectorAll('td'), (c) => c.textContent?.trim() ?? '').slice(0, 2)),
  );
}

test('lists the seeded GOLD price history newest first', async ({ page }) => {
  await gotoPrices(page, 'security.gold');
  await expect(page.locator('mat-card-title')).toHaveText(
    'Edit Privately Traded Price History for GOLD',
  );
  await expect.poll(() => priceRows(page)).toEqual([
    [iso(daysAgo(5)), '$3,358.50'],
    [iso(daysAgo(90)), '$3,100.00'],
  ]);
  await expect(page.locator('.empty-note')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add price' })).toBeVisible();
});

test('the back link returns to the security details page', async ({ page }) => {
  await gotoPrices(page, 'security.gold');
  await page.getByRole('link', { name: 'Back to GOLD' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/securities/${ids['security.gold']}$`));
  await expect(page.locator('mat-card-title')).toHaveText('GOLD: Gold coins in a vault');
});

test('adds a price through the FAB, with Submit gated on both fields', async ({ page }) => {
  await gotoPrices(page, 'security.gold');
  await page.getByRole('button', { name: 'Add price' }).click();

  await expect(page.getByRole('heading', { name: 'Add Price' })).toBeVisible();
  const submit = page.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeDisabled();

  const when = daysAgo(30);
  await fillField(page, 'Date', typed(when));
  await expect(submit).toBeDisabled(); // date alone is not enough
  await fillField(page, 'Price Per Share', 'not-a-number');
  await expect(submit).toBeDisabled(); // non-decimal price
  await fillField(page, 'Price Per Share', '3222.25');
  await expect(submit).toBeEnabled();

  await submit.click();
  await expectSnackbar(page, 'Price added');
  await expect.poll(() => priceRows(page)).toEqual([
    [iso(daysAgo(5)), '$3,358.50'],
    [iso(when), '$3,222.25'],
    [iso(daysAgo(90)), '$3,100.00'],
  ]);
});

test('rejects a duplicate date and leaves the dialog open', async ({ page }) => {
  await gotoPrices(page, 'security.gold');
  await page.getByRole('button', { name: 'Add price' }).click();
  await fillField(page, 'Date', typed(daysAgo(5))); // already priced
  await fillField(page, 'Price Per Share', '1.00');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expectSnackbar(page, `a price for ${iso(daysAgo(5))} already exists`);
  await expect(page.getByRole('heading', { name: 'Add Price' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => priceRows(page)).toHaveLength(2);
});

test('edits an existing price, prefilled at the wire scale', async ({ page }) => {
  await gotoPrices(page, 'security.gold');
  await page.getByRole('button', { name: 'Edit price' }).first().click();

  await expect(page.getByRole('heading', { name: 'Edit Price' })).toBeVisible();
  // Money crosses the wire at scale 4; the field shows it verbatim.
  await expect(page.getByRole('textbox', { name: 'Price Per Share' })).toHaveValue('3358.5000');
  await expect(page.getByRole('textbox', { name: 'Date' })).toHaveValue(typed(daysAgo(5)));

  await fillField(page, 'Price Per Share', '3400');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expectSnackbar(page, 'Price updated');
  await expect.poll(() => priceRows(page)).toEqual([
    [iso(daysAgo(5)), '$3,400.00'],
    [iso(daysAgo(90)), '$3,100.00'],
  ]);
});

test('deletes a price after the native confirm', async ({ page }) => {
  acceptConfirms(page);
  await gotoPrices(page, 'security.bondx');
  await expect.poll(() => priceRows(page)).toEqual([
    [iso(daysAgo(2)), '$10.50'],
    [iso(daysAgo(120)), '$10.00'],
  ]);

  await page.getByRole('button', { name: 'Delete price' }).first().click();
  await expectSnackbar(page, 'Price deleted');
  await expect.poll(() => priceRows(page)).toEqual([[iso(daysAgo(120)), '$10.00']]);

  // Emptying the history brings back the empty note.
  await page.getByRole('button', { name: 'Delete price' }).first().click();
  await expect(page.locator('.empty-note')).toHaveText(
    'No prices yet - add the first with the button below.',
  );
  await expect.poll(() => priceRows(page)).toHaveLength(0);
});

test('declining the confirm keeps the row', async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.dismiss());
  await gotoPrices(page, 'security.gold');
  await page.getByRole('button', { name: 'Delete price' }).first().click();
  await expect(page.locator('mat-snack-bar-container')).toHaveCount(0);
  await expect.poll(() => priceRows(page)).toEqual([
    [iso(daysAgo(5)), '$3,358.50'],
    [iso(daysAgo(90)), '$3,100.00'],
  ]);
});

test('EUR prices display in the security currency', async ({ page }) => {
  await gotoPrices(page, 'security.eufund');
  const lastYear = new Date().getFullYear() - 1;
  const rows = await priceRows(page);
  expect(rows).toEqual([
    [iso(daysAgo(7)), '\u20ac104.00'],
    [`${lastYear}-12-30`, '\u20ac100.00'],
    [`${lastYear - 1}-12-30`, '\u20ac95.00'],
  ]);
});

test('a MARKET-locus security opens empty and the server rejects the add', async ({ page }) => {
  // The page has no client-side locus guard by design (inventory);
  // sec. 5.6 is enforced server-side.
  await gotoPrices(page, 'security.vti');
  await expect(page.locator('mat-card-title')).toHaveText(
    'Edit Privately Traded Price History for VTI',
  );
  await expect(page.locator('.empty-note')).toHaveText(
    'No prices yet - add the first with the button below.',
  );

  await page.getByRole('button', { name: 'Add price' }).click();
  await fillField(page, 'Date', typed(daysAgo(1)));
  await fillField(page, 'Price Per Share', '201.90');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expectSnackbar(page, 'VTI is market-priced');
  await expect(page.getByRole('heading', { name: 'Add Price' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => priceRows(page)).toHaveLength(0);
});
