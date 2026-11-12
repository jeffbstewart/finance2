// E2E spec for PlansPage + PlanPage + PlanStepDialog
// (docs/design/ui-testing.md, inventory "PlansPage / PlanPage"). The
// trading plans replace the old rebalance scorer; unlike it, a plan
// persists, so every test starts from a freshly seeded portfolio
// (the seeder truncates trading_plans) and creates its own plan.
//
// Pinned figures depend only on the seeder's sweeps and prices:
//   * Vanguard : Brokerage sweeps $500.00.
//   * VTI's last pinned bar is $201.90, so one share costs $201.90.
import { expect, test, type Page } from '@playwright/test';
import {
  acceptConfirms,
  dialog,
  expectRows,
  expectSnackbar,
  fillField,
  pickSelect,
  readTable,
  rowFor,
  seedPortfolio,
  setToggle,
} from '../support/material';

test.beforeEach(async () => {
  await seedPortfolio();
});

/** The "Current total" / "Cash in from outside" / ... stat values. */
function stat(page: Page, label: string) {
  return page.locator('.readonly-stat').filter({ hasText: label }).locator('.stat-value');
}

/** Creates a plan from the list page and lands on its page. */
async function createPlan(page: Page, name: string): Promise<void> {
  await page.goto('/app/allocation/plans');
  await fillField(page, 'New plan', name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expectSnackbar(page, `${name} created`);
  await expect(page).toHaveURL(/\/app\/allocation\/plans\/\d+$/);
  await expect(page.locator('mat-card-title')).toHaveText(name);
}

test('starts empty and creates a plan from the name box', async ({ page }) => {
  await page.goto('/app/allocation/plans');
  await expect(page.locator('mat-card-title')).toHaveText('Trading Plans');
  await expect(page.locator('.empty-note')).toHaveText('No plans yet. Name one above to start.');
  await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();

  await createPlan(page, 'Autumn 2026');
  // A plan with no steps: Before and After agree, nothing crosses
  // the portfolio boundary, and it is trivially executable.
  await expect(page.locator('.empty-note')).toHaveText(
    'No steps yet. Before and After are identical until you add one.',
  );
  await expect(stat(page, 'Current total')).toHaveText('$40,241.05');
  await expect(stat(page, 'After the plan')).toHaveText('$40,241.05');
  await expect(stat(page, 'Cash in from outside')).toHaveText('$0.00');
  await expect(stat(page, 'Cash out to outside')).toHaveText('$0.00');
  await expect(stat(page, 'Executable as written')).toHaveText('Yes');

  const classes = await readTable(page, 0);
  expect(classes.header).toEqual(['Class', 'Before', 'After', 'Target', 'After - target', '']);
  expect(classes.rows.map((row) => row[0])).toEqual(['Cash', 'US Stock', 'Non US Stock', 'Bond', 'Other']);
  expect(classes.rows.map((row) => row[3])).toEqual(['10%', '40%', '20%', '20%', '10%']);

  // Back on the list the plan is there with no steps.
  await page.getByRole('link', { name: 'Plans' }).click();
  await expectRows(page, 1);
  const plans = await readTable(page);
  expect(plans.header).toEqual(['Plan', 'Steps', 'Updated', 'Last printed']);
  expect(plans.rows[0].slice(0, 2)).toEqual(['Autumn 2026', '0']);
});

test('adds, edits, and removes steps, re-scoring each time', async ({ page }) => {
  await createPlan(page, 'Top up');

  // Cash from outside lands in the destination sweep.
  await page.getByRole('button', { name: 'Add from outside' }).click();
  await expect(dialog(page).getByRole('heading')).toHaveText('Add from outside');
  await pickSelect(page, 'Account', 'Vanguard : Brokerage');
  await fillField(page, 'Amount (account currency)', '1000');
  await dialog(page).getByRole('button', { name: 'Add step' }).click();
  await expectSnackbar(page, 'Step added');

  await expect(stat(page, 'Cash in from outside')).toHaveText('$1,000.00');
  await expect(stat(page, 'After the plan')).toHaveText('$41,241.05');
  await expect(stat(page, 'Executable as written')).toHaveText('Yes');
  // Steps table is the second mat-table; accounts the third.
  await expectRows(page, 1, 1);
  let steps = await readTable(page, 1);
  expect(steps.header).toEqual([
    '#', 'Step', 'Account', 'Security', 'Shares', 'Amount', 'Plan price', 'Est. gain (ST / LT)', 'Note', '',
  ]);
  expect(steps.rows[0].slice(0, 6)).toEqual(['1', 'Add from outside', 'Brokerage', '', '', '$1,000.00']);
  await expect(rowFor(page, 'Vanguard : Brokerage', 2)).toContainText('$1,500.00');

  // A buy spends the sweep at the plan price.
  await page.getByRole('button', { name: 'Buy', exact: true }).click();
  await expect(dialog(page).getByRole('heading')).toHaveText('Buy');
  await pickSelect(page, 'Account', 'Vanguard : Brokerage');
  await pickSelect(page, 'Security', 'VTI - Total Market ETF');
  await pickSelect(page, 'Enter by', 'Shares');
  await fillField(page, 'Shares', '2');
  await dialog(page).getByRole('button', { name: 'Add step' }).click();
  await expectSnackbar(page, 'Step added');
  await expectRows(page, 2, 1);
  steps = await readTable(page, 1);
  expect(steps.rows[1].slice(0, 7)).toEqual(['2', 'Buy', 'Brokerage', 'VTI', '2', '$403.80', '$201.90']);
  // $500.00 + $1,000.00 - $403.80.
  await expect(rowFor(page, 'Vanguard : Brokerage', 2)).toContainText('$1,096.20');

  // Edit the buy down to one share.
  await rowFor(page, 'VTI', 1).getByRole('button', { name: 'Edit step' }).click();
  await expect(dialog(page).getByRole('heading')).toHaveText('Buy');
  await fillField(page, 'Shares', '1');
  await dialog(page).getByRole('button', { name: 'Update step' }).click();
  await expectSnackbar(page, 'Step updated');
  await expect(rowFor(page, 'VTI', 1)).toContainText('$201.90');
  await expect(rowFor(page, 'Vanguard : Brokerage', 2)).toContainText('$1,298.10');

  // Moving the buy first puts it before the cash arrives: $500.00
  // covers one share, so the plan stays executable.
  await rowFor(page, 'VTI', 1).getByRole('button', { name: 'Move up' }).click();
  await expectSnackbar(page, 'Step moved');
  steps = await readTable(page, 1);
  expect(steps.rows.map((row) => row[1])).toEqual(['Buy', 'Add from outside']);

  // Remove the cash step: the sweep after is $500.00 - $201.90.
  await rowFor(page, 'Add from outside', 1).getByRole('button', { name: 'Remove step' }).click();
  await expectSnackbar(page, 'Step removed');
  await expectRows(page, 1, 1);
  await expect(stat(page, 'Cash in from outside')).toHaveText('$0.00');
  await expect(rowFor(page, 'Vanguard : Brokerage', 2)).toContainText('$298.10');
});

test('flags a plan that overspends its sweep', async ({ page }) => {
  await createPlan(page, 'Too much');
  await page.getByRole('button', { name: 'Buy', exact: true }).click();
  await pickSelect(page, 'Account', 'Vanguard : Brokerage');
  await pickSelect(page, 'Security', 'VTI - Total Market ETF');
  await pickSelect(page, 'Enter by', 'Shares');
  await fillField(page, 'Shares', '3');
  await dialog(page).getByRole('button', { name: 'Add step' }).click();
  await expectSnackbar(page, 'Step added');
  // 3 x $201.90 = $605.70 against $500.00 of sweep.
  await expect(stat(page, 'Executable as written')).toHaveText('No - see steps');
  await expect(rowFor(page, 'VTI', 1).locator('.problem')).toHaveCount(1);
  await expect(rowFor(page, 'Vanguard : Brokerage', 2)).toContainText('($105.70)');
});

test('archives, reveals through the toggle, reopens, and deletes', async ({ page }) => {
  await createPlan(page, 'Old idea');
  await page.getByRole('button', { name: 'Plan actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expectSnackbar(page, 'Plan archived');
  await expect(page.locator('mat-card-subtitle')).toContainText('archived');
  await expect(page.getByRole('button', { name: 'Buy', exact: true })).toBeDisabled();

  // Archived plans are hidden from the list until asked for.
  await page.getByRole('link', { name: 'Plans' }).click();
  await expect(page.locator('.empty-note')).toHaveText('No plans yet. Name one above to start.');
  await setToggle(page, 'Show archived', true);
  await expectRows(page, 1);
  await expect(rowFor(page, 'Old idea')).toContainText('(archived)');

  await page.getByRole('link', { name: 'Old idea' }).click();
  await page.getByRole('button', { name: 'Plan actions' }).click();
  await page.getByRole('menuitem', { name: 'Reopen' }).click();
  await expectSnackbar(page, 'Plan reopened');
  await expect(page.getByRole('button', { name: 'Buy', exact: true })).toBeEnabled();

  acceptConfirms(page);
  await page.getByRole('button', { name: 'Plan actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expectSnackbar(page, 'Plan deleted');
  await expect(page).toHaveURL(/\/app\/allocation\/plans$/);
  await expect(page.locator('.empty-note')).toHaveText('No plans yet. Name one above to start.');
});
