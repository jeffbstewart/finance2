// E2E spec for the ClassificationEditor - the Asset Allocation tab of
// the security details page (docs/design/ui-testing.md, inventory
// "SecurityDetailsPage -> ClassificationEditor"). The seeder classifies
// VTI 100% US Stock stamped 30 days ago (fresh), GOLD 100% Other
// stamped 400 days ago (stale, so the refresh chip shows), and leaves
// GHOST unclassified. Class names come from the five seeded asset
// classes (V004__reference_data.sql).
//
// Every locator is scoped to <app-classification-editor> so the sibling
// Price History tab (its own assignment) can never satisfy one of these
// assertions, and weight fields are matched exactly - "US Stock %" is a
// substring of "Non US Stock %", which Playwright's default substring
// name matching would resolve to two elements.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectSnackbar, seedPortfolio } from '../support/material';

let ids: Record<string, bigint>;

test.beforeEach(async () => {
  ids = await seedPortfolio();
});

/** Server-relative civil date, matching SampleSeeder's `today.minusDays`. */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function editorOf(page: Page): Locator {
  return page.locator('app-classification-editor');
}

/** Weight input for one class, matched on the exact mat-label text. */
function weightField(page: Page, name: string): Locator {
  return editorOf(page).getByRole('textbox', { name: `${name} %`, exact: true });
}

function editButton(page: Page): Locator {
  return editorOf(page).getByRole('button', { name: 'Edit Asset Class Weights' });
}

function saveButton(page: Page): Locator {
  return editorOf(page).getByRole('button', { name: 'Save', exact: true });
}

async function openAssetAllocation(page: Page, securityId: bigint): Promise<void> {
  await page.goto(`/app/securities/${securityId}`);
  await page.getByRole('tab', { name: 'Asset Allocation' }).click();
  await expect(editorOf(page)).toBeVisible();
}

async function beginEdit(page: Page): Promise<void> {
  await editButton(page).click();
  await expect(weightField(page, 'Cash')).toBeVisible();
}

/** The weight fields, keyed by class name, in rendered order. */
async function weightValues(page: Page): Promise<Record<string, string>> {
  const labels = await editorOf(page).locator('mat-form-field mat-label').allTextContents();
  const out: Record<string, string> = {};
  for (const label of labels) {
    const name = label.trim().replace(/ %$/, '');
    out[name] = await weightField(page, name).inputValue();
  }
  return out;
}

test('shows the seeded VTI mix with its as-of stamp and no refresh chip', async ({ page }) => {
  await openAssetAllocation(page, ids['security.vti']);
  const editor = editorOf(page);
  await expect(editor.locator('.as-of')).toContainText(`As of ${isoDaysAgo(30)}`);
  await expect(editor.locator('.refresh-chip')).toHaveCount(0);
  await expect(editor.locator('app-pie-chart')).toBeVisible();
  await expect(editor.locator('.empty-note')).toHaveCount(0);
  await expect(editButton(page)).toBeVisible();
});

test('flags the stale GOLD classification with the refresh chip', async ({ page }) => {
  await openAssetAllocation(page, ids['security.gold']);
  const editor = editorOf(page);
  await expect(editor.locator('.as-of')).toContainText(`As of ${isoDaysAgo(400)}`);
  await expect(editor.locator('.refresh-chip')).toHaveText('refresh suggested');
});

test('edit mode lists every seeded class and prefills the current weights', async ({ page }) => {
  await openAssetAllocation(page, ids['security.vti']);
  await beginEdit(page);
  expect(await weightValues(page)).toEqual({
    Cash: '0',
    'US Stock': '100',
    'Non US Stock': '0',
    Bond: '0',
    Other: '0',
  });
  // The pie stays on screen beside the form.
  await expect(editorOf(page).locator('app-pie-chart')).toBeVisible();
});

