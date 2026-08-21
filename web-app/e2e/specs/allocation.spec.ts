// E2E spec for AllocationPage + TargetDialog + ClassDetailsPage
// (docs/design/ui-testing.md, inventory "AllocationPage" /
// "ClassDetailsPage").
//
// The seeded portfolio prices out to exactly $40,241.05:
//   Cash          $845.25  = $500 + $55.25 sweeps + EUR 250 x 1.16
//   US Stock    $9,489.30  = 47 VTI (35 held + 12 in the Roth) x $201.90
//   Non US S.  $12,064.00  = 100 EUFUND x EUR 104 x 1.16
//   Bond        $1,050.00  = 100 BONDX x $10.50
//   Other      $16,792.50  = 5 GOLD x $3,358.50
// Target holdings are that total split 10/40/20/20/10, so Cash and
// Other land on a half cent and money renders at its scale-4 precision.
import { expect, test, type Page } from '@playwright/test';
import { expectSnackbar, readTable, seedPortfolio } from '../support/material';

const CLASSES = ['Cash', 'US Stock', 'Non US Stock', 'Bond', 'Other'];
const PORTFOLIO_TOTAL = '$40,241.05';

/** `fillField` matches labels by substring, and "US Stock %" is inside
 *  "Non US Stock %" — the target dialog needs an exact match. */
async function fillPercent(page: Page, label: string, value: string): Promise<void> {
  await page.getByRole('textbox', { name: `${label} %`, exact: true }).fill(value);
}

async function openTargetDialog(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Edit Target Asset Allocation' }).click();
  await expect(page.locator('mat-dialog-container')).toBeVisible();
}

test.beforeEach(async () => {
  await seedPortfolio();
});

test('allocation dashboard scores the seeded portfolio against its target', async ({ page }) => {
  await page.goto('/app/allocation');
  // mat-card-title is not a heading element, so it is located by selector.
  await expect(page.locator('mat-card-title')).toHaveText('Asset Allocation');
  await expect(page.locator('mat-card-subtitle')).toHaveText(
    `Portfolio total: ${PORTFOLIO_TOTAL}`,
  );
  // A target is seeded, so the prompt never shows.
  await expect(page.locator('.target-prompt')).toHaveCount(0);

  const table = await readTable(page);
  expect(table.header).toEqual([
    'Asset Class', 'Total Holdings', 'Target Holdings', 'Delta', 'Percent', 'Target Percent',
  ]);
  expect(table.rows.map((row) => row[0])).toEqual(CLASSES);
  expect(table.rows).toEqual([
    ['Cash', '$845.25', '$4,024.105', '$3,178.855', '2.1%', '10%'],
    ['US Stock', '$9,489.30', '$16,096.42', '$6,607.12', '23.58%', '40%'],
    ['Non US Stock', '$12,064.00', '$8,048.21', '($4,015.79)', '29.98%', '20%'],
    ['Bond', '$1,050.00', '$8,048.21', '$6,998.21', '2.61%', '20%'],
    ['Other', '$16,792.50', '$4,024.105', '($12,768.395)', '41.73%', '10%'],
  ]);
  // Only the holdings column totals; the rest of the footer is blank.
  expect(table.footer).toEqual(['Total', PORTFOLIO_TOTAL, '', '', '', '']);
});

test('draws the four dashboard charts and the rebalance door', async ({ page }) => {
  await page.goto('/app/allocation');
  await expect(page.locator('.chart-grid .chart-cell')).toHaveCount(4);
  await expect(page.locator('app-pie-chart')).toHaveCount(2);
  await expect(page.locator('app-grouped-bar-chart')).toHaveCount(2);
  await expect(page.locator('mat-card-actions a')).toHaveAttribute(
    'href',
    '/allocation/rebalance',
  );
});

