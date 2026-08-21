// Unit spec for BrokerAccountsPage (docs/design/ui-testing.md,
// inventory "BrokerAccountsPage"). AccountService/BrokerService are
// faked through installFakeApi and the pie facade is stubbed, so the
// spec asserts the slice data handed to the chart rather than pixels.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router, provideRouter } from '@angular/router';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountService,
  AccountSummarySchema,
  type AccountSummary,
} from '../../../proto-gen/accounts_pb';
import { BrokerService } from '../../../proto-gen/brokers_pb';
import { PieChartStub } from '../../../testing/chart-stubs';
import { installFakeApi } from '../../../testing/fake-api';
import { sampleAccounts, sampleBrokers } from '../../../testing/sample-data';
import { settle } from '../../../testing/settle';
import { money } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { PieChart } from '../../shared/charts/pie-chart';
import { AccountDialog } from './account-dialog';
import { BrokerAccountsPage } from './broker-accounts-page';
import { BrokerDialog } from './broker-dialog';

/** EuroBank's EUR account. Shared-infrastructure gap: sample-data.ts's
 *  `sampleAccounts()` covers only Vanguard's two USD accounts, so the
 *  seeder's EUR Brokerage is built here to keep to the "extend, don't
 *  invent" rule without editing the shared file. */
function eurAccount(): AccountSummary {
  return create(AccountSummarySchema, {
    accountId: 3n,
    brokerId: 2n,
    brokerName: 'EuroBank',
    name: 'EUR Brokerage',
    accountNumber: 'X-3',
    currencyCode: 'EUR',
    taxDeferred: false,
    sweepBalance: money('250.00', { currency: 'EUR', display: '€250.00' }),
    investmentValue: money('0', { currency: 'EUR', display: '€0.00' }),
  });
}

