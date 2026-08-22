// E2E spec for SecuritiesPage + AddSecurityDialog
// (docs/design/ui-testing.md, inventory "SecuritiesPage"). The seeder
// leaves four visible securities - BONDX, EUFUND, GOLD, VTI, ordered
// by ticker - plus the hidden GHOST. VTI's 220 pinned daily bars are
// the only price series guaranteed to be inside the six-month
// sparkline window whatever the calendar says, so it is the one row
// asserted to draw a path.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectSnackbar, fillField, pickSelect, readTable, seedPortfolio, setToggle } from '../support/material';

test.beforeEach(async () => {
  await seedPortfolio();
});

/** The table row whose ticker link is exactly `ticker`. */
function row(page: Page, ticker: string): Locator {
  return page
    .locator('tr[mat-row]')
    .filter({ has: page.getByRole('link', { name: ticker, exact: true }) });
}

test('lists the seeded visible securities with their descriptions', async ({ page }) => {
  await page.goto('/app/securities');
  const table = await readTable(page);
  expect(table.header).toEqual(['Ticker', 'Trend', 'Description', '']);
  // Server orders by ticker; GHOST is hidden. A hand-priced security's
  // symbol cell carries its tag (the gap is CSS margin).
  expect(table.rows.map((cells) => cells[0])).toEqual([
    'BONDXmanual', 'EUFUNDmanual', 'GOLDmanual', 'SOLOmanual', 'VTI', 'VTI-TRtrust',
  ]);
  expect(table.rows.map((cells) => cells[2])).toEqual([
    'Aggregate Bond Fund',
    'European Index Fund',
    'Gold coins in a vault',
    'Priced, never held',
    'Total Market ETF',
    'Inst Tot Stk Mkt Ix Tr',
  ]);
  await expect(page.locator('.empty-note')).toHaveCount(0);
  await expect(page.locator('.hidden-tag')).toHaveCount(0);
  await expect(page.locator('.symbol-tag')).toHaveText(['manual', 'manual', 'manual', 'manual', 'trust']);
  // No unhide affordance while nothing hidden is on screen.
  await expect(page.getByRole('button', { name: 'Unhide' })).toHaveCount(0);
});

test('draws a sparkline for the security with a price series', async ({ page }) => {
  await page.goto('/app/securities');
  // Every row gets the svg shell; only 2+ closes produce the path.
  await expect(page.locator('tr[mat-row] app-sparkline svg')).toHaveCount(6);
  await expect(row(page, 'VTI').locator('svg path')).toHaveCount(1);
  await expect(row(page, 'SOLO').locator('svg path')).toHaveCount(0); // exactly one close
  await setToggle(page, 'Show hidden', true);
  await expect(row(page, 'GHOST').locator('svg path')).toHaveCount(0); // never priced
});

test("a ticker link opens that security's details page", async ({ page }) => {
  await page.goto('/app/securities');
  await page.getByRole('link', { name: 'VTI', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/securities\/\d+$/);
  // mat-card-title is not a heading element - locate it by selector.
  await expect(page.locator('mat-card-title')).toHaveText('VTI: Total Market ETF');
});

test('show-hidden reveals GHOST and the unhide button restores it', async ({ page }) => {
  await page.goto('/app/securities');
  await expect(row(page, 'GHOST')).toHaveCount(0);

  await setToggle(page, 'Show hidden', true);
  await expect(row(page, 'GHOST')).toBeVisible();
  await expect(row(page, 'GHOST').locator('.hidden-tag')).toHaveText('(hidden)');
  await expect(row(page, 'VTI').locator('.hidden-tag')).toHaveCount(0);

  await row(page, 'GHOST').getByRole('button', { name: 'Unhide' }).click();
  await expectSnackbar(page, 'GHOST is visible again');
  await expect(row(page, 'GHOST').locator('.hidden-tag')).toHaveCount(0);
  await expect(page.locator('.hidden-tag')).toHaveCount(0);

  // Now genuinely visible: it survives turning the toggle back off.
  await setToggle(page, 'Show hidden', false);
  await expect(row(page, 'GHOST')).toBeVisible();
  await expect(page.locator('tr[mat-row]')).toHaveCount(7);
});

test('the add FAB upper-cases the ticker and lands on the new details page', async ({ page }) => {
  await page.goto('/app/securities');
  await page.getByRole('button', { name: 'Add security' }).click();
  await expect(page.getByRole('heading', { name: 'Add New Security' })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled();
  await fillField(page, 'Ticker', 'newsec');
  await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled();
  await page.getByRole('button', { name: 'Submit' }).click();

  await expectSnackbar(page, 'NEWSEC added - fill in its profile');
  await expect(page).toHaveURL(/\/app\/securities\/\d+$/);
  await expect(page.locator('mat-card-title')).toHaveText('NEWSEC: (no description yet)');

  await page.goto('/app/securities');
  await expect(row(page, 'NEWSEC')).toBeVisible();
  // Brand new: no prices, so no sparkline path.
  await expect(row(page, 'NEWSEC').locator('svg path')).toHaveCount(0);
});

test('the currency select carries through to the new security', async ({ page }) => {
  await page.goto('/app/securities');
  await page.getByRole('button', { name: 'Add security' }).click();
  await fillField(page, 'Ticker', 'eurosec');
  await pickSelect(page, 'Currency', 'EUR');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expect(page).toHaveURL(/\/app\/securities\/\d+$/);
  await expect(page.locator('mat-card-subtitle')).toContainText('EUR');
});

test('a duplicate ticker is rejected and the dialog stays open', async ({ page }) => {
  await page.goto('/app/securities');
  const listUrl = page.url();
  await page.getByRole('button', { name: 'Add security' }).click();
  await fillField(page, 'Ticker', 'vti');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expectSnackbar(page, 'a security with ticker "VTI" already exists');
  await expect(page.getByRole('heading', { name: 'Add New Security' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled();
  expect(page.url()).toBe(listUrl);

  // Cancelling leaves the list exactly as it was.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Add New Security' })).toHaveCount(0);
  await expect(page.locator('tr[mat-row]')).toHaveCount(6);
});
