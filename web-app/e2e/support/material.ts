// Interaction helpers for Angular Material widgets in the e2e lane
// (docs/design/ui-testing.md). Additive by policy: existing helpers
// keep their semantics; gaps the first fourteen page assignments
// reported became new helpers (consolidation, 2026-08-21).
import { expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { COOKIE_FILE } from '../global-setup';
import { resetAndSeed } from './api';

/** The session cookie captured by global setup. */
export function sessionCookie(): string {
  return readFileSync(COOKIE_FILE, 'utf8').trim();
}

/** An unauthenticated browser: `test.use({ storageState: NO_SESSION })`.
 *  Never sign out through the UI in a spec - logout revokes the shared
 *  session server-side for every later spec. */
export const NO_SESSION = { cookies: [], origins: [] } as const;

/** Wipe + reseed the canonical portfolio (call in beforeEach). */
export async function seedPortfolio(): Promise<Record<string, bigint>> {
  return resetAndSeed(sessionCookie());
}

export interface LabelOptions {
  /** Exact accessible-name match. Use whenever one label is a
   *  substring of another ("US Stock %" is inside "Non US Stock %"). */
  exact?: boolean;
  /** Which of several same-labelled controls (0-based). */
  index?: number;
}

function nth(locator: Locator, index?: number): Locator {
  return index === undefined ? locator : locator.nth(index);
}

/** Opens a mat-select by its floating label and picks an option by
 *  its visible text - several selects carry bigint/object values. */
export async function pickSelect(
  page: Page,
  label: string,
  optionText: string,
  options: LabelOptions = {},
): Promise<void> {
  await nth(page.getByRole('combobox', { name: label, exact: options.exact }), options.index).click();
  // Wait for THIS select's panel: a previous panel may still be
  // detaching, and an option clicked mid-animation is "not stable".
  const listbox = page.getByRole('listbox').last();
  await expect(listbox).toBeVisible();
  await listbox.getByRole('option', { name: optionText, exact: options.exact }).click();
  await expect(listbox).toBeHidden();
}

/** Types into a matInput/datepicker input located by label. Password
 *  inputs expose no textbox role - locate those by `getByLabel`. */
export async function fillField(
  page: Page,
  label: string,
  value: string,
  options: LabelOptions = {},
): Promise<void> {
  await nth(page.getByRole('textbox', { name: label, exact: options.exact }), options.index).fill(value);
}

/** Flips a mat-slide-toggle located by its label text. */
export async function setToggle(page: Page, label: string, on: boolean): Promise<void> {
  const toggle = page.getByRole('switch', { name: label });
  if ((await toggle.isChecked()) !== on) await toggle.click();
}

/** Sets the nth mat-checkbox on the page (or within `within`). */
export async function setCheckbox(
  page: Page,
  index: number,
  on: boolean,
  within?: Locator,
): Promise<void> {
  const box = (within ?? page).getByRole('checkbox').nth(index);
  if ((await box.isChecked()) !== on) await box.click();
}

/** The open Material dialog. */
export function dialog(page: Page): Locator {
  return page.getByRole('dialog');
}

/** Stepper navigation inside the open dialog (the sell stepper keeps
 *  a Next button in every step; the visible one is the active step's). */
export async function stepperNext(page: Page): Promise<void> {
  await dialog(page).getByRole('button', { name: 'Next' }).filter({ visible: true }).click();
}

export async function stepperBack(page: Page): Promise<void> {
  await dialog(page).getByRole('button', { name: 'Back' }).filter({ visible: true }).click();
}

/** Reads a mat-table into arrays of raw cell text; index selects among
 *  multiple tables on the page. Includes header and footer rows.
 *  ONE-SHOT: it does not retry. Before reading on first load or after
 *  a mutation, wait with `expectRows`, or assert through
 *  `expect.poll(() => readTable(page))`. Raw text concatenates nested
 *  elements ("VTImanual", "editdelete") - see `readCells` for text
 *  that keeps element boundaries and drops icon ligatures. */
export async function readTable(
  page: Page,
  index = 0,
): Promise<{ header: string[]; rows: string[][]; footer: string[] }> {
  return readTableIn(page.locator('table[mat-table]').nth(index));
}

/** `readTable` scoped to a locator (a tab body, a component root). */
export async function readTableIn(
  table: Locator,
): Promise<{ header: string[]; rows: string[][]; footer: string[] }> {
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

/** Body rows as clean cell text: nested elements are space-separated
 *  ("VTI manual", "Roth IRA ...5678") and icon-button ligatures are
 *  dropped (an actions cell reads ""). Auto-waits for the table. */
export async function readCells(page: Page, index = 0): Promise<string[][]> {
  const table = page.locator('table[mat-table]').nth(index);
  await expect(table).toBeVisible();
  return table.locator('tr[mat-row]').evaluateAll((rows) =>
    rows.map((row) =>
      Array.from(row.querySelectorAll('td'), (cell) => {
        const clone = cell.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('mat-icon, button').forEach((el) => el.remove());
        const parts: string[] = [];
        const walk = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const t = node.textContent?.trim();
            if (t) parts.push(t);
          } else {
            node.childNodes.forEach(walk);
          }
        };
        walk(clone);
        return parts.join(' ');
      }),
    ),
  );
}

/** Waits until the table has exactly `count` body rows - the guard to
 *  call before a one-shot `readTable` on first load or after a mutation. */
export async function expectRows(page: Page, count: number, index = 0): Promise<void> {
  await expect(page.locator('table[mat-table]').nth(index).locator('tr[mat-row]')).toHaveCount(count);
}

/** The body row whose text contains `text` (for per-row actions). */
export function rowFor(page: Page, text: string, index = 0): Locator {
  return page.locator('table[mat-table]').nth(index).locator('tr[mat-row]').filter({ hasText: text });
}

/** Asserts a snackbar containing `text` appears (8s error window).
 *  Filters by text: snackbars overlap (a success toast can still be
 *  showing when the next one arrives), so a bare container locator
 *  trips strict mode. */
export async function expectSnackbar(page: Page, text: string): Promise<void> {
  await expect(
    page.locator('mat-snack-bar-container').filter({ hasText: text }),
  ).toBeVisible({ timeout: 9_000 });
}

/** Auto-accepts native window.confirm dialogs for this page. */
export function acceptConfirms(page: Page): void {
  page.on('dialog', (dialog) => void dialog.accept());
}

/** Auto-declines native window.confirm dialogs for this page. */
export function dismissConfirms(page: Page): void {
  page.on('dialog', (dialog) => void dialog.dismiss());
}

/** Uploads a file through a hidden file input opened by the button
 *  named `buttonName` (the Imports screen's "Upload snapshot"). */
export async function uploadFile(page: Page, buttonName: string, path: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: buttonName }).click();
  await (await chooser).setFiles(path);
}
