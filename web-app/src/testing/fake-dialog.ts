// MatDialog stand-in for unit specs (docs/design/ui-testing.md).
//
// The footgun every dialog-owning page hit: MatDialogModule
// re-provides MatDialog, so a standalone page that imports it resolves
// MatDialog from ITS OWN injector — `TestBed.inject(MatDialog)` hands
// back a different instance and spies on it never fire. The stub must
// be installed on the component itself:
//
//   const dialog = fakeDialog();
//   provideFakeDialog(BrokersPage, dialog);   // before createComponent
//   ...
//   dialog.results.push(true);                // what afterClosed() yields
//   expect(dialog.opens[0].component).toBe(BrokerDialog);
import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';

export interface DialogOpen {
  component: unknown;
  config: { data?: unknown } | undefined;
}

export class FakeDialog {
  readonly opens: DialogOpen[] = [];
  /** Queued afterClosed() results, consumed in order; when empty the
   *  dialog "cancels" (undefined), which every page treats as no-op. */
  readonly results: unknown[] = [];

  open(component: unknown, config?: { data?: unknown }) {
    this.opens.push({ component, config });
    const result = this.results.length ? this.results.shift() : undefined;
    return { afterClosed: () => of(result), close: () => undefined };
  }

  get lastData(): unknown {
    return this.opens[this.opens.length - 1]?.config?.data;
  }
}

export function fakeDialog(): FakeDialog {
  return new FakeDialog();
}

/** Installs the stub on the page's own injector. Call before
 *  TestBed.createComponent. */
export function provideFakeDialog(component: Type<unknown>, dialog: FakeDialog): void {
  TestBed.overrideComponent(component, {
    add: { providers: [{ provide: MatDialog, useValue: dialog }] },
  });
}
