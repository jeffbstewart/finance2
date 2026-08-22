// E2E spec for ImportsPage (docs/design/ui-testing.md, inventory
// "ImportsPage"). The seeder archives one unprocessed
// `vanguard-sample.pb` whose ref-roth is already linked to the Roth
// IRA, so upload -> link -> process is reachable end to end.
//
// The upload tests build their snapshot bytes in memory and hand them
// to `setInputFiles` - no provider data ever enters git (CLAUDE.md),
// and nothing on disk has to be kept in sync with the contract.
import { expect, test, type Page } from '@playwright/test';
import { acceptConfirms, readTable, seedPortfolio } from '../support/material';

/** Snackbars overlap (e.g. "Account linked" still showing when
 *  "Processed" arrives), so match by text, never by bare container. */
async function snack(page: Page, text: string): Promise<void> {
  await expect(
    page.locator('mat-snack-bar-container').filter({ hasText: text }),
  ).toBeVisible({ timeout: 9_000 });
}

/** Stable id keys from the seeder (never scrape ids). */
let ids: Record<string, bigint>;

test.beforeEach(async () => {
  ids = await seedPortfolio();
});

// --- a hand-rolled bankferry snapshot encoder ------------------------
// proto/plaid_snapshot.proto is deliberately excluded from the TS
// codegen (the browser uploads snapshot bytes opaquely), so the few
// wire fields this spec needs are encoded by hand.

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest) byte |= 0x80;
    out.push(byte);
  } while (rest);
  return out;
}

function tag(fieldNumber: number, wireType: number): number[] {
  return varint((fieldNumber << 3) | wireType);
}

function varintField(fieldNumber: number, value: number): number[] {
  return [...tag(fieldNumber, 0), ...varint(value)];
}

function messageField(fieldNumber: number, payload: number[]): number[] {
  return [...tag(fieldNumber, 2), ...varint(payload.length), ...payload];
}

function stringField(fieldNumber: number, value: string): number[] {
  return messageField(fieldNumber, Array.from(new TextEncoder().encode(value)));
}

/** bankferry.investments.Decimal */
const decimal = (value: string): number[] => stringField(1, value);

/** bankferry.investments.Money */
const money = (value: string, currency = 'USD'): number[] => [
  ...messageField(1, decimal(value)),
  ...stringField(2, currency),
];

/** bankferry.investments.Date */
const civilDate = (d: Date): number[] => [
  ...varintField(1, d.getFullYear()),
  ...varintField(2, d.getMonth() + 1),
  ...varintField(3, d.getDate()),
];

const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A one-item, one-account, one-holding InvestmentsSnapshot (schema 1). */
function snapshotBytes(asOf: Date): Buffer {
  const security = [...stringField(2, 'VTI'), ...stringField(5, 'Total Market ETF'), ...stringField(7, 'USD')];
  const holding = [
    ...messageField(1, security),
    ...messageField(2, decimal('7')),
    ...messageField(6, money('1413.30')),
  ];
  const account = [
    ...stringField(1, 'ref-e2e-upload'),
    ...stringField(2, 'E2E Upload'),
    ...stringField(4, '9999'),
    ...stringField(5, 'investment'),
    ...stringField(6, 'brokerage'),
    ...messageField(8, money('100.00')),
    ...messageField(9, holding),
  ];
  const item = [
    ...stringField(1, 'E2E Institution'),
    ...stringField(2, 'item-e2e'),
    ...messageField(3, account),
  ];
  return Buffer.from([...varintField(1, 1), ...messageField(2, civilDate(asOf)), ...messageField(3, item)]);
}

// --- page helpers ----------------------------------------------------

/** The (label-less) link select for one Plaid account row. Shared
 *  `pickSelect` needs an accessible name; these selects have none. */
function linkSelect(page: Page, accountName: string) {
  return page.locator('tr[mat-row]').filter({ hasText: accountName }).locator('mat-select');
}

async function pickLink(page: Page, accountName: string, optionText: string): Promise<void> {
  await linkSelect(page, accountName).click();
  await page.getByRole('option', { name: optionText, exact: true }).click();
}

function reportLines(page: Page) {
  return page.locator('ul.report li');
}

