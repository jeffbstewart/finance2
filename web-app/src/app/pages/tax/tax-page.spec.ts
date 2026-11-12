// Unit spec for TaxPage (docs/design/ui-testing.md, inventory "TaxPage").
// Fake PositionService via installFakeApi; the clock is pinned so the
// previous-calendar-year default is deterministic.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GetTaxReportResponseSchema,
  MtmIncomeRowSchema,
  PositionService,
  TaxReportRowSchema,
  type GetTaxReportRequest,
  type GetTaxReportResponse,
} from '../../../proto-gen/positions_pb';
import { Notify } from '../../core/notify';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { date, money } from '../../../testing/wire';
import { TaxPage } from './tax-page';

/** Mirrors the seeder's lastYear VTI sale (LT $233.60 / ST $35.40) and
 *  the lastYear EUFUND mark. Shared-infrastructure gap: sample-data.ts
 *  has no tax-report builder yet, so it lives here for now. */
function sampleTaxReport(): GetTaxReportResponse {
  return create(GetTaxReportResponseSchema, {
    rows: [
      create(TaxReportRowSchema, {
        brokerName: 'Vanguard',
        accountName: 'Brokerage',
        ticker: 'VTI',
        bought: date('2024-03-01'),
        sold: date('2025-06-15'),
        purchasePricePerShare: money('150.00', { display: '$150.00' }),
        salePricePerShare: money('190.00', { display: '$190.00' }),
        purchaseCosts: money('1.00', { display: '$1.00' }),
        saleCosts: money('5.40', { display: '$5.40' }),
        shortTermGain: money('0', { display: '$0.00' }),
        longTermGain: money('233.60', { display: '$233.60' }),
      }),
      create(TaxReportRowSchema, {
        brokerName: 'Vanguard',
        accountName: 'Brokerage',
        ticker: 'VTI',
        bought: date('2025-01-20'),
        sold: date('2025-06-15'),
        purchasePricePerShare: money('180.00', { display: '$180.00' }),
        salePricePerShare: money('190.00', { display: '$190.00' }),
        purchaseCosts: money('1.00', { display: '$1.00' }),
        saleCosts: money('3.60', { display: '$3.60' }),
        shortTermGain: money('35.40', { display: '$35.40' }),
        longTermGain: money('0', { display: '$0.00' }),
      }),
    ],
    totalShortTermGain: money('35.40', { display: '$35.40' }),
    totalLongTermGain: money('233.60', { display: '$233.60' }),
    totalGain: money('269.00', { display: '$269.00' }),
    notes: ['1 sale(s) in non-USD accounts are excluded pending the FX tax-treatment ruling'],
    mtmRows: [
      create(MtmIncomeRowSchema, {
        ticker: 'EUFUND',
        taxYear: 2025,
        markDate: date('2025-12-31'),
        fmvUsd: money('10800.00', { display: '$10,800.00' }),
        basisBefore: money('9975.00', { display: '$9,975.00' }),
        ordinaryIncome: money('825.00', { display: '$825.00' }),
      }),
    ],
    totalMtmOrdinaryIncome: money('825.00', { display: '$825.00' }),
  });
}

function emptyTaxReport(): GetTaxReportResponse {
  return create(GetTaxReportResponseSchema, {
    totalShortTermGain: money('0', { display: '$0.00' }),
    totalLongTermGain: money('0', { display: '$0.00' }),
    totalGain: money('0', { display: '$0.00' }),
    totalMtmOrdinaryIncome: money('0', { display: '$0.00' }),
  });
}

type Range = { from: string; to: string };

function rangeOf(request: GetTaxReportRequest): Range {
  const iso = (d?: { year: number; month: number; day: number }) =>
    d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : '';
  return { from: iso(request.from), to: iso(request.to) };
}

