// Unit-lane drivers for Angular Material widgets - the twin of
// e2e/support/material.ts (docs/design/ui-testing.md). Zoneless change
// detection never sees a field assignment: drive the DOM the way a
// user would, then settle().
import type { ComponentFixture } from '@angular/core/testing';
import { settle } from './settle';

function host(fixture: ComponentFixture<unknown>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/** The control under the mat-label whose text equals or starts with
 *  `label` (so "Price Per Share" matches "Price Per Share *"). */
export function fieldByLabel(fixture: ComponentFixture<unknown>, label: string): HTMLElement {
  for (const formField of Array.from(host(fixture).querySelectorAll('mat-form-field'))) {
    const text = formField.querySelector('mat-label')?.textContent?.trim() ?? '';
    if (text === label || text.startsWith(label)) {
      const control = formField.querySelector<HTMLElement>('input, textarea, mat-select');
      if (control) return control;
    }
  }
  throw new Error(`no form field labelled "${label}"`);
}

/** Types into a labelled matInput so ngModel sees it. */
export async function typeInto(
  fixture: ComponentFixture<unknown>,
  label: string,
  value: string,
): Promise<void> {
  const input = fieldByLabel(fixture, label) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await settle(fixture);
}

/** Opens a labelled mat-select and picks the option with `optionText`.
 *  The open panel is found through the trigger's aria-controls - a
 *  just-closed panel can linger in the overlay container, so a global
 *  `mat-option` query may see two selects' options. */
export async function pickOption(
  fixture: ComponentFixture<unknown>,
  label: string,
  optionText: string,
): Promise<void> {
  const select = fieldByLabel(fixture, label);
  const trigger = select.querySelector<HTMLElement>('.mat-mdc-select-trigger') ?? select;
  trigger.click();
  await settle(fixture);
  const panelId =
    select.getAttribute('aria-controls') ??
    select.querySelector('[aria-controls]')?.getAttribute('aria-controls');
  const panel = panelId ? document.getElementById(panelId) : null;
  const scope: ParentNode = panel ?? document;
  const option = Array.from(scope.querySelectorAll<HTMLElement>('mat-option')).find(
    (o) => o.textContent?.trim() === optionText,
  );
  if (!option) throw new Error(`no option "${optionText}" for select "${label}"`);
  option.click();
  await settle(fixture);
}

/** Clicks the button with the given aria-label or visible text. */
export async function clickButton(fixture: ComponentFixture<unknown>, name: string): Promise<void> {
  const buttons = Array.from(host(fixture).querySelectorAll<HTMLButtonElement>('button'));
  const button = buttons.find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  );
  if (!button) throw new Error(`no button "${name}"`);
  button.click();
  await settle(fixture);
}

/** Flips the first mat-slide-toggle, or the one whose text has `label`. */
export async function clickToggle(fixture: ComponentFixture<unknown>, label?: string): Promise<void> {
  const toggles = Array.from(host(fixture).querySelectorAll<HTMLElement>('mat-slide-toggle'));
  const toggle = label ? toggles.find((t) => t.textContent?.includes(label)) : toggles[0];
  const button = toggle?.querySelector<HTMLButtonElement>('button[role="switch"]');
  if (!button) throw new Error(`no slide toggle ${label ?? ''}`.trim());
  button.click();
  await settle(fixture);
}

/** Cell texts of the table rows matching `selector` (default: body rows). */
export function readRows(fixture: ComponentFixture<unknown>, selector = 'tr[mat-row]'): string[][] {
  return Array.from(host(fixture).querySelectorAll(selector), (row) =>
    Array.from(row.querySelectorAll('th,td'), (c) => c.textContent?.trim() ?? ''),
  );
}

/** The fixture's visible text. */
export function textOf(fixture: ComponentFixture<unknown>): string {
  return host(fixture).textContent ?? '';
}

/** Removes leftover CDK overlays (open selects/dialogs) between specs. */
export function cleanupOverlays(): void {
  document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
}