describe('BrokerAccountsPage', () => {
  let restoreApi: () => void;
  let listAccountsRequests: bigint[];
  let listBrokersRequests: boolean[];
  let hideRequests: { brokerId: bigint; hidden: boolean }[];
  let accountsFor: (brokerId: bigint) => AccountSummary[];
  let listAccountsError: ConnectError | null;
  let setHiddenError: ConnectError | null;

  beforeEach(() => {
    listAccountsRequests = [];
    listBrokersRequests = [];
    hideRequests = [];
    listAccountsError = null;
    setHiddenError = null;
    accountsFor = (brokerId) =>
      [...sampleAccounts(), eurAccount()].filter((a) => a.brokerId === brokerId);

    restoreApi = installFakeApi(({ service }) => {
      service(AccountService, {
        listAccounts: (request) => {
          listAccountsRequests.push(request.brokerId);
          if (listAccountsError) throw listAccountsError;
          const accounts = accountsFor(request.brokerId);
          // Footer totals are the reporting currency (USD), the way
          // AccountGrpcService computes them.
          const sweeps = accounts.reduce((sum, a) => sum + (a.sweepBalance?.sortKey ?? 0), 0);
          const investment = accounts.reduce(
            (sum, a) => sum + (a.investmentValue?.sortKey ?? 0),
            0,
          );
          return {
            accounts,
            totalSweeps: money(sweeps.toFixed(2), { display: `$${sweeps.toFixed(2)}` }),
            totalInvestmentValue: money(investment.toFixed(2), {
              display: `$${investment.toFixed(2)}`,
            }),
          };
        },
      });
      service(BrokerService, {
        listBrokers: (request) => {
          listBrokersRequests.push(request.includeHidden);
          return {
            brokers: sampleBrokers(),
            totalHoldings: money('0', { display: '$0.00' }),
            totalSweeps: money('845.25', { display: '$845.25' }),
          };
        },
        setBrokerHidden: (request) => {
          hideRequests.push({ brokerId: request.brokerId, hidden: request.hidden });
          if (setHiddenError) throw setHiddenError;
          return {};
        },
      });
    });

    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    TestBed.overrideComponent(BrokerAccountsPage, {
      remove: { imports: [PieChart] },
      add: { imports: [PieChartStub] },
    });
  });

  afterEach(() => restoreApi());

  /** `id` is a required router input — set it before the first CD run
   *  or ngOnInit reads an unbound signal (NG0950). */
  async function render(id = '1') {
    const fixture = TestBed.createComponent(BrokerAccountsPage);
    fixture.componentRef.setInput('id', id);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function host(fixture: { nativeElement: HTMLElement }): HTMLElement {
    return fixture.nativeElement;
  }

  function textOf(fixture: { nativeElement: HTMLElement }): string {
    return host(fixture).textContent!;
  }

  function cells(fixture: { nativeElement: HTMLElement }, rowSelector: string): string[][] {
    return Array.from(host(fixture).querySelectorAll(rowSelector), (row) =>
      Array.from(row.querySelectorAll('th,td'), (c) => c.textContent!.trim()),
    );
  }

  function pieStub(fixture: {
    debugElement: { query(p: (el: { componentInstance: unknown }) => boolean): unknown };
  }): PieChartStub | null {
    const found = (
      fixture.debugElement as {
        query(p: (el: { componentInstance: unknown }) => boolean): { componentInstance: unknown } | null;
      }
    ).query((el) => el.componentInstance instanceof PieChartStub);
    return found ? (found.componentInstance as PieChartStub) : null;
  }

  /** MatDialogModule re-provides MatDialog, so the page's instance
   *  lives in the component's standalone injector — not TestBed's root
   *  one. Spy on this one or the page's `open` calls go unseen. */
  function dialogOf(fixture: { debugElement: { injector: { get(t: unknown): unknown } } }): MatDialog {
    return fixture.debugElement.injector.get(MatDialog) as MatDialog;
  }

  function buttonNamed(fixture: { nativeElement: HTMLElement }, text: string): HTMLButtonElement {
    const button = Array.from(host(fixture).querySelectorAll('button')).find((b) =>
      b.textContent!.includes(text),
    );
    if (!button) throw new Error(`no button labelled ${text}`);
    return button;
  }

  it('lists the broker accounts with per-account currency and footer totals', async () => {
    const fixture = await render('1');
    expect(listAccountsRequests).toEqual([1n]);
    // name, account (number + currency), tax deferred, sweep, value, actions
    expect(cells(fixture, 'tr[mat-row]')).toEqual([
      // the trailing cell is the row's edit icon-button (mat-icon text)
      ['Brokerage', 'X-1 (USD)', 'No', '$500.00', '$9,000.00', 'edit'],
      ['Roth IRA', 'X-2 (USD)', 'Yes', '$55.25', '$19,000.00', 'edit'],
    ]);
    expect(cells(fixture, 'tr[mat-header-row]')).toEqual([
      ['Name', 'Account', 'Tax Deferred', 'Sweep Balance', 'Investment Value', ''],
    ]);
    expect(cells(fixture, 'tr[mat-footer-row]')).toEqual([
      ['Total', '', '', '$555.25', '$28000.00', ''],
    ]);
  });

  it('titles the card from the first account and skips the broker lookup', async () => {
    const fixture = await render('1');
    expect(textOf(fixture)).toContain('Accounts at Vanguard');
    expect(listBrokersRequests).toEqual([]);
    expect(textOf(fixture)).not.toContain('No accounts yet.');
  });

  it('renders a EUR account in its own currency', async () => {
    const fixture = await render('2');
    expect(textOf(fixture)).toContain('Accounts at EuroBank');
    expect(cells(fixture, 'tr[mat-row]')).toEqual([
      ['EUR Brokerage', 'X-3 (EUR)', 'No', '€250.00', '€0.00', 'edit'],
    ]);
  });

  it('falls back to ListBrokers(includeHidden) for the title of an empty broker', async () => {
    const fixture = await render('3');
    expect(listAccountsRequests).toEqual([3n]);
    expect(listBrokersRequests).toEqual([true]);
    expect(textOf(fixture)).toContain('Accounts at Old Broker');
    expect(textOf(fixture)).toContain('No accounts yet.');
    expect(cells(fixture, 'tr[mat-row]')).toEqual([]);
    expect(pieStub(fixture)).toBeNull();
    expect(buttonNamed(fixture, 'Hide this empty brokerage')).toBeTruthy();
  });

  it('leaves the title blank when the empty broker is not in the list', async () => {
    const fixture = await render('99');
    expect(textOf(fixture)).toContain('Accounts at');
    expect(textOf(fixture)).not.toContain('Old Broker');
  });

  it('hides an empty brokerage and returns to the broker list', async () => {
    const fixture = await render('3');
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const success = vi.spyOn(TestBed.inject(Notify), 'success');

    buttonNamed(fixture, 'Hide this empty brokerage').click();
    await settle(fixture);

    expect(hideRequests).toEqual([{ brokerId: 3n, hidden: true }]);
    expect(success).toHaveBeenCalledWith('Brokerage hidden');
    expect(navigate).toHaveBeenCalledWith('/brokers');
  });

  it('routes a refused hide to the error snackbar and stays put', async () => {
    const fixture = await render('3');
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const error = vi.spyOn(TestBed.inject(Notify), 'error');
    setHiddenError = new ConnectError(
      'the broker still has visible accounts',
      Code.FailedPrecondition,
    );

    buttonNamed(fixture, 'Hide this empty brokerage').click();
    await settle(fixture);

    expect(navigate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const err = error.mock.calls[0][0] as ConnectError;
    expect(err.rawMessage).toBe('the broker still has visible accounts');
    expect(textOf(fixture)).toContain('No accounts yet.');
  });

  it('routes a failed load to the error snackbar and renders no rows', async () => {
    listAccountsError = new ConnectError('no broker 7', Code.NotFound);
    const error = vi.spyOn(TestBed.inject(Notify), 'error');
    const fixture = await render('7');
    expect(error).toHaveBeenCalledTimes(1);
    expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('no broker 7');
    expect(cells(fixture, 'tr[mat-row]')).toEqual([]);
    // The empty-state block is driven by the slices, so the failed load
    // still offers the hide button.
    expect(textOf(fixture)).toContain('No accounts yet.');
  });

  it('hands the pie one slice per account, summing sweeps into the value', async () => {
    const fixture = await render('1');
    const stub = pieStub(fixture)!;
    expect(stub).toBeTruthy();
    expect(stub.title()).toBe('Total Holdings by Account');
    expect(stub.slices()).toEqual([
      { id: '1', name: 'Brokerage', value: 9500, display: '$9,000.00 + $500.00 sweeps' },
      { id: '2', name: 'Roth IRA', value: 19055.25, display: '$19,000.00 + $55.25 sweeps' },
    ]);
  });

  it('BUG: pie slices mix currencies when a broker holds USD and EUR accounts', async () => {
    // BUG: `slices` adds the account-currency sortKeys and concatenates
    // the account-currency displays with no FX conversion, so a EUR
    // account is sized against USD ones as if 1 EUR = 1 USD. The house
    // rule is "no implicit cross-currency arithmetic" (CLAUDE.md); the
    // footer totals below do convert. Pinning current behavior.
    accountsFor = () => [sampleAccounts()[0], { ...eurAccount(), brokerId: 1n }];
    const fixture = await render('1');
    const slices = pieStub(fixture)!.slices();
    expect(slices[1].value).toBe(250); // EUR 250 counted as 250, not $290
    expect(slices[1].display).toBe('€0.00 + €250.00 sweeps');
  });

  it('opens the scoped positions page when a pie slice is clicked', async () => {
    const fixture = await render('1');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const stub = pieStub(fixture)!;
    stub.emitSliceClick(stub.slices()[1]);
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith(['/positions'], { queryParams: { account: '2' } });
  });

  it('links each account name to its scoped positions page', async () => {
    const fixture = await render('1');
    const links = Array.from(
      host(fixture).querySelectorAll<HTMLAnchorElement>('td a'),
      (a) => a.getAttribute('href'),
    );
    expect(links).toEqual(['/positions?account=1', '/positions?account=2']);
  });

  it('the add FAB opens AccountDialog for this broker and reloads on save', async () => {
    const fixture = await render('1');
    const open = vi
      .spyOn(dialogOf(fixture), 'open')
      .mockReturnValue({ afterClosed: () => of(true) } as never);

    host(fixture).querySelector<HTMLButtonElement>('button[aria-label="Add account"]')!.click();
    await settle(fixture);

    expect(open).toHaveBeenCalledWith(AccountDialog, { data: { brokerId: 1n } });
    expect(listAccountsRequests).toEqual([1n, 1n]);
  });

  it('the row edit button opens AccountDialog with that account', async () => {
    const fixture = await render('1');
    const open = vi
      .spyOn(dialogOf(fixture), 'open')
      .mockReturnValue({ afterClosed: () => of(true) } as never);

    const edits = host(fixture).querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Edit account"]',
    );
    expect(edits).toHaveLength(2);
    edits[1].click();
    await settle(fixture);

    const [component, config] = open.mock.calls[0] as [unknown, { data: { account: AccountSummary } }];
    expect(component).toBe(AccountDialog);
    expect(config.data.account.name).toBe('Roth IRA');
    expect(listAccountsRequests).toEqual([1n, 1n]);
  });

  it('a dismissed dialog does not reload', async () => {
    const fixture = await render('1');
    vi.spyOn(dialogOf(fixture), 'open').mockReturnValue({
      afterClosed: () => of(undefined),
    } as never);

    host(fixture).querySelector<HTMLButtonElement>('button[aria-label="Add account"]')!.click();
    await settle(fixture);

    expect(listAccountsRequests).toEqual([1n]);
  });

  it('Edit broker opens BrokerDialog seeded with the resolved name', async () => {
    const fixture = await render('1');
    const open = vi
      .spyOn(dialogOf(fixture), 'open')
      .mockReturnValue({ afterClosed: () => of(true) } as never);

    buttonNamed(fixture, 'Edit broker').click();
    await settle(fixture);

    expect(open).toHaveBeenCalledWith(BrokerDialog, {
      data: { brokerId: 1n, name: 'Vanguard' },
    });
    expect(listAccountsRequests).toEqual([1n, 1n]);
  });
});