describe('TaxPage', () => {
  let restoreApi: () => void;
  let requests: Range[];
  let respond: (request: GetTaxReportRequest) => GetTaxReportResponse;

  beforeEach(() => {
    // Only Date is faked: settle() relies on real setTimeout.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 20));
    requests = [];
    respond = () => sampleTaxReport();
    restoreApi = installFakeApi(({ service }) => {
      service(PositionService, {
        getTaxReport: (request) => {
          requests.push(rangeOf(request));
          return respond(request);
        },
      });
    });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
  });

  afterEach(() => {
    restoreApi();
    vi.useRealTimers();
  });

  async function render() {
    const fixture = TestBed.createComponent(TaxPage);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function textOf(fixture: { nativeElement: HTMLElement }): string {
    return fixture.nativeElement.textContent!;
  }

  function tables(fixture: { nativeElement: HTMLElement }): HTMLTableElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('table[mat-table]'));
  }

  /** The Submit button - the datepicker toggles are buttons too. */
  function submitButton(fixture: { nativeElement: HTMLElement }): HTMLButtonElement {
    const button = Array.from(fixture.nativeElement.querySelectorAll('button')).find((b) =>
      b.textContent!.includes('Submit'),
    );
    if (!button) throw new Error('Submit button not rendered');
    return button;
  }

  /** Types into a datepicker input (located by its mat-label) the way
   *  a user does, so the input event marks the view dirty - a bare
   *  field assignment never re-renders under zoneless. `text` is
   *  M/D/YYYY, which the native adapter parses as local time. */
  async function typeDate(
    fixture: { nativeElement: HTMLElement; detectChanges(): void },
    label: string,
    text: string,
  ): Promise<void> {
    const field = Array.from(fixture.nativeElement.querySelectorAll('mat-form-field')).find(
      (f) => f.querySelector('mat-label')?.textContent?.trim() === label,
    );
    const input = field?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error(`no datepicker input labelled ${label}`);
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture as never);
  }

  function cells(table: HTMLTableElement, rowSelector: string): string[][] {
    return Array.from(table.querySelectorAll(rowSelector), (row) =>
      Array.from(row.querySelectorAll('th,td'), (c) => c.textContent!.trim()),
    );
  }

  it('auto-runs for the previous calendar year on construction', async () => {
    const fixture = await render();
    expect(requests).toEqual([{ from: '2025-01-01', to: '2025-12-31' }]);
    expect(fixture.componentInstance.from).toEqual(new Date(2025, 0, 1));
    expect(fixture.componentInstance.to).toEqual(new Date(2025, 11, 31));
  });

  it('renders sale rows with blank zero cells and footer totals', async () => {
    const fixture = await render();
    const [sales] = tables(fixture);
    const rows = cells(sales, 'tr[mat-row]');
    expect(rows).toHaveLength(2);
    // broker, account, ticker, bought, sold, buy, sale, buyCosts, saleCosts, ST, LT
    expect(rows[0]).toEqual([
      'Vanguard', 'Brokerage', 'VTI', '2024-03-01', '2025-06-15',
      '$150.00', '$190.00', '$1.00', '$5.40', '', '$233.60',
    ]);
    expect(rows[1][9]).toBe('$35.40');
    expect(rows[1][10]).toBe('');
    const [footer] = cells(sales, 'tr[mat-footer-row]');
    expect(footer[0]).toBe('Total');
    expect(footer[9]).toBe('$35.40');
    expect(footer[10]).toBe('$233.60');
    expect(textOf(fixture)).toContain('Total gain: $269.00');
    expect(textOf(fixture)).not.toContain('No taxable sales in this range.');
  });

  it('renders the PFIC table and notes as footnotes when present', async () => {
    const fixture = await render();
    const [, mtm] = tables(fixture);
    expect(textOf(fixture)).toContain('PFIC Mark-to-Market Ordinary Income');
    expect(cells(mtm, 'tr[mat-row]')).toEqual([
      ['EUFUND', '2025', '2025-12-31', '$10,800.00', '$9,975.00', '$825.00'],
    ]);
    const [footer] = cells(mtm, 'tr[mat-footer-row]');
    expect(footer[0]).toBe('Total');
    expect(footer[5]).toBe('$825.00');
    const footnotes = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('p.footnote'),
      (p) => p.textContent!.trim(),
    );
    expect(footnotes).toEqual([
      '1 sale(s) in non-USD accounts are excluded pending the FX tax-treatment ruling',
    ]);
  });

  it('shows the empty note and hides the PFIC table when nothing is in range', async () => {
    respond = () => emptyTaxReport();
    const fixture = await render();
    expect(tables(fixture)).toHaveLength(1);
    expect(textOf(fixture)).toContain('No taxable sales in this range.');
    expect(textOf(fixture)).not.toContain('PFIC Mark-to-Market');
    expect(textOf(fixture)).toContain('Total gain: $0.00');
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('p.footnote')).toHaveLength(0);
  });

  it('keeps the report hidden until the RPC resolves', async () => {
    let release!: (r: GetTaxReportResponse) => void;
    respond = () => new Promise<GetTaxReportResponse>((resolve) => (release = resolve)) as never;
    const fixture = TestBed.createComponent(TaxPage);
    fixture.detectChanges();
    await settle(fixture);
    expect(tables(fixture)).toHaveLength(0);
    expect(textOf(fixture)).not.toContain('Total gain');
    release(sampleTaxReport());
    await settle(fixture);
    expect(tables(fixture)).toHaveLength(2);
  });

  it('disables Submit with an inline message when From is after To', async () => {
    const fixture = await render();
    const page = fixture.componentInstance;
    await typeDate(fixture, 'From', '1/1/2026');
    expect(page.from).toEqual(new Date(2026, 0, 1));
    const submit = submitButton(fixture);
    expect(submit.disabled).toBe(true);
    expect(textOf(fixture)).toContain('From must be on or before To');
    submit.click();
    await page.run();
    await settle(fixture);
    expect(requests).toHaveLength(1); // invalid range never reaches the server

    await typeDate(fixture, 'To', '1/1/2026'); // From == To is valid
    expect(submit.disabled).toBe(false);
    expect(textOf(fixture)).not.toContain('From must be on or before To');
  });

  it('Submit re-queries with the edited range', async () => {
    const fixture = await render();
    await typeDate(fixture, 'From', '1/1/2024');
    await typeDate(fixture, 'To', '12/31/2024');
    expect(requests).toHaveLength(1); // editing alone does not re-query
    submitButton(fixture).click();
    await settle(fixture);
    expect(requests).toEqual([
      { from: '2025-01-01', to: '2025-12-31' },
      { from: '2024-01-01', to: '2024-12-31' },
    ]);
  });

  it('routes an RPC failure to the error snackbar and keeps the last report', async () => {
    const fixture = await render();
    const notify = TestBed.inject(Notify);
    const errorSpy = vi.spyOn(notify, 'error');
    respond = () => {
      throw new ConnectError('from must not be after to', Code.InvalidArgument);
    };
    await fixture.componentInstance.run();
    await settle(fixture);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const err = errorSpy.mock.calls[0][0] as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.rawMessage).toBe('from must not be after to');
    expect(tables(fixture)).toHaveLength(2); // previous report still shown
  });

  it('blankZero blanks missing and zero money, passes through the rest', () => {
    const fixture = TestBed.createComponent(TaxPage);
    const page = fixture.componentInstance;
    expect(page.blankZero(undefined)).toBe('');
    expect(page.blankZero(money('0', { display: '$0.00' }))).toBe('');
    expect(page.blankZero(money('-12.50', { display: '-$12.50' }))).toBe('-$12.50');
    expect(page.blankZero(money('233.60', { display: '$233.60' }))).toBe('$233.60');
  });
});