test('blocks Save with the sum-to-100 and per-class messages', async ({ page }) => {
  await openAssetAllocation(page, ids['security.vti']);
  await beginEdit(page);
  const error = editorOf(page).locator('.validation-error');
  const save = saveButton(page);
  await expect(save).toBeEnabled();

  await weightField(page, 'US Stock').fill('60');
  await expect(error).toHaveText('Weights must sum to 100 (currently 60)');
  await expect(save).toBeDisabled();

  await weightField(page, 'Bond').fill('abc');
  await expect(error).toHaveText('Bond: enter a number between 0 and 100');
  await expect(save).toBeDisabled();

  await weightField(page, 'Bond').fill('40.001');
  await expect(error).toHaveText('Bond: at most two decimal places');

  await weightField(page, 'Bond').fill('140');
  await expect(error).toHaveText('Bond: must be between 0 and 100');

  await weightField(page, 'Bond').fill('40');
  await expect(error).toHaveCount(0);
  await expect(save).toBeEnabled();
});

test('saves a split mix, restamps as-of, and persists it across a reload', async ({ page }) => {
  await openAssetAllocation(page, ids['security.vti']);
  await beginEdit(page);
  await weightField(page, 'US Stock').fill('60');
  await weightField(page, 'Non US Stock').fill('25');
  await weightField(page, 'Bond').fill('15');
  await saveButton(page).click();

  await expectSnackbar(page, 'Asset class mix saved');
  // The parent reload drops the form and restamps the mix with today.
  await expect(editButton(page)).toBeVisible();
  await expect(editorOf(page).locator('.as-of')).toContainText(`As of ${isoDaysAgo(0)}`);

  await openAssetAllocation(page, ids['security.vti']);
  await beginEdit(page);
  expect(await weightValues(page)).toEqual({
    Cash: '0',
    'US Stock': '60',
    'Non US Stock': '25',
    Bond: '15',
    Other: '0',
  });
});

test('Cancel discards the edits', async ({ page }) => {
  await openAssetAllocation(page, ids['security.vti']);
  await beginEdit(page);
  await weightField(page, 'US Stock').fill('0');
  await weightField(page, 'Bond').fill('100');
  await editorOf(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(editButton(page)).toBeVisible();

  await openAssetAllocation(page, ids['security.vti']);
  await beginEdit(page);
  await expect(weightField(page, 'US Stock')).toHaveValue('100');
  await expect(weightField(page, 'Bond')).toHaveValue('0');
});

test('classifies a security that has no mix yet', async ({ page }) => {
  // GHOST is seeded without a classification set (and hidden, which the
  // details page does not gate on).
  await openAssetAllocation(page, ids['security.ghost']);
  const editor = editorOf(page);
  await expect(editor.locator('.empty-note')).toHaveText(
    'No asset class mix yet - enter the weights to the right.',
  );
  await expect(editor.locator('app-pie-chart')).toHaveCount(0);

  await beginEdit(page);
  await expect(weightField(page, 'Cash')).toHaveValue('0');
  await weightField(page, 'Cash').fill('100');
  await saveButton(page).click();

  await expectSnackbar(page, 'Asset class mix saved');
  await expect(editor.locator('app-pie-chart')).toBeVisible();
  await expect(editor.locator('.empty-note')).toHaveCount(0);
  await expect(editor.locator('.as-of')).toContainText(`As of ${isoDaysAgo(0)}`);
});

test('an all-zero form is rejected client-side on Save, with nothing written', async ({ page }) => {
  // The editor seeds its validation state to null on entering edit mode
  // and only recomputes on ngModelChange, so Save opens *enabled* for an
  // unclassified security; the click validates and blocks the write.
  await openAssetAllocation(page, ids['security.ghost']);
  await beginEdit(page);
  const editor = editorOf(page);
  const save = saveButton(page);
  await expect(save).toBeEnabled();
  await expect(editor.locator('.validation-error')).toHaveCount(0);

  await save.click();
  await expect(editor.locator('.validation-error')).toHaveText(
    'Weights must sum to 100 (currently 0)',
  );
  await expect(save).toBeDisabled();
  // Still in edit mode, and nothing was stamped.
  await expect(weightField(page, 'Cash')).toBeVisible();
  await expect(editor.locator('.empty-note')).toBeVisible();
});
