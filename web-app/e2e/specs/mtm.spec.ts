// E2E spec for the Mark to Market tab (docs/design/ui-testing.md,
// inventory "MtmMarks / MtmMarkDialog"). The seeded EUFUND is the only
// MARK_TO_MARKET security: one EUR lot (100 @ \u20ac90 + \u20ac10 = $9,911.00 at
// the 1.10 purchase rate) and two chained year-end marks.
import { expect, test, type Page } from '@playwright/test';
import { acceptConfirms, expectSnackbar, fillField, readTable, seedPortfolio } from '../support/material';

const thisYear = new Date().getFullYear();
const lastYear = thisYear - 1;

let ids: Record<string, bigint>;

test.beforeEach(async () => {
  ids = await seedPortfolio();
});

/** The Mark to Market tab is index 2 - it only exists for a
 *  MARK_TO_MARKET security, so the `tab` query param lands on it. */
async function openMtmTab(page: Page): Promise<void> {
  await page.goto(`/app/securities/${ids['security.eufund']}?tab=2`);
  await expect(page.getByRole('tab', { name: 'Mark to Market' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

test('lists the seeded marks with the acquisition-cost floor', async ({ page }) => {
  await openMtmTab(page);
  await expect(page.locator('.floor-line')).toHaveText(
    'Acquisition cost (basis floor): $9,911.00',
  );

  const marks = await readTable(page);
  expect(marks.header.slice(0, 8)).toEqual([
    'Tax Year', 'Marked', 'Shares', 'FMV (EUR)', 'FX Rate',
    'FMV (USD)', 'Basis After', 'Ordinary Income',
  ]);
  expect(marks.rows).toHaveLength(2);
  // \u20ac9,500 x 1.05 = $9,975, $64.00 over the $9,911.00 floor.
  expect(marks.rows[0].slice(0, 8)).toEqual([
    String(lastYear - 1), `${lastYear - 1}-12-31`, '100', '\u20ac9,500.00', '1.05',
    '$9,975.00', '$9,975.00', '$64.00',
  ]);
  // \u20ac10,000 x 1.08 = $10,800 against the carried-forward $9,975 basis.
  expect(marks.rows[1].slice(0, 8)).toEqual([
    String(lastYear), `${lastYear}-12-31`, '100', '\u20ac10,000.00', '1.08',
    '$10,800.00', '$10,800.00', '$825.00',
  ]);
  await expect(page.locator('.empty-note')).toHaveCount(0);
});

test('offers delete on the latest mark only, edit on every mark', async ({ page }) => {
  await openMtmTab(page);
  await expect(page.getByRole('button', { name: 'Edit mark' })).toHaveCount(2);
  const del = page.getByRole('button', { name: 'Delete latest mark' });
  await expect(del).toHaveCount(1);
  // It sits in the last (highest tax year) row.
  await expect(page.locator('tr[mat-row]').last().getByRole('button', { name: 'Delete latest mark' }))
    .toBeVisible();
});

test('records the next year-end mark from the server suggestion', async ({ page }) => {
  await openMtmTab(page);
  await page.getByRole('button', { name: 'Record year-end mark' }).click();

  await expect(page.getByRole('heading', { name: 'Record Year-End Mark - EUFUND' })).toBeVisible();
  // Default year = latest mark + 1; the fields prefill from the stored
  // \u20ac104 price and the most recent FX row (1.16), as raw wire decimals.
  await expect(page.getByRole('spinbutton', { name: 'Tax Year' })).toHaveValue(String(thisYear));
  await expect(page.getByRole('textbox', { name: 'Mark Date' })).toHaveValue(`12/31/${thisYear}`);
  await expect(page.getByRole('textbox', { name: 'Shares Held' })).toHaveValue(/^100(\.0*)?$/);
  await expect(page.getByRole('textbox', { name: 'Fair Market Value (EUR)' }))
    .toHaveValue(/^10400(\.0*)?$/);
  await expect(page.getByRole('textbox', { name: 'FX Rate (USD per EUR)' }))
    .toHaveValue(/^1\.16(0*)?$/);
  // The last stored price predates Dec 31, so the server says so.
  await expect(page.locator('p.note')).toContainText(`latest on or before ${thisYear}-12-31`);
  await expect(page.locator('p.preview')).toContainText('Suggested ordinary income: $1,264.00');

  await page.getByRole('button', { name: 'Record Mark' }).click();
  await expectSnackbar(page, `${thisYear} mark recorded - ordinary income $1,264.00`);

  // The ledger reloads after the dialog closes - wait for the new row
  // before taking the table snapshot.
  await expect(page.locator('tr[mat-row]')).toHaveCount(3);
  const marks = await readTable(page);
  expect(marks.rows).toHaveLength(3);
  // \u20ac10,400 x 1.16 = $12,064 against the $10,800 basis carried forward.
  expect(marks.rows[2].slice(0, 8)).toEqual([
    String(thisYear), `${thisYear}-12-31`, '100', '\u20ac10,400.00', '1.16',
    '$12,064.00', '$12,064.00', '$1,264.00',
  ]);
});

test('rejects a mark recorded out of tax-year order', async ({ page }) => {
  await openMtmTab(page);
  await page.getByRole('button', { name: 'Record year-end mark' }).click();
  await expect(page.getByRole('textbox', { name: 'Shares Held' })).not.toHaveValue('');

  // Re-recording the year that already has a mark: the suggestion still
  // computes, but the server refuses to break the basis chain.
  await page.getByRole('spinbutton', { name: 'Tax Year' }).fill(String(lastYear));
  await expect(page.getByRole('textbox', { name: 'Mark Date' })).toHaveValue(`12/31/${lastYear}`);
  await page.getByRole('button', { name: 'Record Mark' }).click();

  await expectSnackbar(page, `marks must be recorded in tax-year order - the latest is ${lastYear}`);
  await expect(page.getByRole('heading', { name: 'Record Year-End Mark - EUFUND' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('tr[mat-row]')).toHaveCount(2);
  const marks = await readTable(page);
  expect(marks.rows).toHaveLength(2);
});

test('editing an earlier mark restates the later one', async ({ page }) => {
  await openMtmTab(page);
  await page.getByRole('button', { name: 'Edit mark' }).first().click();

  await expect(page.getByRole('heading', { name: 'Edit Year-End Mark - EUFUND' })).toBeVisible();
  const year = page.getByRole('spinbutton', { name: 'Tax Year' });
  await expect(year).toHaveValue(String(lastYear - 1));
  await expect(year).toBeDisabled();
  await expect(page.locator('mat-hint')).toHaveText(
    'The tax year is fixed - delete and re-record to move a mark',
  );
  await expect(page.locator('p.note')).toHaveText(
    'later marks restate automatically against the edited basis',
  );

  await fillField(page, 'Fair Market Value (EUR)', '9600');
  await page.getByRole('button', { name: 'Save Mark' }).click();
  // \u20ac9,600 x 1.05 = $10,080, $169.00 over the $9,911.00 floor.
  await expectSnackbar(page, `${lastYear - 1} mark updated - ordinary income $169.00`);

  await expect(page.locator('tr[mat-row]').first()).toContainText('$169.00');
  const marks = await readTable(page);
  expect(marks.rows).toHaveLength(2);
  expect(marks.rows[0].slice(0, 8)).toEqual([
    String(lastYear - 1), `${lastYear - 1}-12-31`, '100', '\u20ac9,600.00', '1.05',
    '$10,080.00', '$10,080.00', '$169.00',
  ]);
  // The later mark restates against the new basis: $10,800 - $10,080.
  expect(marks.rows[1].slice(0, 8)).toEqual([
    String(lastYear), `${lastYear}-12-31`, '100', '\u20ac10,000.00', '1.08',
    '$10,800.00', '$10,800.00', '$720.00',
  ]);
});

test('deletes the latest mark after a confirm', async ({ page }) => {
  acceptConfirms(page);
  await openMtmTab(page);
  await page.getByRole('button', { name: 'Delete latest mark' }).click();
  await expectSnackbar(page, `${lastYear} mark deleted`);

  await expect(page.locator('tr[mat-row]')).toHaveCount(1);
  const marks = await readTable(page);
  expect(marks.rows).toHaveLength(1);
  expect(marks.rows[0][0]).toBe(String(lastYear - 1));
  // The remaining mark is now the latest, so it grows a delete button.
  await expect(page.getByRole('button', { name: 'Delete latest mark' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Edit mark' })).toHaveCount(1);
});

test('a lots-treatment security has no Mark to Market tab', async ({ page }) => {
  await page.goto(`/app/securities/${ids['security.vti']}`);
  await expect(page.getByRole('tab', { name: 'Price History' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Asset Allocation' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Mark to Market' })).toHaveCount(0);
});
