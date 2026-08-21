// Unit spec for MtmMarks (docs/design/ui-testing.md, inventory
// "MtmMarks / MtmMarkDialog"): the PFIC §1296 ledger tab. The fake
// SecurityService stands in for the backend; MatDialog is resolved
// from the component's own injector — the standalone component
// imports MatDialogModule, which re-provides MatDialog, so
// TestBed.inject(MatDialog) is a different instance and a spy on it
// would never fire.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog, type MatDialogRef } from '@angular/material/dialog';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MtmMarkSchema,
  PricingLocus,
  SecurityProfileSchema,
  SecurityService,
  SecurityType,
  TaxTreatment,
  type MtmMark,
  type SecurityProfile,
} from '../../../proto-gen/securities_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { date, money, quantity } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { MtmMarkDialog, type MtmMarkDialogData } from './mtm-mark-dialog';
import { MtmMarks } from './mtm-marks';

/** The seeder's clock: "today" is fixed so `currentYear − 1` is
 *  deterministic (the seeded marks are lastYear−1 and lastYear). */
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

/** EUR 9,500 × 1.05 = $9,975 over the $9,911 acquisition-cost floor. */
function mark2024(): MtmMark {
  return create(MtmMarkSchema, {
    markId: 21n,
    taxYear: 2024,
    markDate: date('2024-12-31'),
    quantity: quantity('100'),
    fmvLocal: money('9500.00', { currency: 'EUR', display: '€9,500.00' }),
    fxRate: quantity('1.05'),
    fmvUsd: money('9975.00', { display: '$9,975.00' }),
    basisBefore: money('9911.00', { display: '$9,911.00' }),
    basisAfter: money('9975.00', { display: '$9,975.00' }),
    ordinaryIncome: money('64.00', { display: '$64.00' }),
  });
}

/** EUR 10,000 × 1.08 = $10,800 over the carried-forward $9,975 basis. */
function mark2025(): MtmMark {
  return create(MtmMarkSchema, {
    markId: 22n,
    taxYear: 2025,
    markDate: date('2025-12-31'),
    quantity: quantity('100'),
    fmvLocal: money('10000.00', { currency: 'EUR', display: '€10,000.00' }),
    fxRate: quantity('1.08'),
    fmvUsd: money('10800.00', { display: '$10,800.00' }),
    basisBefore: money('9975.00', { display: '$9,975.00' }),
    basisAfter: money('10800.00', { display: '$10,800.00' }),
    ordinaryIncome: money('825.00', { display: '$825.00' }),
  });
}

