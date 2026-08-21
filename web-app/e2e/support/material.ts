// Interaction helpers for Angular Material widgets in the e2e lane
// (docs/design/ui-testing.md). Several selects carry bigint/object
// option values — always pick by visible option text, never by value.
import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { COOKIE_FILE } from '../global-setup';
import { resetAndSeed } from './api';

/** The session cookie captured by global setup. */
export function sessionCookie(): string {
  return readFileSync(COOKIE_FILE, 'utf8').trim();
}

/** Wipe + reseed the canonical portfolio (call in beforeEach). */
export async function seedPortfolio(): Promise<Record<string, bigint>> {
  return resetAndSeed(sessionCookie());
}

/** Opens a mat-select by its floating label and picks an option. */
export async function pickSelect(page: Page, label: string, optionText: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: optionText }).click();
}

/** Types into a matInput/datepicker input located by label. */
export async function fillField(page: Page, label: string, value: string): Promise<void> {
  await page.getByRole('textbox', { name: label }).fill(value);
}

/** Flips a mat-slide-toggle located by its label text. */
export async function setToggle(page: Page, label: string, on: boolean): Promise<void> {
  const toggle = page.getByRole('switch', { name: label });
  if ((await toggle.isChecked()) !== on) await toggle.click();
}

/** Reads a mat-table into arrays of cell texts; index selects among
 *  multiple tables on the page. Includes header and footer rows. */
export async function readTable(
  page: Page,
  index = 0,
): Promise<{ header: string[]; rows: string[][]; footer: string[] }> {
  const table = page.locator('table[mat-table]').nth(index);
  await expect(table).toBeVisible();
  const texts = async (selector: string) =>
    table.locator(selector).evaluateAll((rows) =>
      rows.map((row) => Array.from(row.querySelectorAll('th,td'), (c) => c.textContent?.trim() ?? '')),
    );
  const [headerRows, bodyRows, footerRows] = await Promise.all([
    texts('tr[mat-header-row]'),
    texts('tr[mat-row]'),
    texts('tr[mat-footer-row]'),
  ]);
  return { header: headerRows[0] ?? [], rows: bodyRows, footer: footerRows[0] ?? [] };
}

/** Asserts a snackbar containing `text` appears (8s error window). */
export async function expectSnackbar(page: Page, text: string): Promise<void> {
  await expect(page.locator('mat-snack-bar-container')).toContainText(text, { timeout: 9_000 });
}

/** Auto-accepts native window.confirm dialogs for this page. */
export function acceptConfirms(page: Page): void {
  page.on('dialog', (dialog) => void dialog.accept());
}
