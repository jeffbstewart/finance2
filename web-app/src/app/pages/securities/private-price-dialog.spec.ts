// Unit spec for PrivatePriceDialog (docs/design/ui-testing.md,
// inventory "PrivatePricesPage -> PrivatePriceDialog"). The dialog is
// created directly with a stubbed MatDialogRef and MAT_DIALOG_DATA, so
// no overlay is involved; SecurityService is faked via installFakeApi.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PrivatePriceRowSchema,
  SecurityService,
  type AddPrivatePriceRequest,
  type PrivatePriceRow,
  type UpdatePrivatePriceRequest,
} from '../../../proto-gen/securities_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { date, money } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { PrivatePriceDialog, type PrivatePriceDialogData } from './private-price-dialog';

/** The seeder's newest GOLD row. Shared-infrastructure gap: there is
 *  no private-price builder in sample-data.ts yet. */
function goldRow(): PrivatePriceRow {
  return create(PrivatePriceRowSchema, {
    priceId: 21n,
    date: date('2026-08-16'),
    price: money('3358.5000', { display: '$3,358.50' }),
  });
}

type Sent = { year: number; month: number; day: number; price: string; id: bigint };

describe('PrivatePriceDialog', () => {
  let restoreApi: () => void;
  let added: Sent[];
  let updated: Sent[];
  let addRespond: () => object;
  let updateRespond: () => object;
  let close: ReturnType<typeof vi.fn>;
  let success: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  function sentOf(request: AddPrivatePriceRequest | UpdatePrivatePriceRequest): Sent {
    return {
      year: request.date?.year ?? 0,
      month: request.date?.month ?? 0,
      day: request.date?.day ?? 0,
      price: request.price?.value ?? '',
      id:
        'securityId' in request
          ? (request as AddPrivatePriceRequest).securityId
          : (request as UpdatePrivatePriceRequest).priceId,
    };
  }

  beforeEach(() => {
    added = [];
    updated = [];
    addRespond = () => ({ priceId: 99n });
    updateRespond = () => ({});
    close = vi.fn();

    restoreApi = installFakeApi(({ service }) => {
      service(SecurityService, {
        addPrivatePrice: (request) => {
          added.push(sentOf(request));
          return addRespond();
        },
        updatePrivatePrice: (request) => {
          updated.push(sentOf(request));
          return updateRespond();
        },
      });
    });
  });

  afterEach(() => {
    restoreApi();
    vi.restoreAllMocks();
  });

  async function open(data: PrivatePriceDialogData) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    });
    const notify = TestBed.inject(Notify);
    success = vi.spyOn(notify, 'success').mockImplementation(() => {});
    error = vi.spyOn(notify, 'error').mockImplementation(() => {});
    const fixture = TestBed.createComponent(PrivatePriceDialog);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function host(fixture: { nativeElement: HTMLElement }): HTMLElement {
    return fixture.nativeElement;
  }

  /** The input under the mat-form-field carrying `label`. */
  function inputFor(fixture: { nativeElement: HTMLElement }, label: string): HTMLInputElement {
    const field = Array.from(host(fixture).querySelectorAll('mat-form-field')).find(
      (f) => f.querySelector('mat-label')?.textContent?.trim() === label,
    );
    const input = field?.querySelector('input');
    if (!input) throw new Error(`no input labelled ${label}`);
    return input;
  }

  /** Types the way a user does so ngModel sees an input event - a bare
   *  field assignment never re-renders under zoneless. Dates are
   *  M/D/YYYY, which the native adapter parses as local time. */
  async function type(
    fixture: { nativeElement: HTMLElement; detectChanges(): void },
    label: string,
    text: string,
  ): Promise<void> {
    const input = inputFor(fixture, label);
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture as never);
  }

  /** Submit - the datepicker's calendar toggle is a button too. */
  function submitButton(fixture: { nativeElement: HTMLElement }): HTMLButtonElement {
    const button = Array.from(host(fixture).querySelectorAll('button')).find((b) =>
      b.textContent!.includes('Submit'),
    );
    if (!button) throw new Error('Submit button not rendered');
    return button;
  }

  function cancelButton(fixture: { nativeElement: HTMLElement }): HTMLButtonElement {
    const button = Array.from(host(fixture).querySelectorAll('button')).find((b) =>
      b.textContent!.includes('Cancel'),
    );
    if (!button) throw new Error('Cancel button not rendered');
    return button;
  }

  describe('add mode', () => {
    const data: PrivatePriceDialogData = { securityId: 7n };

    it('opens empty with Submit disabled and no error for the empty price', async () => {
      const fixture = await open(data);
      expect(host(fixture).querySelector('h2')!.textContent!.trim()).toBe('Add Price');
      expect(inputFor(fixture, 'Date').value).toBe('');
      expect(inputFor(fixture, 'Price Per Share').value).toBe('');
      expect(submitButton(fixture).disabled).toBe(true);
      expect(fixture.componentInstance.priceValid()).toBe(true); // empty is not "wrong"
      expect(host(fixture).textContent).not.toContain('Enter a plain decimal like 123.45');
    });

    it('keeps Submit disabled until both a date and a decimal price are present', async () => {
      const fixture = await open(data);
      await type(fixture, 'Date', '8/16/2026');
      expect(submitButton(fixture).disabled).toBe(true);
      await type(fixture, 'Price Per Share', '3358.50');
      expect(submitButton(fixture).disabled).toBe(false);
      // Clearing either half disables it again.
      await type(fixture, 'Price Per Share', '');
      expect(submitButton(fixture).disabled).toBe(true);
    });

    it('rejects non-decimal and negative prices client-side', async () => {
      const fixture = await open(data);
      await type(fixture, 'Date', '8/16/2026');
      for (const bad of ['abc', '-1', '1e3', '12.', '1,000']) {
        await type(fixture, 'Price Per Share', bad);
        expect(fixture.componentInstance.priceValid(), bad).toBe(false);
        expect(submitButton(fixture).disabled, bad).toBe(true);
      }
      await type(fixture, 'Price Per Share', '0');
      expect(fixture.componentInstance.priceValid()).toBe(true);
      expect(submitButton(fixture).disabled).toBe(false);
      expect(added).toEqual([]);
    });

    it('an unparseable date leaves the model null and Submit disabled', async () => {
      const fixture = await open(data);
      await type(fixture, 'Price Per Share', '10.00');
      await type(fixture, 'Date', 'not a date');
      expect(fixture.componentInstance.date).toBeNull();
      expect(submitButton(fixture).disabled).toBe(true);
    });

    // BUG: the <mat-error> is unreachable. mat-form-field only renders
    // its error slot when the control's own validators fail, and the
    // only validator here is `required` - a non-empty but malformed
    // price ("abc") is "valid" to Angular Forms, so the message never
    // reaches the DOM. Submit is still correctly disabled. Pinning
    // current behavior; see "Suspected bugs" in the PR.
    it('never shows the decimal hint message, even for a malformed price', async () => {
      const fixture = await open(data);
      await type(fixture, 'Price Per Share', 'abc');
      expect(fixture.componentInstance.priceValid()).toBe(false);
      expect(host(fixture).textContent).not.toContain('Enter a plain decimal like 123.45');
    });

    it('submits the civil date and trimmed price, notifies, and closes with true', async () => {
      const fixture = await open(data);
      await type(fixture, 'Date', '8/16/2026');
      await type(fixture, 'Price Per Share', '  3358.50  ');
      submitButton(fixture).click();
      await settle(fixture);
      expect(added).toEqual([{ year: 2026, month: 8, day: 16, price: '3358.50', id: 7n }]);
      expect(updated).toEqual([]);
      expect(success).toHaveBeenCalledWith('Price added');
      expect(close).toHaveBeenCalledWith(true);
    });

    it('surfaces a server rejection, stays open, and re-enables Submit', async () => {
      const fixture = await open(data);
      addRespond = () => {
        throw new ConnectError(
          'VTI is market-priced; manual price entries apply only to MANUAL-locus securities',
          Code.FailedPrecondition,
        );
      };
      await type(fixture, 'Date', '8/16/2026');
      await type(fixture, 'Price Per Share', '3358.50');
      submitButton(fixture).click();
      await settle(fixture);
      expect(error).toHaveBeenCalledTimes(1);
      expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe(
        'VTI is market-priced; manual price entries apply only to MANUAL-locus securities',
      );
      expect(close).not.toHaveBeenCalled();
      expect(fixture.componentInstance.busy()).toBe(false);
      expect(submitButton(fixture).disabled).toBe(false);
    });

    it('Cancel closes without calling any RPC', async () => {
      const fixture = await open(data);
      await type(fixture, 'Date', '8/16/2026');
      await type(fixture, 'Price Per Share', '3358.50');
      cancelButton(fixture).click();
      await settle(fixture);
      expect(close).toHaveBeenCalledTimes(1);
      // Valueless `mat-dialog-close` closes with the attribute's ""
      // - falsy, so PrivatePricesPage skips the reload.
      expect(close.mock.calls[0][0]).toBe('');
      expect(added).toEqual([]);
    });
  });

  describe('edit mode', () => {
    function editData(): PrivatePriceDialogData {
      return { securityId: 7n, row: goldRow() };
    }

    it('prefills the row date and the exact scale-4 price, enabling Submit', async () => {
      const fixture = await open(editData());
      expect(host(fixture).querySelector('h2')!.textContent!.trim()).toBe('Edit Price');
      expect(fixture.componentInstance.date).toEqual(new Date(2026, 7, 16));
      // The wire carries Money at scale 4; the field shows it verbatim.
      expect(fixture.componentInstance.price).toBe('3358.5000');
      expect(inputFor(fixture, 'Price Per Share').value).toBe('3358.5000');
      expect(submitButton(fixture).disabled).toBe(false);
    });

    it('updates by price id and closes with true', async () => {
      const fixture = await open(editData());
      await type(fixture, 'Price Per Share', '3400.00');
      await type(fixture, 'Date', '8/17/2026');
      submitButton(fixture).click();
      await settle(fixture);
      expect(updated).toEqual([{ year: 2026, month: 8, day: 17, price: '3400.00', id: 21n }]);
      expect(added).toEqual([]);
      expect(success).toHaveBeenCalledWith('Price updated');
      expect(close).toHaveBeenCalledWith(true);
    });

    it('reports a duplicate-date rejection and keeps the dialog open', async () => {
      const fixture = await open(editData());
      updateRespond = () => {
        throw new ConnectError('a price for 2026-05-23 already exists', Code.AlreadyExists);
      };
      await type(fixture, 'Date', '5/23/2026');
      submitButton(fixture).click();
      await settle(fixture);
      expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe(
        'a price for 2026-05-23 already exists',
      );
      expect(close).not.toHaveBeenCalled();
    });
  });
});