test('class links open the contributors page', async ({ page }) => {
  await page.goto('/app/allocation');
  // "US Stock" is a substring of "Non US Stock" — match exactly.
  await page.getByRole('link', { name: 'US Stock', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/allocation\/class\/US%20Stock$/);
  await expect(page.locator('mat-card-title')).toHaveText('Positions in US Stock');
  await expect(page.locator('mat-card-subtitle')).toHaveText('$9,489.30 of the portfolio');

  const table = await readTable(page);
  expect(table.header).toEqual([
    'Ticker', 'Shares', 'Weight in US Stock', 'Contribution to US Stock',
  ]);
  // The taxable lots (35 shares left after both sales) plus the Roth's 12.
  expect(table.rows).toEqual([['VTI', '47', '100%', '$9,489.30']]);
  await expect(page.locator('app-pie-chart')).toHaveCount(1);
  await expect(page.locator('.empty-note')).toHaveCount(0);
  // The ticker links on to the security.
  await page.getByRole('link', { name: 'VTI' }).click();
  await expect(page).toHaveURL(/\/app\/securities\/\d+$/);
});

test('every seeded class lists its own contributors', async ({ page }) => {
  const expected: Record<string, string[]> = {
    'Non US Stock': ['EUFUND', '100', '100%', '$12,064.00'],
    Bond: ['BONDX', '100', '100%', '$1,050.00'],
    Other: ['GOLD', '5', '100%', '$16,792.50'],
  };
  for (const [className, row] of Object.entries(expected)) {
    await page.goto(`/app/allocation/class/${encodeURIComponent(className)}`);
    await expect(page.locator('mat-card-title')).toHaveText(`Positions in ${className}`);
    const table = await readTable(page);
    expect(table.rows).toEqual([row]);
  }
});

test('the Cash class shows the synthetic sweeps contribution', async ({ page }) => {
  await page.goto('/app/allocation/class/Cash');
  const table = await readTable(page);
  // $500 Brokerage + $55.25 Roth + EUR 250 x 1.16 from the EUR account.
  expect(table.rows).toEqual([['Sweeps', '0', '100%', '$845.25']]);
  // BUG: the sweeps row has no security behind it, so its ticker cell
  // still renders a link — to /securities/0, which is a dead end.
  await expect(page.getByRole('link', { name: 'Sweeps' })).toHaveAttribute(
    'href',
    '/securities/0',
  );
});

test('an unknown class name renders the empty note, not an error', async ({ page }) => {
  await page.goto('/app/allocation/class/Commodities');
  await expect(page.locator('mat-card-title')).toHaveText('Positions in Commodities');
  await expect(page.locator('.empty-note')).toHaveText('Nothing contributes to Commodities yet.');
  await expect(page.locator('tr[mat-row]')).toHaveCount(0);
  await expect(page.locator('app-pie-chart')).toHaveCount(0);
  await expect(page.locator('mat-snack-bar-container')).toHaveCount(0);
});

test('the target dialog opens prefilled with the stored percents', async ({ page }) => {
  await page.goto('/app/allocation');
  await openTargetDialog(page);
  await expect(page.locator('mat-dialog-title')).toHaveText('Edit Target Asset Allocation');
  for (const [className, percent] of Object.entries({
    Cash: '10',
    'US Stock': '40',
    'Non US Stock': '20',
    Bond: '20',
    Other: '10',
  })) {
    await expect(
      page.getByRole('textbox', { name: `${className} %`, exact: true }),
    ).toHaveValue(percent);
  }
  await expect(page.locator('.validation-error')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled();
});

test('the target dialog blocks a sum that misses 100', async ({ page }) => {
  await page.goto('/app/allocation');
  await openTargetDialog(page);
  const submit = page.getByRole('button', { name: 'Submit' });

  await fillPercent(page, 'Other', '0');
  await expect(page.locator('.validation-error')).toHaveText(
    'Percents must sum to 100 (currently 90)',
  );
  await expect(submit).toBeDisabled();

  await fillPercent(page, 'Other', '10.001');
  await expect(page.locator('.validation-error')).toHaveText(
    'Other: at most two decimal places',
  );
  await expect(submit).toBeDisabled();

  await fillPercent(page, 'Other', '101');
  await expect(page.locator('.validation-error')).toHaveText(
    'Other: must be between 0 and 100',
  );

  await fillPercent(page, 'Other', '10');
  await expect(page.locator('.validation-error')).toHaveCount(0);
  await expect(submit).toBeEnabled();
});

test('saving a new target updates the dashboard', async ({ page }) => {
  await page.goto('/app/allocation');
  await openTargetDialog(page);
  await fillPercent(page, 'Cash', '5');
  await fillPercent(page, 'US Stock', '45');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expectSnackbar(page, 'Target allocation saved');
  await expect(page.locator('mat-dialog-container')).toHaveCount(0);
  // The page reloads behind the dialog — wait for the new figure before
  // reading the table (readTable does no waiting of its own).
  await expect(page.locator('tr[mat-row]').first().locator('td').last()).toHaveText('5%');

  const table = await readTable(page);
  expect(table.rows.map((row) => row[5])).toEqual(['5%', '45%', '20%', '20%', '10%']);
  // The portfolio itself is untouched: only the target side moves.
  expect(table.rows.map((row) => row[1])).toEqual([
    '$845.25', '$9,489.30', '$12,064.00', '$1,050.00', '$16,792.50',
  ]);
  expect(table.footer[1]).toBe(PORTFOLIO_TOTAL);
  expect(table.rows[0][2]).toBe('$2,012.0525'); // 5% of the total
  expect(table.rows[1][2]).toBe('$18,108.4725'); // 45% of the total

  // The stored target survives a reload.
  await page.reload();
  await expect(page.locator('tr[mat-row]').first().locator('td').last()).toHaveText('5%');
});

test('cancelling the target dialog changes nothing', async ({ page }) => {
  await page.goto('/app/allocation');
  await openTargetDialog(page);
  await fillPercent(page, 'Cash', '30');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('mat-dialog-container')).toHaveCount(0);
  const table = await readTable(page);
  expect(table.rows.map((row) => row[5])).toEqual(['10%', '40%', '20%', '20%', '10%']);
});
