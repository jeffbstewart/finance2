// Exemplar e2e spec (docs/design/ui-testing.md): seeded portfolio,
// real server, real browser, authenticated via the shared
// storageState. Per-page test agents copy this shape.
//
// Covers the `brokers` assignment: BrokersPage (table, totals, pie,
// show-hidden + unhide, broker links) and BrokerDialog in add mode
// (rename mode is only reachable from the accounts page).
import { expect, test } from '@playwright/test';
import { expectSnackbar, fillField, readTable, seedPortfolio, setToggle } from '../support/material';

let ids: Record<string, bigint>;

test.beforeEach(async () => {
  ids = await seedPortfolio();
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

test('sweeps are summed per broker in the reporting currency', async ({ page }) => {
  await page.goto('/app/brokers');
  const table = await readTable(page);
  expect(table.header).toEqual(['Name', 'Total Holdings', 'Sweeps', '']);
  const vanguard = table.rows.find((row) => row[0] === 'Vanguard')!;
  const euroBank = table.rows.find((row) => row[0] === 'EuroBank')!;
  expect(vanguard).toBeTruthy();
  expect(euroBank).toBeTruthy();
  // Brokerage $500.00 + Roth IRA $55.25; the hidden Closed Account is
  // excluded. EuroBank's EUR 250.00 converts at yesterday's 1.16 rate.
  expect(vanguard[2]).toBe('$555.25');
  expect(euroBank[2]).toBe('$290.00');
  expect(table.footer[2]).toBe('$845.25');
  // Holdings are still zero server-side (BrokerGrpcService: positions
  // pricing lands in Phase 4/5) - pinning today's behavior.
  // Holdings are the priced positions of each broker's visible
  // accounts, in USD; VTI's synthetic close moves daily, so shape and
  // consistency: Vanguard and EuroBank both hold, the footer is the sum.
  const dollars = (s: string) => Number(s.replace(/[$,]/g, ''));
  expect(vanguard[1]).toMatch(/^\$[\d,]+\.\d\d$/);
  expect(dollars(vanguard[1])).toBeGreaterThan(0);
  expect(dollars(euroBank[1])).toBeGreaterThan(0);
  expect(dollars(table.footer[1])).toBeCloseTo(dollars(vanguard[1]) + dollars(euroBank[1]), 2);
});

test('renders the holdings pie for the visible brokers', async ({ page }) => {
  await page.goto('/app/brokers');
  await expect(page.locator('.chart-host canvas')).toHaveCount(1);
});

test('a broker name links to its accounts page', async ({ page }) => {
  await page.goto('/app/brokers');
  await page.getByRole('link', { name: 'Vanguard' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/brokers/${ids['broker.vanguard']}$`));
  await expect(page.getByText('Accounts at Vanguard')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Roth IRA' })).toBeVisible();
});

test('show-hidden reveals and unhides the hidden broker', async ({ page }) => {
  await page.goto('/app/brokers');
  await setToggle(page, 'Show hidden', true);
  await expect(page.getByRole('link', { name: 'Old Broker' })).toBeVisible();
});

test('the hidden row carries the tag and the only unhide button', async ({ page }) => {
  await page.goto('/app/brokers');
  await expect(page.getByRole('button', { name: 'Unhide' })).toHaveCount(0);
  await setToggle(page, 'Show hidden', true);
  await expect(page.getByRole('button', { name: 'Unhide' })).toHaveCount(1);
  const table = await readTable(page);
  const old = table.rows.find((row) => row[0].includes('Old Broker'))!;
  expect(old[0]).toContain('(hidden)');
  expect(old[2]).toBe('$0.00'); // no accounts, so no sweeps
  for (const row of table.rows.filter((r) => !r[0].includes('Old Broker'))) {
    expect(row[0]).not.toContain('(hidden)');
  }
});

test('unhiding a broker keeps it listed once show-hidden is off again', async ({ page }) => {
  await page.goto('/app/brokers');
  await setToggle(page, 'Show hidden', true);
  await page.getByRole('button', { name: 'Unhide' }).click();
  await expectSnackbar(page, 'Old Broker is visible again');
  await expect(page.getByRole('button', { name: 'Unhide' })).toHaveCount(0);

  await setToggle(page, 'Show hidden', false);
  const table = await readTable(page);
  const old = table.rows.find((row) => row[0] === 'Old Broker')!;
  expect(old).toBeTruthy();
  expect(old[0]).not.toContain('(hidden)');
});

test('the add FAB creates a broker after the dialog is submitted', async ({ page }) => {
  await page.goto('/app/brokers');
  await page.getByRole('button', { name: 'Add broker' }).click();
  await expect(page.getByRole('heading', { name: 'Add New Broker' })).toBeVisible();
  // The name is required, so Submit starts out disabled.
  await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled();

  await fillField(page, 'Brokerage Name', 'Fidelity');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expectSnackbar(page, 'Broker added');
  await expect(page.getByRole('link', { name: 'Fidelity' })).toBeVisible();

  const table = await readTable(page);
  const fidelity = table.rows.find((row) => row[0] === 'Fidelity')!;
  expect(fidelity).toBeTruthy();
  expect(fidelity.slice(1, 3)).toEqual(['$0.00', '$0.00']);
});

test('cancelling the add dialog leaves the list untouched', async ({ page }) => {
  await page.goto('/app/brokers');
  const before = await readTable(page);
  await page.getByRole('button', { name: 'Add broker' }).click();
  await fillField(page, 'Brokerage Name', 'Fidelity');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Add New Broker' })).toHaveCount(0);

  const after = await readTable(page);
  expect(after.rows.map((row) => row[0])).toEqual(before.rows.map((row) => row[0]));
});

test('a duplicate broker name is refused with the server message', async ({ page }) => {
  await page.goto('/app/brokers');
  await page.getByRole('button', { name: 'Add broker' }).click();
  await fillField(page, 'Brokerage Name', 'Vanguard');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expectSnackbar(page, 'a broker named "Vanguard" already exists');
  // The dialog stays open with the typed name so it can be corrected.
  await expect(page.getByRole('textbox', { name: 'Brokerage Name' })).toHaveValue('Vanguard');
});
