// Unit spec for MtmMarkDialog (docs/design/ui-testing.md, inventory
// "MtmMarks / MtmMarkDialog"): the record/edit flow for a PFIC sec. 1296
// year-end mark. The dialog is rendered directly with a stub
// MatDialogRef; the clock is pinned so the Dec 31 fallback date is
// deterministic.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MtmMarkSchema,
  PricingLocus,
  SecurityProfileSchema,
  SecurityService,
  SecurityType,
  TaxTreatment,
  type MtmMark,
  type RecordMtmMarkRequest,
  type SecurityProfile,
  type SuggestMtmMarkRequest,
  type UpdateMtmMarkRequest,
} from '../../../proto-gen/securities_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { civil, date, money, quantity } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { MtmMarkDialog, type MtmMarkDialogData } from './mtm-mark-dialog';

const TODAY = new Date(2026, 7, 20);

/** Shared-infrastructure gap: sample-data.ts has no SecurityProfile or
 *  MtmMark builder, so the seeder's EUFUND lives here for now. */
function eufund(): SecurityProfile {
  return create(SecurityProfileSchema, {
    securityId: 4n,
    ticker: 'EUFUND',
    description: 'European Index Fund',
    currencyCode: 'EUR',
    securityType: SecurityType.MUTUAL_FUND,
    pricingLocus: PricingLocus.MANUAL,
    taxTreatment: TaxTreatment.MARK_TO_MARKET,
  });
}

/** The seeder's lastYear mark: EUR 10,000 x 1.08 = $10,800. */
function mark2025(): MtmMark {
  return create(MtmMarkSchema, {
    markId: 22n,
    taxYear: 2025,
    markDate: date('2025-12-31'),
    quantity: quantity('100'),
    fmvLocal: money('10000.00', { currency: 'EUR', display: '\u20ac10,000.00' }),
    fxRate: quantity('1.08'),
    fmvUsd: money('10800.00', { display: '$10,800.00' }),
    basisBefore: money('9975.00', { display: '$9,975.00' }),
    basisAfter: money('10800.00', { display: '$10,800.00' }),
    ordinaryIncome: money('825.00', { display: '$825.00' }),
  });
}

/** What the server proposes for 2026 from the stored EUR price and the
 *  most recent FX row (the seeder's 1.16 from yesterday). */
function suggestion() {
  return {
    preview: create(MtmMarkSchema, {
      taxYear: 2026,
      markDate: date('2026-12-31'),
      quantity: quantity('100'),
      fmvLocal: money('10400.00', { currency: 'EUR', display: '\u20ac10,400.00' }),
      fxRate: quantity('1.16'),
      fmvUsd: money('12064.00', { display: '$12,064.00' }),
      basisBefore: money('10800.00', { display: '$10,800.00' }),
      basisAfter: money('12064.00', { display: '$12,064.00' }),
      ordinaryIncome: money('1264.00', { display: '$1,264.00' }),
    }),
    notes: ['price from 2026-08-13 (latest on or before 2026-12-31)'],
  };
}