describe('MtmMarks', () => {
  let restoreApi: () => void;
  let listed: string[];
  let deleted: string[];
  let marks: () => MtmMark[];
  let listFails: ConnectError | undefined;
  let deleteFails: ConnectError | undefined;

  beforeEach(() => {
    // Only Date is faked: settle() relies on real setTimeout.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TODAY);
    listed = [];
    deleted = [];
    marks = () => [mark2024(), mark2025()];
    listFails = undefined;
    deleteFails = undefined;
    restoreApi = installFakeApi(({ service }) => {
      service(SecurityService, {
        listMtmMarks: (request) => {
          listed.push(String(request.securityId));
          if (listFails) throw listFails;
          return {
            marks: marks(),
            acquisitionCostUsd: money('9911.00', { display: '$9,911.00' }),
          };
        },
        deleteMtmMark: (request) => {
          deleted.push(String(request.markId));
          if (deleteFails) throw deleteFails;
          return {};
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
    vi.unstubAllGlobals();
  });

  async function render(security: SecurityProfile = eufund()) {
    const fixture = TestBed.createComponent(MtmMarks);
    fixture.componentRef.setInput('security', security);
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

  function cells(fixture: Fixture, rowSelector: string): string[][] {
    return Array.from(host(fixture).querySelectorAll(rowSelector), (row) =>
      Array.from(row.querySelectorAll('th,td'), (c) => c.textContent!.trim()),
    );
  }

  function buttons(fixture: Fixture, label: string): HTMLButtonElement[] {
    return Array.from(host(fixture).querySelectorAll<HTMLButtonElement>('button')).filter(
      (b) => b.getAttribute('aria-label') === label,
    );
  }

  /** Spies on the MatDialog the component actually injected. */
  function stubDialog(fixture: Fixture, closedWith: unknown) {
    const dialog = fixture.debugElement.injector.get(MatDialog);
    return vi.spyOn(dialog, 'open').mockReturnValue({
      afterClosed: () => of(closedWith),
    } as unknown as MatDialogRef<unknown>);
  }

  /** The typed dialog config the component passed to MatDialog.open. */
  function dialogData(open: ReturnType<typeof stubDialog>, index = 0): MtmMarkDialogData {
    return open.mock.calls[index][1]!.data as MtmMarkDialogData;
  }

  function changes(fixture: Fixture): { count: number } {
    const counter = { count: 0 };
    fixture.componentInstance.changed.subscribe(() => (counter.count += 1));
    return counter;
  }

  it('renders the ledger with the acquisition-cost floor and local-currency header', async () => {
    const fixture = await render();
    expect(listed).toEqual(['4']);
    expect(textOf(fixture)).toContain('Acquisition cost (basis floor): $9,911.00');
    const [header] = cells(fixture, 'tr[mat-header-row]');
    expect(header).toEqual([
      'Tax Year', 'Marked', 'Shares', 'FMV (EUR)', 'FX Rate',
      'FMV (USD)', 'Basis After', 'Ordinary Income', '',
    ]);
    const rows = cells(fixture, 'tr[mat-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0].slice(0, 8)).toEqual([
      '2024', '2024-12-31', '100', '€9,500.00', '1.05',
      '$9,975.00', '$9,975.00', '$64.00',
    ]);
    expect(rows[1].slice(0, 8)).toEqual([
      '2025', '2025-12-31', '100', '€10,000.00', '1.08',
      '$10,800.00', '$10,800.00', '$825.00',
    ]);
    expect(textOf(fixture)).not.toContain('No marks recorded yet');
  });

  it('offers delete on the latest mark only, edit on every mark', async () => {
    const fixture = await render();
    expect(buttons(fixture, 'Edit mark')).toHaveLength(2);
    expect(buttons(fixture, 'Delete latest mark')).toHaveLength(1);
    const lastRow = host(fixture).querySelectorAll('tr[mat-row]')[1];
    expect(lastRow.querySelector('button[aria-label="Delete latest mark"]')).toBeTruthy();
  });

  it('shows the empty note and an em dash floor before any mark exists', async () => {
    marks = () => [];
    restoreApi();
    restoreApi = installFakeApi(({ service }) => {
      service(SecurityService, {
        listMtmMarks: (request) => {
          listed.push(String(request.securityId));
          return { marks: [] }; // no acquisition cost either
        },
      });
    });
    const fixture = await render();
    expect(host(fixture).querySelectorAll('table')).toHaveLength(0);
    expect(textOf(fixture)).toContain(
      'No marks recorded yet — record the first year-end mark to start the ledger.',
    );
    expect(textOf(fixture)).toContain('Acquisition cost (basis floor): —');
  });

  it('routes a list failure to the error snackbar and stays empty', async () => {
    listFails = new ConnectError('EUFUND is not marked to market', Code.FailedPrecondition);
    const errorSpy = vi.spyOn(TestBed.inject(Notify), 'error');
    const fixture = await render();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0][0] as ConnectError).rawMessage).toBe(
      'EUFUND is not marked to market',
    );
    expect(host(fixture).querySelectorAll('table')).toHaveLength(0);
    expect(textOf(fixture)).toContain('No marks recorded yet');
  });

  it('refetches when the security input changes', async () => {
    const fixture = await render();
    expect(listed).toEqual(['4']);
    const other = eufund();
    fixture.componentRef.setInput(
      'security',
      create(SecurityProfileSchema, { ...other, securityId: 7n, ticker: 'OTHER' }),
    );
    fixture.detectChanges();
    await settle(fixture);
    expect(listed).toEqual(['4', '7']);
  });

  it('records against the year after the latest mark', async () => {
    const fixture = await render();
    const open = stubDialog(fixture, undefined);
    fixture.componentInstance.recordMark();
    await settle(fixture);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe(MtmMarkDialog);
    const data = dialogData(open);
    expect(data.taxYear).toBe(2026);
    expect(data.security.ticker).toBe('EUFUND');
    expect(data.mark).toBeUndefined();
  });

  it('records against the previous calendar year when the ledger is empty', async () => {
    marks = () => [];
    const fixture = await render();
    const open = stubDialog(fixture, undefined);
    fixture.componentInstance.recordMark();
    await settle(fixture);
    expect(dialogData(open).taxYear).toBe(TODAY.getFullYear() - 1);
  });

  it('reloads and emits changed when the record dialog reports success', async () => {
    const fixture = await render();
    const emitted = changes(fixture);
    stubDialog(fixture, true);
    fixture.componentInstance.recordMark();
    await settle(fixture);
    expect(listed).toEqual(['4', '4']);
    expect(emitted.count).toBe(1);
  });

  it('does nothing when the record dialog is dismissed', async () => {
    const fixture = await render();
    const emitted = changes(fixture);
    stubDialog(fixture, undefined);
    fixture.componentInstance.recordMark();
    await settle(fixture);
    expect(listed).toEqual(['4']);
    expect(emitted.count).toBe(0);
  });

  it('edits an earlier mark with the later-marks warning flag set', async () => {
    const fixture = await render();
    const open = stubDialog(fixture, undefined);
    const [earlier] = fixture.componentInstance.marks();
    fixture.componentInstance.editMark(earlier);
    await settle(fixture);
    const data = dialogData(open);
    expect(data.taxYear).toBe(2024);
    expect(data.mark).toBe(earlier);
    expect(data.hasLaterMarks).toBe(true);
  });

  it('edits the latest mark without the later-marks warning flag', async () => {
    const fixture = await render();
    const open = stubDialog(fixture, true);
    const emitted = changes(fixture);
    const latest = fixture.componentInstance.latest()!;
    fixture.componentInstance.editMark(latest);
    await settle(fixture);
    expect(dialogData(open).hasLaterMarks).toBe(false);
    expect(listed).toEqual(['4', '4']);
    expect(emitted.count).toBe(1);
  });

  it('confirms before deleting and does nothing when declined', async () => {
    const fixture = await render();
    const emitted = changes(fixture);
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    buttons(fixture, 'Delete latest mark')[0].click();
    await settle(fixture);
    expect(confirmSpy).toHaveBeenCalledWith('Delete the 2025 mark ($825.00 ordinary income)?');
    expect(deleted).toEqual([]);
    expect(listed).toEqual(['4']);
    expect(emitted.count).toBe(0);
  });

  it('deletes the latest mark, notifies, reloads, and emits changed', async () => {
    const fixture = await render();
    const emitted = changes(fixture);
    const successSpy = vi.spyOn(TestBed.inject(Notify), 'success');
    vi.stubGlobal('confirm', () => true);
    marks = () => [mark2024()];
    buttons(fixture, 'Delete latest mark')[0].click();
    await settle(fixture);
    expect(deleted).toEqual(['22']);
    expect(successSpy).toHaveBeenCalledWith('2025 mark deleted');
    expect(listed).toEqual(['4', '4']);
    expect(emitted.count).toBe(1);
    expect(cells(fixture, 'tr[mat-row]')).toHaveLength(1);
    // The 2024 mark is now latest, so it grows a delete button.
    expect(buttons(fixture, 'Delete latest mark')).toHaveLength(1);
  });

  it('routes a delete failure to the error snackbar without reloading', async () => {
    const fixture = await render();
    const emitted = changes(fixture);
    const errorSpy = vi.spyOn(TestBed.inject(Notify), 'error');
    deleteFails = new ConnectError(
      'only the latest mark (2025) may be deleted — the basis chain feeds forward',
      Code.FailedPrecondition,
    );
    vi.stubGlobal('confirm', () => true);
    buttons(fixture, 'Delete latest mark')[0].click();
    await settle(fixture);
    expect(deleted).toEqual(['22']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(listed).toEqual(['4']);
    expect(emitted.count).toBe(0);
    expect(cells(fixture, 'tr[mat-row]')).toHaveLength(2);
  });
});