async function selectSnapshot(page: Page, filename: string): Promise<void> {
  await page.getByRole('link', { name: filename }).click();
  await expect(page.getByText(`Accounts in ${filename}`)).toBeVisible();
}

// --- specs -----------------------------------------------------------

test('lists the seeded snapshot as uploaded and never processed', async ({ page }) => {
  await page.goto('/app/imports');
  const table = await readTable(page, 0);
  expect(table.header).toEqual(['File', 'As Of', 'Uploaded', 'Status', 'Last Processed', '']);
  expect(table.rows).toHaveLength(1);
  const [row] = table.rows;
  expect(row[0]).toBe('vanguard-sample.pb');
  expect(row[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // seeded as today - 3 days
  expect(row[2]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  expect(row[3]).toBe('Uploaded');
  expect(row[4]).toBe(''); // never processed
  expect(row[5]).toBe('play_arrowdelete'); // icon-only actions
  // Nothing selected yet: no accounts panel, no report, no empty note.
  await expect(page.locator('table[mat-table]')).toHaveCount(1);
  await expect(page.locator('ul.report')).toHaveCount(0);
  await expect(page.locator('.empty-note')).toHaveCount(0);
});

test('selecting a snapshot lists its Plaid accounts with the seeded link', async ({ page }) => {
  await page.goto('/app/imports');
  await selectSnapshot(page, 'vanguard-sample.pb');
  // Snapshots, accounts, securities.
  await expect(page.locator('table[mat-table]')).toHaveCount(3);
  const accounts = await readTable(page, 1);
  expect(accounts.header).toEqual([
    'Institution', 'Account', 'Type', 'Holdings', 'Linked finance2 account',
  ]);
  // The mask abuts the name in the DOM (the gap is CSS margin).
  expect(accounts.rows).toEqual([
    ['Vanguard', 'Roth IRA...5678', 'investment / roth', '1', 'Vanguard : Roth IRA (USD)'],
  ]);
  // The seeded VTI holding matches by ticker, so it gets a chip, not a select.
  const securities = await readTable(page, 2);
  expect(securities.header).toEqual(['Security', 'Identifiers', 'Type', 'Accounts', 'finance2 security']);
  expect(securities.rows).toEqual([['Total Market ETF', 'VTI', '', '1', 'VTI (by ticker)']]);
  await expect(page.locator('table[mat-table]').nth(2).locator('mat-select')).toHaveCount(0);
  await expect(page.locator('tr.selected-row')).toHaveCount(1);
});

test('processing the linked snapshot imports the Roth position and reports it', async ({ page }) => {
  // Before the import the Roth's VTI holding is hand-entered.
  await page.goto(`/app/positions?account=${ids['account.roth']}`);
  // Poll: the positions table mounts before listPositions resolves.
  await expect
    .poll(async () => (await readTable(page, 0)).rows.find((row) => row[0].startsWith('VTI'))?.[0])
    .toBe('VTImanual');

  await page.goto('/app/imports');
  await selectSnapshot(page, 'vanguard-sample.pb');
  await page.getByRole('button', { name: 'Process snapshot' }).click();
  await snack(page, 'Processed - 1 holding(s), 1 sweep(s) updated');

  await expect(page.locator('.status-chip')).toHaveText('Processed');
  await expect(page.locator('.status-chip')).toHaveClass(/processed/);
  await expect
    .poll(async () => (await readTable(page, 0)).rows[0][4])
    .toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  await expect(page.getByText('Last processing report (1 holding(s), 1 sweep(s) updated)')).toBeVisible();
  // In report order: GOLD is held in the Roth but absent from the
  // snapshot, then the sweep restatement, then the holdings count.
  await expect(reportLines(page)).toContainText([
    /GOLD is held here but absent from the snapshot/,
    /sweep set to \$55\.25/,
    /1 holding\(s\) updated/,
  ]);
  await expect(page.locator('ul.report li.warning')).toHaveCount(1);

  // The write really lands: the Roth's VTI position flips from manual
  // to plaid provenance (the chip text abuts the ticker).
  await page.goto(`/app/positions?account=${ids['account.roth']}`);
  const positions = await readTable(page, 0);
  const vti = positions.rows.find((row) => row[0].startsWith('VTI'));
  expect(vti?.[0]).toBe('VTIplaid');
});

test('unlinking a Plaid account makes processing warn instead of importing', async ({ page }) => {
  await page.goto('/app/imports');
  await selectSnapshot(page, 'vanguard-sample.pb');
  await pickLink(page, 'Roth IRA', 'Not linked');
  await snack(page, 'Link removed');
  await expect(linkSelect(page, 'Roth IRA')).toHaveText('Not linked');

  await page.getByRole('button', { name: 'Process snapshot' }).click();
  await snack(page, 'Processed - 0 holding(s), 0 sweep(s) updated');
  await expect(reportLines(page)).toContainText([/is not linked to an account - link it and re-process/]);
  await expect(page.locator('ul.report li.warning')).toHaveCount(1);
});

test('linking to a taxable account compares the lots instead of mutating them', async ({ page }) => {
  await page.goto('/app/imports');
  await selectSnapshot(page, 'vanguard-sample.pb');
  await pickLink(page, 'Roth IRA', 'Vanguard : Brokerage (USD)');
  await snack(page, 'Account linked - process to import');

  await page.getByRole('button', { name: 'Process snapshot' }).click();
  await snack(page, 'Processed - 0 holding(s), 0 sweep(s) updated');
  // Brokerage still holds 50 - 10 - 5 = 35 VTI shares; the snapshot
  // reports the Roth's 12, so the mismatch is reported, never applied.
  await expect(reportLines(page)).toContainText([
    /institution reports 12 shares, lots hold 35/,
    /taxable - compared only; 0 position\(s\) match/,
  ]);
});

test('uploads a snapshot from the file picker, selects it, then deletes it', async ({ page }) => {
  acceptConfirms(page);
  await page.goto('/app/imports');
  const asOf = new Date();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'e2e-upload.pb',
    mimeType: 'application/octet-stream',
    buffer: snapshotBytes(asOf),
  });
  await snack(page, 'e2e-upload.pb archived - link accounts, then process');

  await expect.poll(async () => (await readTable(page, 0)).rows.length).toBe(2);
  const table = await readTable(page, 0);
  expect(table.rows.map((row) => row[0])).toEqual(['e2e-upload.pb', 'vanguard-sample.pb']);
  expect(table.rows[0][1]).toBe(isoDate(asOf));
  expect(table.rows[0][3]).toBe('Uploaded');

  // Uploading auto-selects the new archive and shows its accounts.
  await expect(page.getByText('Accounts in e2e-upload.pb')).toBeVisible();
  const accounts = await readTable(page, 1);
  expect(accounts.rows).toEqual([
    ['E2E Institution', 'E2E Upload...9999', 'investment / brokerage', '1', 'Not linked'],
  ]);

  await page
    .locator('tr[mat-row]')
    .filter({ hasText: 'e2e-upload.pb' })
    .getByRole('button', { name: 'Delete snapshot' })
    .click();
  await snack(page, 'Snapshot deleted');
  await expect.poll(async () => (await readTable(page, 0)).rows.length).toBe(1);
  await expect(page.getByText('Accounts in e2e-upload.pb')).toHaveCount(0);
});

test('refuses a file that is not a bankferry snapshot, and an empty one', async ({ page }) => {
  await page.goto('/app/imports');
  const picker = page.locator('input[type="file"]');
  await picker.setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from([0xff, 0xff, 0xff, 0xff]),
  });
  await snack(page, 'the file is not a bankferry investments snapshot');
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('mat-snack-bar-container')).toHaveCount(0);

  await picker.setInputFiles({ name: 'empty.pb', mimeType: 'application/octet-stream', buffer: Buffer.from([]) });
  await snack(page, 'the uploaded file is empty');

  const table = await readTable(page, 0);
  expect(table.rows.map((row) => row[0])).toEqual(['vanguard-sample.pb']);
});

test('deleting the last snapshot leaves the bankferry empty note', async ({ page }) => {
  acceptConfirms(page);
  await page.goto('/app/imports');
  await selectSnapshot(page, 'vanguard-sample.pb');
  await page.getByRole('button', { name: 'Delete snapshot' }).click();
  await snack(page, 'Snapshot deleted');
  await expect(page.locator('.empty-note')).toContainText('bankferry investments export');
  await expect(page.locator('table[mat-table]')).toHaveCount(1);
  await expect(page.getByText('Accounts in vanguard-sample.pb')).toHaveCount(0);
});
