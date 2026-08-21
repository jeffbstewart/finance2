// Unit spec for PositionsPage (docs/design/ui-testing.md, inventory
// "PositionsPage"). Fake PositionService/AccountService via
// installFakeApi; the pie facade is stubbed and MatDialog is replaced
// with a recording stub.
//
// Note on the dialog stub: PositionsPage imports MatDialogModule, so
// the module's own MatDialog would be the one the component injects —
// TestBed.inject(MatDialog) returns a different instance and spies on
// it never fire. Overriding the *component's* providers puts the stub
// in the node injector, which wins.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router, provideRouter } from '@angular/router';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountService, AccountSummarySchema } from '../../../proto-gen/accounts_pb';
import {
  ListPositionsResponseSchema,
  PositionRowSchema,
  PositionService,
  type ListPositionsResponse,
  type PositionRow,
} from '../../../proto-gen/positions_pb';
import { ProvenanceSchema } from '../../../proto-gen/common_pb';
import { ImportService, type ImportWarning } from '../../../proto-gen/imports_pb';
import { SparklineSchema } from '../../../proto-gen/securities_pb';
import { PieChartStub } from '../../../testing/chart-stubs';
import { installFakeApi } from '../../../testing/fake-api';
import { sampleImportWarnings } from '../../../testing/sample-data';
import { settle } from '../../../testing/settle';
import { civil, decimal, money, quantity } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { PieChart } from '../../shared/charts/pie-chart';
import { AccountDialog } from '../brokers/account-dialog';
import { BuyDialog } from './buy-dialog';
import { HoldingDialog } from './holding-dialog';
import { PositionsPage } from './positions-page';

// Shared-infrastructure gap: sample-data.ts has no position rows or
// GetAccountResponse builder, so the seeder's shapes are mirrored here.
const VTI_CLOSES = ['198.0', '199.5', '200.1', '201.9'];

function vtiRow(): PositionRow {
  return create(PositionRowSchema, {
    securityId: 1n,
    ticker: 'VTI',
    sparkline: create(SparklineSchema, {
      adjustedCloses: VTI_CLOSES.map((v) => decimal(v)),
    }),
    shares: quantity('35'),
    basis: money('5170.00', { display: '$5,170.00' }),
    currentValue: money('7066.50', { display: '$7,066.50' }),
    shortTermGain: money('349.60', { display: '$349.60' }),
    longTermGain: money('987.10', { display: '$987.10' }),
  });
}

function bondxRow(): PositionRow {
  return create(PositionRowSchema, {
    securityId: 2n,
    ticker: 'BONDX',
    shares: quantity('100'),
    basis: money('1000.00', { display: '$1,000.00' }),
    currentValue: money('1050.00', { display: '$1,050.00' }),
    shortTermGain: money('50.00', { display: '$50.00' }),
    longTermGain: money('0', { display: '$0.00' }),
  });
}

/** Portfolio-wide list: the Brokerage lots plus the Roth holdings. */
function allPositions(): ListPositionsResponse {
  return create(ListPositionsResponseSchema, {
    positions: [vtiRow(), bondxRow()],
    totalBasis: money('6170.00', { display: '$6,170.00' }),
    totalValue: money('8116.50', { display: '$8,116.50' }),
    totalShortTermGain: money('399.60', { display: '$399.60' }),
    totalLongTermGain: money('987.10', { display: '$987.10' }),
  });
}

/** Roth IRA scope: holdings rows, each carrying its provenance. */
function rothPositions(): ListPositionsResponse {
  return create(ListPositionsResponseSchema, {
    positions: [
      create(PositionRowSchema, {
        securityId: 1n,
        ticker: 'VTI',
        shares: quantity('12'),
        basis: money('0', { display: '$0.00' }),
        currentValue: money('2422.80', { display: '$2,422.80' }),
        provenance: create(ProvenanceSchema, { source: 'manual', asOf: civil('2026-08-11') }),
      }),
      create(PositionRowSchema, {
        securityId: 3n,
        ticker: 'GOLD',
        shares: quantity('5'),
        basis: money('0', { display: '$0.00' }),
        currentValue: money('16792.50', { display: '$16,792.50' }),
        provenance: create(ProvenanceSchema, { source: 'plaid', asOf: civil('2026-08-18') }),
      }),
    ],
    totalBasis: money('0', { display: '$0.00' }),
    totalValue: money('19215.30', { display: '$19,215.30' }),
    totalShortTermGain: money('0', { display: '$0.00' }),
    totalLongTermGain: money('0', { display: '$0.00' }),
  });
}

