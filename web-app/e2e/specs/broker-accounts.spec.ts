// E2E spec for BrokerAccountsPage + AccountDialog
// (docs/design/ui-testing.md, inventory "BrokerAccountsPage").
// Vanguard holds the seeded Brokerage / Roth IRA pair plus a hidden
// Closed Account; EuroBank holds the EUR account; Old Broker is the
// empty case that exercises the ListBrokers title fallback.
import { expect, test } from '@playwright/test';
import {
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

const brokerUrl = (key: string) => `/app/brokers/${ids[key]}`;

test('lists the seeded Vanguard accounts with USD footer totals', async ({ page }) => {
  await page.goto(brokerUrl('broker.vanguard'));
  await expect(page.locator('mat-card-title')).toHaveText('Accounts at Vanguard');

  const table = await readTable(page);
  expect(table.header).toEqual([
    'Name',
    'Account',
    'Tax Deferred',
    'Sweep Balance',
    'Investment Value',
    '',
  ]);
  // Investment values stay $0.00 until the Phase 4/5 pricing work —
  // AccountGrpcService returns Money.zero for every account today.
  expect(table.rows).toEqual([
    ['Brokerage', 'X-1 (USD)', 'No', '$500.00', '$0.00', 'edit'],
    ['Roth IRA', 'X-2 (USD)', 'Yes', '$55.25', '$0.00', 'edit'],
  ]);
  // The hidden Closed Account never appears: the page never asks for
  // hidden accounts, and offers no way to unhide one.
  expect(table.rows.map((row) => row[0])).not.toContain('Closed Account');
  expect(table.footer).toEqual(['Total', '', '', '$555.25', '$0.00', '']);
});

test('shows the EUR account in its own currency under a USD total', async ({ page }) => {
  await page.goto(brokerUrl('broker.eurobank'));
  await expect(page.locator('mat-card-title')).toHaveText('Accounts at EuroBank');

  const table = await readTable(page);
  expect(table.rows).toEqual([
    ['EUR Brokerage', 'X-3 (EUR)', 'No', '€250.00', '€0.00', 'edit'],
  ]);
  // The row is account currency; the footer is the reporting currency,
  // converted through the seeded EUR→USD rate for yesterday (1.16).
  expect(table.footer[3]).toBe('$290.00');
});

test('an empty broker resolves its title and offers to hide itself', async ({ page }) => {
  await page.goto(brokerUrl('broker.old'));
  // No accounts, so the name comes from ListBrokers(includeHidden).
  await expect(page.locator('mat-card-title')).toHaveText('Accounts at Old Broker');
  await expect(page.getByText('No accounts yet.')).toBeVisible();
  await expect(page.locator('app-pie-chart')).toHaveCount(0);

  await page.getByRole('button', { name: 'Hide this empty brokerage' }).click();
  await expectSnackbar(page, 'Brokerage hidden');
  await expect(page).toHaveURL(/\/app\/brokers$/);
});

test('account names link to the scoped positions page', async ({ page }) => {
  await page.goto(brokerUrl('broker.vanguard'));
  await page.getByRole('link', { name: 'Roth IRA' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/positions\\?account=${ids['account.roth']}$`));
});

test('adds a EUR tax-deferred account through the FAB', async ({ page }) => {
  await page.goto(brokerUrl('broker.vanguard'));
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { name: 'Add Account' })).toBeVisible();

  await fillField(page, 'Account Name', '  Joint  ');
  await fillField(page, 'Account Number', 'X-9');
  await pickSelect(page, 'Tax Status', 'Tax Deferred');
  await pickSelect(page, 'Currency', 'EUR');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expectSnackbar(page, 'Account added');
  await expect(page.locator('tr[mat-row]')).toHaveCount(3); // wait out the reload
  const table = await readTable(page);
  // The name is trimmed server-side; currency is fixed at creation.
  expect(table.rows).toContainEqual(['Joint', 'X-9 (EUR)', 'Yes', '€0.00', '€0.00', 'edit']);
});

test('edits an account sweep balance from its row button', async ({ page }) => {
  await page.goto(brokerUrl('broker.vanguard'));
  await page
    .locator('tr[mat-row]')
    .filter({ hasText: 'X-1 (USD)' })
    .getByRole('button', { name: 'Edit account' })
    .click();

  await expect(page.getByRole('heading', { name: 'Edit Account' })).toBeVisible();
  // Edit mode swaps the Currency select for a currency-labelled sweeps
  // field; the exact wire decimal is prefilled, not the display string.
  await expect(page.getByRole('combobox', { name: 'Currency' })).toHaveCount(0);
  const sweeps = page.getByRole('textbox', { name: 'Sweeps Balance (USD)' });
  await expect(sweeps).toHaveValue('500.0000');
  await sweeps.fill('612.50');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expectSnackbar(page, 'Account updated');
  await expect(page.locator('tr[mat-row]').first()).toContainText('$612.50'); // reload landed
  const table = await readTable(page);
  expect(table.rows[0]).toEqual(['Brokerage', 'X-1 (USD)', 'No', '$612.50', '$0.00', 'edit']);
  expect(table.footer[3]).toBe('$667.75');
});

test('reports a duplicate account name and keeps the dialog open', async ({ page }) => {
  await page.goto(brokerUrl('broker.vanguard'));
  await page.getByRole('button', { name: 'Add account' }).click();
  await fillField(page, 'Account Name', 'Roth IRA');
  await fillField(page, 'Account Number', 'X-9');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expectSnackbar(page, 'an account named "Roth IRA" already exists at this broker');
  await expect(page.getByRole('heading', { name: 'Add Account' })).toBeVisible();
  const table = await readTable(page);
  expect(table.rows).toHaveLength(2);
});

test('Submit stays disabled until both account fields are filled', async ({ page }) => {
  await page.goto(brokerUrl('broker.vanguard'));
  await page.getByRole('button', { name: 'Add account' }).click();
  const submit = page.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeDisabled();

  await fillField(page, 'Account Name', 'Joint');
  await expect(submit).toBeDisabled();
  await fillField(page, 'Account Number', 'X-9');
  await expect(submit).toBeEnabled();

  await fillField(page, 'Account Name', '   ');
  await expect(submit).toBeDisabled();
});

test('renames the broker from the Edit broker action', async ({ page }) => {
  await page.goto(brokerUrl('broker.vanguard'));
  await page.getByRole('button', { name: 'Edit broker' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Broker' })).toBeVisible();

  const name = page.getByRole('textbox', { name: 'Brokerage Name' });
  await expect(name).toHaveValue('Vanguard');
  await name.fill('Vanguard Group');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expectSnackbar(page, 'Broker renamed');
  // The title is re-resolved from the reloaded account rows.
  await expect(page.locator('mat-card-title')).toHaveText('Accounts at Vanguard Group');
});