describe('MtmMarkDialog', () => {
  let restoreApi: () => void;
  let suggested: SuggestMtmMarkRequest[];
  let recorded: RecordMtmMarkRequest[];
  let updated: UpdateMtmMarkRequest[];
  let suggestFails: ConnectError | undefined;
  let submitFails: ConnectError | undefined;
  let closed: unknown[];

  beforeEach(() => {
    // Only Date is faked: settle() relies on real setTimeout.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TODAY);
    suggested = [];
    recorded = [];
    updated = [];
    suggestFails = undefined;
    submitFails = undefined;
    closed = [];
    restoreApi = installFakeApi(({ service }) => {
      service(SecurityService, {
        suggestMtmMark: (request) => {
          suggested.push(request);
          if (suggestFails) throw suggestFails;
          return suggestion();
        },
        recordMtmMark: (request) => {
          recorded.push(request);
          if (submitFails) throw submitFails;
          return { mark: create(MtmMarkSchema, { ...mark2025(), taxYear: request.taxYear }) };
        },
        updateMtmMark: (request) => {
          updated.push(request);
          if (submitFails) throw submitFails;
          return { mark: mark2025() };
        },
      });
    });
  });

  afterEach(() => {
    restoreApi();
    vi.useRealTimers();
  });

  async function render(data: Partial<MtmMarkDialogData> = {}) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: MAT_DIALOG_DATA,
          useValue: { security: eufund(), taxYear: 2026, ...data } satisfies MtmMarkDialogData,
        },
        { provide: MatDialogRef, useValue: { close: (r: unknown) => closed.push(r) } },
      ],
    });
    const fixture = TestBed.createComponent(MtmMarkDialog);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  type Fixture = Awaited<ReturnType<typeof render>>;

  function host(fixture: Fixture): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function textOf(fixture: Fixture): string {
    return host(fixture).textContent!;
  }

  /** The matInput inside the form field carrying `label`. */
  function field(fixture: Fixture, label: string): HTMLInputElement {
    const wrapper = Array.from(host(fixture).querySelectorAll('mat-form-field')).find(
      (f) => f.querySelector('mat-label')?.textContent?.trim() === label,
    );
    const input = wrapper?.querySelector('input');
    if (!input) throw new Error(`no input labelled ${label}`);
    return input;
  }

  /** Types like a user so the ngModel view-to-model update runs - a
   *  bare field assignment never re-renders under zoneless. */
  async function type(fixture: Fixture, label: string, value: string): Promise<void> {
    const input = field(fixture, label);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture);
  }

  function notes(fixture: Fixture): string[] {
    return Array.from(host(fixture).querySelectorAll('p.note'), (p) => p.textContent!.trim());
  }

  function submitButton(fixture: Fixture): HTMLButtonElement {
    const button = Array.from(host(fixture).querySelectorAll('button')).find((b) =>
      /Record Mark|Save Mark/.test(b.textContent!),
    );
    if (!button) throw new Error('submit button not rendered');
    return button;
  }

  it('prefills the record form from the server suggestion', async () => {
    const fixture = await render();
    expect(suggested).toHaveLength(1);
    expect(String(suggested[0].securityId)).toBe('4');
    expect(suggested[0].taxYear).toBe(2026);

    expect(textOf(fixture)).toContain('Record Year-End Mark - EUFUND');
    expect(field(fixture, 'Tax Year').value).toBe('2026');
    expect(field(fixture, 'Mark Date').value).toBe('12/31/2026');
    expect(field(fixture, 'Shares Held').value).toBe('100');
    expect(field(fixture, 'Fair Market Value (EUR)').value).toBe('10400.00');
    expect(field(fixture, 'FX Rate (USD per EUR)').value).toBe('1.16');
    expect(notes(fixture)).toEqual(['price from 2026-08-13 (latest on or before 2026-12-31)']);
    expect(textOf(fixture)).toContain('Suggested ordinary income: $1,264.00');
    expect(submitButton(fixture).disabled).toBe(false);
    expect(field(fixture, 'Tax Year').disabled).toBe(false);
    expect(textOf(fixture)).not.toContain('The tax year is fixed');
  });

  it('survives a failed suggestion with a local Dec 31 date and the error in the notes', async () => {
    suggestFails = new ConnectError(
      'no purchase lots for EUFUND on or before 2026-12-31 - record the purchase first',
      Code.FailedPrecondition,
    );
    const fixture = await render();
    expect(field(fixture, 'Mark Date').value).toBe('12/31/2026');
    expect(field(fixture, 'Shares Held').value).toBe('');
    expect(field(fixture, 'Fair Market Value (EUR)').value).toBe('');
    expect(notes(fixture)).toEqual([
      'no purchase lots for EUFUND on or before 2026-12-31 - record the purchase first',
    ]);
    expect(textOf(fixture)).not.toContain('Suggested ordinary income');
    expect(submitButton(fixture).disabled).toBe(true);
  });

  it('re-suggests for an in-range tax year and ignores an out-of-range one', async () => {
    const fixture = await render();
    await type(fixture, 'Tax Year', '2024');
    expect(suggested.map((r) => r.taxYear)).toEqual([2026, 2024]);

    await type(fixture, 'Tax Year', '189');
    expect(suggested.map((r) => r.taxYear)).toEqual([2026, 2024]);
    await type(fixture, 'Tax Year', '');
    expect(suggested.map((r) => r.taxYear)).toEqual([2026, 2024]);
  });

  it('prefills the edit form from the mark and never asks for a suggestion', async () => {
    const fixture = await render({ taxYear: 2025, mark: mark2025(), hasLaterMarks: false });
    expect(suggested).toEqual([]);
    expect(textOf(fixture)).toContain('Edit Year-End Mark - EUFUND');
    expect(field(fixture, 'Mark Date').value).toBe('12/31/2025');
    expect(field(fixture, 'Shares Held').value).toBe('100');
    expect(field(fixture, 'Fair Market Value (EUR)').value).toBe('10000.00');
    expect(field(fixture, 'FX Rate (USD per EUR)').value).toBe('1.08');
    expect(submitButton(fixture).textContent).toContain('Save Mark');
    expect(notes(fixture)).toEqual([]);
    expect(textOf(fixture)).not.toContain('Suggested ordinary income');
  });

  it('locks the tax year in edit mode and explains why', async () => {
    const fixture = await render({ taxYear: 2025, mark: mark2025() });
    const year = field(fixture, 'Tax Year');
    expect(year.value).toBe('2025');
    expect(year.disabled).toBe(true);
    expect(textOf(fixture)).toContain('The tax year is fixed - delete and re-record to move a mark');
  });

  it('warns that later marks restate when editing an earlier mark', async () => {
    const fixture = await render({ taxYear: 2025, mark: mark2025(), hasLaterMarks: true });
    expect(notes(fixture)).toEqual([
      'later marks restate automatically against the edited basis',
    ]);
  });

  it('disables submit for anything that is not a plain non-negative decimal', async () => {
    const fixture = await render();
    const submit = submitButton(fixture);

    await type(fixture, 'Shares Held', 'one hundred');
    expect(submit.disabled).toBe(true);
    await type(fixture, 'Shares Held', '-100');
    expect(submit.disabled).toBe(true);
    await type(fixture, 'Shares Held', '1e2');
    expect(submit.disabled).toBe(true);
    await type(fixture, 'Shares Held', '');
    expect(submit.disabled).toBe(true);
    await type(fixture, 'Shares Held', '100.5');
    expect(submit.disabled).toBe(false);

    await type(fixture, 'Fair Market Value (EUR)', '$10,400');
    expect(submit.disabled).toBe(true);
    await type(fixture, 'Fair Market Value (EUR)', '10400');
    expect(submit.disabled).toBe(false);

    await type(fixture, 'FX Rate (USD per EUR)', '');
    expect(submit.disabled).toBe(true);
    await type(fixture, 'FX Rate (USD per EUR)', '1.16');
    expect(submit.disabled).toBe(false);

    // An unparseable date lands as null through the datepicker input.
    await type(fixture, 'Mark Date', 'sometime in December');
    expect(fixture.componentInstance.markDate).toBeNull();
    expect(submit.disabled).toBe(true);
  });

  it('records the mark from the edited fields and closes with success', async () => {
    const fixture = await render();
    const successSpy = vi.spyOn(TestBed.inject(Notify), 'success');
    await type(fixture, 'Mark Date', '12/30/2026');
    await type(fixture, 'Shares Held', ' 100 ');
    await type(fixture, 'Fair Market Value (EUR)', ' 10500.00 ');
    await type(fixture, 'FX Rate (USD per EUR)', ' 1.2 ');
    submitButton(fixture).click();
    await settle(fixture);

    expect(recorded).toHaveLength(1);
    const [request] = recorded;
    expect(String(request.securityId)).toBe('4');
    expect(request.taxYear).toBe(2026);
    expect(request.markDate).toEqual(civil('2026-12-30'));
    expect(request.quantity?.value).toBe('100');
    expect(request.fmvLocal?.value).toBe('10500.00');
    expect(request.fxRate?.value).toBe('1.2');
    expect(updated).toEqual([]);
    expect(successSpy).toHaveBeenCalledWith('2026 mark recorded - ordinary income $825.00');
    expect(closed).toEqual([true]);
  });

  it('updates by mark id in edit mode, never re-sending the tax year', async () => {
    const fixture = await render({ taxYear: 2025, mark: mark2025(), hasLaterMarks: true });
    const successSpy = vi.spyOn(TestBed.inject(Notify), 'success');
    await type(fixture, 'Fair Market Value (EUR)', '9800');
    submitButton(fixture).click();
    await settle(fixture);

    expect(recorded).toEqual([]);
    expect(updated).toHaveLength(1);
    expect(String(updated[0].markId)).toBe('22');
    expect(updated[0].markDate).toEqual(civil('2025-12-31'));
    expect(updated[0].fmvLocal?.value).toBe('9800');
    expect(updated[0].quantity?.value).toBe('100');
    expect(successSpy).toHaveBeenCalledWith('2025 mark updated - ordinary income $825.00');
    expect(closed).toEqual([true]);
  });

  it('keeps the dialog open and re-enables submit when the server rejects', async () => {
    const fixture = await render();
    const errorSpy = vi.spyOn(TestBed.inject(Notify), 'error');
    submitFails = new ConnectError(
      'marks must be recorded in tax-year order - the latest is 2025',
      Code.FailedPrecondition,
    );
    submitButton(fixture).click();
    await settle(fixture);

    expect(recorded).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0][0] as ConnectError).rawMessage).toBe(
      'marks must be recorded in tax-year order - the latest is 2025',
    );
    expect(closed).toEqual([]);
    expect(fixture.componentInstance.busy()).toBe(false);
    expect(submitButton(fixture).disabled).toBe(false);
  });

  it('leaves Record enabled with a blank tax year and sends year 0', async () => {
    const fixture = await render();
    await type(fixture, 'Tax Year', '');
    // BUG: valid() checks the mark date and the three decimals but never
    // the tax year, so clearing the field leaves Record enabled and the
    // RPC goes out with year 0 - which only the server rejects ("tax
    // year 0 is out of range"). The same hole lets an out-of-range year
    // like 189 through, where loadSuggestion already declines to ask.
    // Pinning the current behavior.
    expect(submitButton(fixture).disabled).toBe(false);
    submitButton(fixture).click();
    await settle(fixture);
    expect(recorded.map((r) => r.taxYear)).toEqual([0]);
  });

  it('cancels without touching the server', async () => {
    const fixture = await render();
    const cancel = Array.from(host(fixture).querySelectorAll('button')).find((b) =>
      b.textContent!.includes('Cancel'),
    )!;
    cancel.click();
    await settle(fixture);
    expect(recorded).toEqual([]);
    expect(updated).toEqual([]);
    // The bare `mat-dialog-close` attribute closes with "" - falsy, so
    // MtmMarks treats it as a dismissal and skips the reload.
    expect(closed).toEqual(['']);
  });
});