function emptyPositions(): ListPositionsResponse {
  return create(ListPositionsResponseSchema, {
    totalBasis: money('0', { display: '$0.00' }),
    totalValue: money('0', { display: '$0.00' }),
    totalShortTermGain: money('0', { display: '$0.00' }),
    totalLongTermGain: money('0', { display: '$0.00' }),
  });
}

const brokerage = () =>
  create(AccountSummarySchema, {
    accountId: 1n,
    brokerId: 1n,
    brokerName: 'Vanguard',
    name: 'Brokerage',
    accountNumber: 'X-1',
    currencyCode: 'USD',
    taxDeferred: false,
    sweepBalance: money('500.00', { display: '$500.00' }),
  });

const roth = () =>
  create(AccountSummarySchema, {
    accountId: 2n,
    brokerId: 1n,
    brokerName: 'Vanguard',
    name: 'Roth IRA',
    accountNumber: 'X-2',
    currencyCode: 'USD',
    taxDeferred: true,
    sweepBalance: money('55.25', { display: '$55.25' }),
  });

/** Records what the page asked MatDialog to open and what it got back. */
class DialogStub {
  readonly opened: { component: unknown; data: Record<string, unknown> }[] = [];
  result: unknown = true;

  open(component: unknown, config?: { data?: Record<string, unknown> }) {
    this.opened.push({ component, data: config?.data ?? {} });
    return { afterClosed: () => of(this.result) };
  }
}

