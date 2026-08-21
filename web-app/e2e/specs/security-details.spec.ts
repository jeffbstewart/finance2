// E2E spec for SecurityDetailsPage's header, Price History tab and
// ProfileDialog (docs/design/ui-testing.md, inventory
// "SecurityDetailsPage"). The Asset Allocation editor and the MTM
// ledger are separate assignments — this spec only checks that their
// tabs appear where the profile says they should.
//
// The seeder gives VTI 220 pinned daily bars (MARKET locus), GOLD and
// BONDX hand-entered prices (MANUAL), EUFUND the MARK_TO_MARKET
// treatment, and GHOST no prices at all.
import { expect, test, type Page } from '@playwright/test';
import { expectSnackbar, fillField, pickSelect, seedPortfolio, setToggle } from '../support/material';

let ids: Record<string, bigint>;

test.beforeEach(async () => {
  ids = await seedPortfolio();
});

function detailsUrl(key: string): string {
  return `/app/securities/${ids[key]}`;
}

function subtitle(page: Page) {
  return page.locator('mat-card-subtitle');
}

test('shows the VTI profile header over a rendered price chart', async ({ page }) => {
  await page.goto(detailsUrl('security.vti'));
  await expect(page.locator('mat-card-title')).toHaveText('VTI: Total Market ETF');
  await expect(subtitle(page)).toContainText('Publicly Traded');
  await expect(subtitle(page)).toContainText('ETF');
  await expect(subtitle(page)).toContainText('USD');
  await expect(subtitle(page)).toContainText('Net Expense Ratio: 0.03%');
  await expect(subtitle(page)).not.toContainText('(hidden)');

  await expect(page.locator('app-time-series-chart canvas').first()).toBeVisible();
  await expect(page.getByText('No price history yet.')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveText(['Price History', 'Asset Allocation']);
});

test('offers the price-history editor only for MANUAL securities', async ({ page }) => {
  await page.goto(detailsUrl('security.vti'));
  await expect(page.getByRole('link', { name: 'Edit price history' })).toHaveCount(0);

  await page.goto(detailsUrl('security.gold'));
  await expect(page.locator('mat-card-title')).toHaveText('GOLD: Gold coins in a vault');
  await expect(subtitle(page)).toContainText('Privately Traded');
  await expect(subtitle(page)).toContainText('Private Investment');
  await expect(subtitle(page)).toContainText('Net Expense Ratio: —');

  await page.getByRole('link', { name: 'Edit price history' }).click();
  await expect(page).toHaveURL(new RegExp(`/securities/${ids['security.gold']}/prices$`));
});

test('explains an empty manual history and tags a hidden security', async ({ page }) => {
  await page.goto(detailsUrl('security.ghost'));
  await expect(page.locator('mat-card-title')).toHaveText('GHOST: Hidden test security');
  await expect(subtitle(page)).toContainText('(hidden)');
  await expect(page.locator('.empty-note').first()).toContainText('No price history yet.');
  await expect(page.locator('.empty-note').first()).toContainText(
    'Add dates and prices with the editor above.',
  );
  await expect(page.locator('app-time-series-chart')).toHaveCount(0);
});

test('round-trips the selected tab through the query param', async ({ page }) => {
  await page.goto(detailsUrl('security.vti'));
  await expect(page.getByRole('tab', { name: 'Price History' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await page.getByRole('tab', { name: 'Asset Allocation' }).click();
  await expect(page).toHaveURL(/[?&]tab=1/);
  await expect(page.getByRole('tab', { name: 'Asset Allocation' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Reloading the URL lands on the same tab (spec §8.2).
  await page.goto(`${detailsUrl('security.vti')}?tab=1`);
  await expect(page.getByRole('tab', { name: 'Asset Allocation' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('shows the Mark to Market tab only for MARK_TO_MARKET securities', async ({ page }) => {
  await page.goto(detailsUrl('security.eufund'));
  await expect(page.getByRole('tab')).toHaveText([
    'Price History',
    'Asset Allocation',
    'Mark to Market',
  ]);
  await expect(subtitle(page)).toContainText('EUR');

  await page.goto(detailsUrl('security.bondx'));
  await expect(page.getByRole('tab')).toHaveText(['Price History', 'Asset Allocation']);
});

test('keeps the chart through indicator and duration changes', async ({ page }) => {
  await page.goto(detailsUrl('security.vti'));
  const chart = page.locator('app-time-series-chart canvas').first();
  await expect(chart).toBeVisible();

  for (const indicator of ['Bollinger Bands', 'SMA', 'EMA', 'None']) {
    await pickSelect(page, 'Technical Indicators', indicator);
    await expect(chart).toBeVisible();
  }
  // 220 daily bars end today, so every window still has points.
  for (const duration of ['1 Year', '1 Quarter', '1 Month', 'All']) {
    await pickSelect(page, 'Duration', duration);
    await expect(chart).toBeVisible();
  }
  await expect(page.getByText('No price history yet.')).toHaveCount(0);
});

test('refetches constant-dollar prices when the inflation toggle flips', async ({ page }) => {
  await page.goto(detailsUrl('security.vti'));
  const details = () =>
    page.waitForResponse((r) => r.url().endsWith('/finance.SecurityService/GetSecurityDetails'));

  const adjusted = details();
  await setToggle(page, 'Inflation-adjusted', true);
  await adjusted;
  await expect(page.getByRole('switch', { name: 'Inflation-adjusted' })).toBeChecked();
  // The CPI snapshot loads at boot; a coverage failure would land in
  // the error snackbar instead of a chart.
  await expect(page.locator('mat-snack-bar-container')).toHaveCount(0);
  await expect(page.locator('app-time-series-chart canvas').first()).toBeVisible();

  const nominal = details();
  await setToggle(page, 'Inflation-adjusted', false);
  await nominal;
  await expect(page.getByRole('switch', { name: 'Inflation-adjusted' })).not.toBeChecked();
  await expect(page.locator('mat-snack-bar-container')).toHaveCount(0);
  await expect(page.locator('app-time-series-chart canvas').first()).toBeVisible();
});

test('edits the profile and reloads the page behind it', async ({ page }) => {
  await page.goto(detailsUrl('security.bondx'));
  await expect(subtitle(page)).toContainText('Net Expense Ratio: 0.05%');
  await page.getByRole('button', { name: 'Edit profile' }).click();
  await expect(page.getByRole('heading', { name: 'Edit BONDX' })).toBeVisible();

  await fillField(page, 'Description', 'Aggregate Bond Index');
  await fillField(page, 'Net Expense Ratio', '0.0007');
  await pickSelect(page, 'Tax Treatment', 'Mark-to-market');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expectSnackbar(page, 'Profile updated');
  await expect(page.locator('mat-card-title')).toHaveText('BONDX: Aggregate Bond Index');
  await expect(subtitle(page)).toContainText('Net Expense Ratio: 0.07%');
  // The reload re-reads the tax treatment, so the MTM tab appears.
  await expect(page.getByRole('tab', { name: 'Mark to Market' })).toBeVisible();
});

test('leaves the profile untouched when the dialog is cancelled', async ({ page }) => {
  await page.goto(detailsUrl('security.bondx'));
  await page.getByRole('button', { name: 'Edit profile' }).click();
  await fillField(page, 'Description', 'Never saved');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Edit BONDX' })).toHaveCount(0);
  await expect(page.locator('mat-card-title')).toHaveText('BONDX: Aggregate Bond Fund');
});

test('disables Submit for a malformed expense ratio', async ({ page }) => {
  await page.goto(detailsUrl('security.vti'));
  await page.getByRole('button', { name: 'Edit profile' }).click();
  const submit = page.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeEnabled();

  await fillField(page, 'Net Expense Ratio', '-0.01');
  await expect(submit).toBeDisabled();
  // BUG: the mat-error is never displayed — mat-form-field only
  // projects errors while the control's errorState is true, and the
  // ratio field is a bare ngModel with no Angular validator.
  await expect(page.locator('mat-error')).toHaveCount(0);

  await fillField(page, 'Net Expense Ratio', '0.0004');
  await expect(submit).toBeEnabled();
});