describe('PositionsPage', () => {
  let restoreApi: () => void;
  let dialog: DialogStub;
  let listRequests: bigint[];
  let accountRequests: bigint[];
  let hiddenCalls: { accountId: bigint; hidden: boolean }[];
  let deleteCalls: bigint[];
  let positionsFor: (accountId: bigint) => ListPositionsResponse;
  let accountFor: (accountId: bigint) => ReturnType<typeof brokerage>;
  let failMutation: ConnectError | undefined;
  let warnings: ImportWarning[];
  let warningRequests: { brokerId: bigint; accountId: bigint }[];

  beforeEach(() => {
    listRequests = [];
    accountRequests = [];
    hiddenCalls = [];
    deleteCalls = [];
    failMutation = undefined;
    positionsFor = (accountId) => (accountId === 2n ? rothPositions() : allPositions());
    accountFor = (accountId) => (accountId === 2n ? roth() : brokerage());
    dialog = new DialogStub();
    warnings = [];
    warningRequests = [];

    restoreApi = installFakeApi(({ service }) => {
      service(PositionService, {
        listPositions: (request) => {
          listRequests.push(request.accountId);
          return positionsFor(request.accountId);
        },
      });
      service(AccountService, {
        getAccount: (request) => {
          accountRequests.push(request.accountId);
          return { account: accountFor(request.accountId) };
        },
        setAccountHidden: (request) => {
          if (failMutation) throw failMutation;
          hiddenCalls.push({ accountId: request.accountId, hidden: request.hidden });
          return {};
        },
        deleteAccount: (request) => {
          if (failMutation) throw failMutation;
          deleteCalls.push(request.accountId);
          return {};
        },
      });
      service(ImportService, {
        listImportWarnings: (request) => {
          warningRequests.push({ brokerId: request.brokerId, accountId: request.accountId });
          return {
            warnings: warnings.filter(
              (w) =>
                (request.accountId ? w.accountId === request.accountId : true) &&
                (request.brokerId && !request.accountId ? w.brokerId === request.brokerId : true),
            ),
          };
        },
      });
    });

    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    TestBed.overrideComponent(PositionsPage, {
      remove: { imports: [PieChart] },
      add: {
        imports: [PieChartStub],
        providers: [{ provide: MatDialog, useValue: dialog as unknown as MatDialog }],
      },
    });
  });

  afterEach(() => {
    restoreApi();
    vi.unstubAllGlobals();
  });

  async function render(account = '') {
    const fixture = TestBed.createComponent(PositionsPage);
    fixture.componentRef.setInput('account', account);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function textOf(fixture: { nativeElement: HTMLElement }): string {
    return fixture.nativeElement.textContent!;
  }

  function rows(fixture: { nativeElement: HTMLElement }): string[][] {
    return Array.from(fixture.nativeElement.querySelectorAll('tr[mat-row]'), (row) =>
      Array.from(row.querySelectorAll('td'), (c) => c.textContent!.trim()),
    );
  }

  function footer(fixture: { nativeElement: HTMLElement }): string[] {
    const row = fixture.nativeElement.querySelector('tr[mat-footer-row]')!;
    return Array.from(row.querySelectorAll('td'), (c) => c.textContent!.trim());
  }

  function pie(fixture: ComponentFixture<PositionsPage>): PieChartStub | undefined {
    const found = fixture.debugElement.query((el) => el.componentInstance instanceof PieChartStub);
    return found?.componentInstance as PieChartStub | undefined;
  }

  function buttonNamed(fixture: { nativeElement: HTMLElement }, text: string): HTMLButtonElement {
    const button = Array.from(fixture.nativeElement.querySelectorAll('button')).find((b) =>
      b.textContent!.includes(text),
    );
    if (!button) throw new Error(`no button containing ${text}`);
    return button;
  }

  function fab(fixture: { nativeElement: HTMLElement }): HTMLButtonElement {
    return fixture.nativeElement.querySelector<HTMLButtonElement>('button.page-fab')!;
  }

  describe('portfolio-wide scope', () => {
    it('lists every position with footer totals and the all-accounts title', async () => {
      const fixture = await render();
      expect(textOf(fixture)).toContain('Positions in All Accounts');
      const body = rows(fixture);
      expect(body.map((r) => r[0])).toEqual(['VTI', 'BONDX']);
      // ticker, sparkline, shares, basis, value, ST, LT, actions
      expect(body[0].slice(2)).toEqual([
        '35', '$5,170.00', '$7,066.50', '$349.60', '$987.10', '',
      ]);
      // Total, sparkline, shares, basis, value, ST, LT, actions
      expect(footer(fixture)).toEqual([
        'Total', '', '', '$6,170.00', '$8,116.50', '$399.60', '$987.10', '',
      ]);
    });

    it('never asks for import warnings portfolio-wide', async () => {
      warnings = sampleImportWarnings();
      const fixture = await render();
      expect(warningRequests).toEqual([]);
      expect(textOf(fixture)).not.toContain('Import reconciliation');
    });

    it('asks for accountId 0 and never fetches an account', async () => {
      await render();
      expect(listRequests).toEqual([0n]);
      expect(accountRequests).toEqual([]);
    });

    it('leaves the header subtitle and edit button off without a scope', async () => {
      const fixture = await render();
      expect(textOf(fixture)).not.toContain('Sweeps:');
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[aria-label="Edit account"]'),
      ).toBeNull();
    });

    it('links each ticker to its lot details with no account query param', async () => {
      const fixture = await render();
      const link = (fixture.nativeElement as HTMLElement).querySelector('a')!;
      expect(link.getAttribute('href')).toBe('/positions/1');
      expect(fixture.componentInstance.lotQuery()).toEqual({});
    });

    it('renders a sparkline path only when the row has two or more closes', async () => {
      const fixture = await render();
      const svgs = (fixture.nativeElement as HTMLElement).querySelectorAll('app-sparkline svg');
      expect(svgs).toHaveLength(2);
      expect(svgs[0].querySelector('path')).not.toBeNull(); // VTI: four closes
      expect(svgs[1].querySelector('path')).toBeNull(); // BONDX: none
    });

    it('maps sparkline decimals to plain geometry numbers', async () => {
      const fixture = await render();
      expect(fixture.componentInstance.trend(vtiRow())).toEqual([198, 199.5, 200.1, 201.9]);
      expect(fixture.componentInstance.trend(bondxRow())).toEqual([]);
    });
  });

  describe('pie facade', () => {
    it('hands one slice per position keyed by security id', async () => {
      const fixture = await render();
      const slices = pie(fixture)!.slices();
      expect(slices).toEqual([
        { id: '1', name: 'VTI', value: 7066.5, display: '$7,066.50' },
        { id: '2', name: 'BONDX', value: 1050, display: '$1,050.00' },
      ]);
      expect(pie(fixture)!.title()).toBe('Total Holdings by Security');
    });

    it('slice click navigates to the security, carrying the account scope', async () => {
      const fixture = await render('2');
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      pie(fixture)!.emitSliceClick({ id: '3', name: 'GOLD', value: 1, display: '$1.00' });
      await settle(fixture);
      expect(navigate).toHaveBeenCalledWith(['/positions', '3'], {
        queryParams: { account: '2' },
      });
    });

    it('slice click without a scope passes no query params', async () => {
      const fixture = await render();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      pie(fixture)!.emitSliceClick({ id: '1', name: 'VTI', value: 1, display: '$1.00' });
      await settle(fixture);
      expect(navigate).toHaveBeenCalledWith(['/positions', '1'], { queryParams: {} });
    });

    it('hides the pie and shows the empty note when there are no positions', async () => {
      positionsFor = () => emptyPositions();
      const fixture = await render();
      expect(pie(fixture)).toBeUndefined();
      expect(textOf(fixture)).toContain('No positions yet.');
    });
  });

  describe('account scope', () => {
    it("shows the scoped account's import warnings without account links", async () => {
      warnings = sampleImportWarnings();
      const fixture = await render('2');
      expect(warningRequests).toEqual([{ brokerId: 0n, accountId: 2n }]);
      const text = textOf(fixture);
      expect(text).toContain('Import reconciliation — 1 item(s) to fix');
      expect(text).toContain('ticker INTLX is not a known security');
      expect(text).not.toContain('institution reports 12 shares');
      const panelLinks = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>(
          'app-import-warnings a',
        ),
        (a) => a.getAttribute('href'),
      );
      expect(panelLinks).toEqual(['/imports']);
    });

    it('renders no warning panel when the account is clean', async () => {
      const fixture = await render('1');
      expect(textOf(fixture)).not.toContain('Import reconciliation');
    });

    it('titles and subtitles from the fetched account', async () => {
      const fixture = await render('2');
      expect(listRequests).toEqual([2n]);
      expect(accountRequests).toEqual([2n]);
      const text = textOf(fixture);
      expect(text).toContain('Positions at Vanguard : Roth IRA');
      expect(text).toContain('X-2 (USD)');
      expect(text).toContain('Tax Deferred');
      expect(text).toContain('Sweeps: $55.25');
    });

    it('labels a taxable account subtitle Taxable', async () => {
      const fixture = await render('1');
      expect(textOf(fixture)).toContain('Taxable');
      expect(textOf(fixture)).not.toContain('Tax Deferred');
    });

    it('shows the provenance chip for holdings rows', async () => {
      const fixture = await render('2');
      const chips = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('td .hidden-tag'),
        (c) => c.textContent!.trim(),
      );
      expect(chips).toEqual(['manual', 'plaid']);
    });

    it('carries the account through the ticker links', async () => {
      const fixture = await render('2');
      const link = (fixture.nativeElement as HTMLElement).querySelector('a')!;
      expect(link.getAttribute('href')).toBe('/positions/1?account=2');
    });
  });

  describe('the add FAB', () => {
    it('opens BuyDialog with no preselected account portfolio-wide', async () => {
      const fixture = await render();
      expect(fab(fixture).getAttribute('aria-label')).toBe('Buy security');
      fab(fixture).click();
      await settle(fixture);
      expect(dialog.opened).toEqual([{ component: BuyDialog, data: { accountId: undefined } }]);
    });

    it('preselects a taxable account for BuyDialog', async () => {
      const fixture = await render('1');
      expect(fab(fixture).getAttribute('aria-label')).toBe('Buy security');
      fab(fixture).click();
      await settle(fixture);
      expect(dialog.opened).toEqual([{ component: BuyDialog, data: { accountId: 1n } }]);
    });

    it('opens HoldingDialog for a tax-deferred account', async () => {
      const fixture = await render('2');
      expect(fab(fixture).getAttribute('aria-label')).toBe('Set holding');
      fab(fixture).click();
      await settle(fixture);
      expect(dialog.opened).toHaveLength(1);
      expect(dialog.opened[0].component).toBe(HoldingDialog);
      expect((dialog.opened[0].data['account'] as { name: string }).name).toBe('Roth IRA');
    });

    it('reloads only when the dialog reports a change', async () => {
      const fixture = await render();
      fab(fixture).click();
      await settle(fixture);
      expect(listRequests).toEqual([0n, 0n]);

      dialog.result = undefined;
      fab(fixture).click();
      await settle(fixture);
      expect(listRequests).toEqual([0n, 0n]);
    });
  });

  describe('editing the scoped account', () => {
    it('opens AccountDialog with the broker and account', async () => {
      const fixture = await render('1');
      (fixture.nativeElement as HTMLElement)
        .querySelector<HTMLButtonElement>('[aria-label="Edit account"]')!
        .click();
      await settle(fixture);
      expect(dialog.opened).toHaveLength(1);
      expect(dialog.opened[0].component).toBe(AccountDialog);
      expect(dialog.opened[0].data['brokerId']).toBe(1n);
      expect((dialog.opened[0].data['account'] as { name: string }).name).toBe('Brokerage');
      expect(listRequests).toEqual([1n, 1n]); // reloaded on a true close
    });

    it('does nothing without a scoped account', async () => {
      const fixture = await render();
      fixture.componentInstance.editAccount();
      await settle(fixture);
      expect(dialog.opened).toEqual([]);
    });
  });

  describe('the empty scoped account', () => {
    beforeEach(() => {
      positionsFor = () => emptyPositions();
    });

    it('offers hide and delete only when scoped', async () => {
      const scoped = await render('1');
      expect(textOf(scoped)).toContain('Hide this empty account');
      expect(textOf(scoped)).toContain('Delete this empty account');

      const unscoped = await render();
      expect(textOf(unscoped)).not.toContain('Hide this empty account');
    });

    it('hides the account, reports success, and returns to the broker', async () => {
      const fixture = await render('1');
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const success = vi.spyOn(TestBed.inject(Notify), 'success');
      buttonNamed(fixture, 'Hide this empty account').click();
      await settle(fixture);
      expect(hiddenCalls).toEqual([{ accountId: 1n, hidden: true }]);
      expect(success).toHaveBeenCalledWith('Account hidden');
      expect(navigate).toHaveBeenCalledWith(['/brokers', '1']);
    });

    it('confirms before deleting and does nothing when declined', async () => {
      const fixture = await render('1');
      const confirmSpy = vi.fn(() => false);
      vi.stubGlobal('confirm', confirmSpy);
      buttonNamed(fixture, 'Delete this empty account').click();
      await settle(fixture);
      expect(confirmSpy).toHaveBeenCalledWith(
        'Delete account Brokerage? This cannot be undone.',
      );
      expect(deleteCalls).toEqual([]);
    });

    it('deletes the account once confirmed and returns to the broker', async () => {
      const fixture = await render('1');
      vi.stubGlobal('confirm', vi.fn(() => true));
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const success = vi.spyOn(TestBed.inject(Notify), 'success');
      buttonNamed(fixture, 'Delete this empty account').click();
      await settle(fixture);
      expect(deleteCalls).toEqual([1n]);
      expect(success).toHaveBeenCalledWith('Account deleted');
      expect(navigate).toHaveBeenCalledWith(['/brokers', '1']);
    });

    it('routes a failed delete to the error snackbar and stays put', async () => {
      const fixture = await render('1');
      vi.stubGlobal('confirm', vi.fn(() => true));
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const error = vi.spyOn(TestBed.inject(Notify), 'error');
      failMutation = new ConnectError('account is not empty', Code.FailedPrecondition);
      buttonNamed(fixture, 'Delete this empty account').click();
      await settle(fixture);
      expect(error).toHaveBeenCalledTimes(1);
      expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('account is not empty');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('routes a failed hide to the error snackbar', async () => {
      const fixture = await render('1');
      const error = vi.spyOn(TestBed.inject(Notify), 'error');
      failMutation = new ConnectError('nope', Code.FailedPrecondition);
      buttonNamed(fixture, 'Hide this empty account').click();
      await settle(fixture);
      expect(error).toHaveBeenCalledTimes(1);
      expect(hiddenCalls).toEqual([]);
    });
  });

  it('routes a failed load to the error snackbar and renders no rows', async () => {
    positionsFor = () => {
      throw new ConnectError('positions are unavailable', Code.Unavailable);
    };
    const fixture = TestBed.createComponent(PositionsPage);
    const error = vi.spyOn(TestBed.inject(Notify), 'error');
    fixture.detectChanges();
    await settle(fixture);
    expect(error).toHaveBeenCalledTimes(1);
    expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('positions are unavailable');
    expect(rows(fixture)).toEqual([]);
    expect(textOf(fixture)).toContain('No positions yet.');
  });

  // BUG: FUNCTIONAL_SPEC §9.6 requires the all-positions list to be
  // sorted by current value descending, and PositionsPage's own
  // docstring says the server does it. Neither side sorts — the page
  // renders ListPositions' order verbatim. Pinning current behavior.
  it('renders the server order verbatim, unsorted by current value', async () => {
    positionsFor = () =>
      create(ListPositionsResponseSchema, {
        positions: [bondxRow(), vtiRow()], // ascending by value
        totalValue: money('8116.50', { display: '$8,116.50' }),
      });
    const fixture = await render();
    expect(rows(fixture).map((r) => r[0])).toEqual(['BONDX', 'VTI']);
    expect(pie(fixture)!.slices().map((s) => s.value)).toEqual([1050, 7066.5]);
  });
});
