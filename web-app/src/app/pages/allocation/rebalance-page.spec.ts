// Unit spec for RebalancePage (docs/design/ui-testing.md, inventory
// "RebalancePage"). Fakes PositionService.getPurchaseFormInfo and
// AllocationService.scoreRebalance through installFakeApi; the buy
// dialog is stubbed in the component's own injector, because
// MatDialog comes from MatDialogModule (the standalone component's
// element injector), not from the root one.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { create } from '@bufbuild/protobuf';
import type { FormattedMoney } from '../../../proto-gen/common_pb';
import { Code, ConnectError } from '@connectrpc/connect';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AllocationService,
  CandidateFundSchema,
  RebalanceClassSchema,
  ScoreRebalanceResponseSchema,
  TradeSide,
  type ScoreRebalanceRequest,
  type ScoreRebalanceResponse,
} from '../../../proto-gen/allocation_pb';
import {
  AccountChoiceSchema,
  PositionService,
  type AccountChoice,
} from '../../../proto-gen/positions_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { fraction, money } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import type { ProposedTrade } from './rebalance-buy-dialog';
import { RebalanceBuyDialog } from './rebalance-buy-dialog';
import { RebalancePage } from './rebalance-page';

// Shared-infrastructure gap: sample-data.ts has no AccountChoice or
// rebalance-score builders, so the seeded portfolio's three visible
// accounts (the tax-deferred Roth IRA included - this RPC does not
// filter) live here.
function sampleAccountChoices(): AccountChoice[] {
  return [
    create(AccountChoiceSchema, {
      accountId: 1n,
      brokerName: 'Vanguard',
      name: 'Brokerage',
      currencyCode: 'USD',
      taxDeferred: false,
      sweeps: money('500.00', { display: '$500.00' }),
    }),
    create(AccountChoiceSchema, {
      accountId: 2n,
      brokerName: 'Vanguard',
      name: 'Roth IRA',
      currencyCode: 'USD',
      taxDeferred: true,
      sweeps: money('55.25', { display: '$55.25' }),
    }),
    create(AccountChoiceSchema, {
      accountId: 3n,
      brokerName: 'EuroBank',
      name: 'EUR Brokerage',
      currencyCode: 'EUR',
      taxDeferred: false,
      sweeps: money('290.00', { display: '$290.00' }),
    }),
  ];
}

/** Buy-only scoring of the seeded portfolio from the Brokerage
 *  account: Other is exactly at target (it sets the rebalance total),
 *  Cash is under target but has no candidate funds. */
function sampleScore(
  options: { spent?: FormattedMoney; remaining?: FormattedMoney } = {},
): ScoreRebalanceResponse {
  return create(ScoreRebalanceResponseSchema, {
    classes: [
      create(RebalanceClassSchema, {
        name: 'Cash',
        beforeFraction: fraction('0.021', '2.1%'),
        afterFraction: fraction('0.021', '2.1%'),
        targetFraction: fraction('0.1', '10%'),
        residual: money('-15947.25', { display: '($15,947.25)' }),
        atOrOverTarget: false,
        candidates: [],
      }),
      create(RebalanceClassSchema, {
        name: 'US Stock',
        beforeFraction: fraction('0.2358', '23.58%'),
        afterFraction: fraction('0.2358', '23.58%'),
        targetFraction: fraction('0.4', '40%'),
        residual: money('-57680.70', { display: '($57,680.70)' }),
        atOrOverTarget: false,
        candidates: [
          create(CandidateFundSchema, {
            securityId: 1n,
            ticker: 'VTI',
            classWeight: fraction('1', '100%'),
            suggestedShares: { value: '285.00000000' },
            pricePerShare: money('201.9000', { display: '$201.90' }),
            cost: money('57541.5000', { display: '$57,541.50' }),
          }),
        ],
      }),
      create(RebalanceClassSchema, {
        name: 'Non US Stock',
        beforeFraction: fraction('0.2998', '29.98%'),
        afterFraction: fraction('0.2998', '29.98%'),
        targetFraction: fraction('0.2', '20%'),
        residual: money('-21521.00', { display: '($21,521.00)' }),
        atOrOverTarget: false,
        candidates: [
          create(CandidateFundSchema, {
            securityId: 4n,
            ticker: 'EUFUND',
            classWeight: fraction('1', '100%'),
            suggestedShares: { value: '178.00000000' },
            pricePerShare: money('120.6400', { display: '$120.64' }),
            cost: money('21473.9200', { display: '$21,473.92' }),
          }),
        ],
      }),
      create(RebalanceClassSchema, {
        name: 'Bond',
        beforeFraction: fraction('0.0261', '2.61%'),
        afterFraction: fraction('0.0261', '2.61%'),
        targetFraction: fraction('0.2', '20%'),
        residual: money('-32535.00', { display: '($32,535.00)' }),
        atOrOverTarget: false,
        candidates: [
          create(CandidateFundSchema, {
            securityId: 2n,
            ticker: 'BONDX',
            classWeight: fraction('1', '100%'),
            suggestedShares: { value: '3098.00000000' },
            pricePerShare: money('10.5000', { display: '$10.50' }),
            cost: money('32529.0000', { display: '$32,529.00' }),
          }),
        ],
      }),
      create(RebalanceClassSchema, {
        name: 'Other',
        beforeFraction: fraction('0.4173', '41.73%'),
        afterFraction: fraction('0.4173', '41.73%'),
        targetFraction: fraction('0.1', '10%'),
        residual: money('0', { display: '$0.00' }),
        atOrOverTarget: true,
        candidates: [
          create(CandidateFundSchema, {
            securityId: 3n,
            ticker: 'GOLD',
            classWeight: fraction('1', '100%'),
            suggestedShares: { value: '0.00000000' },
            pricePerShare: money('3358.5000', { display: '$3,358.50' }),
            cost: money('0', { display: '$0.00' }),
          }),
        ],
      }),
    ],
    currentTotal: money('40241.05', { display: '$40,241.05' }),
    addedFunds: money('0', { display: '$0.00' }),
    spent: options.spent ?? money('0', { display: '$0.00' }),
    remaining: options.remaining ?? money('500.00', { display: '$500.00' }),
  });
}

/** What a scoreRebalance call carried, in plain-JS shapes. */
interface ScoredRequest {
  accountId: bigint;
  addedFunds: string;
  trades: { side: TradeSide; securityId: bigint; shares: string; cost: string }[];
}

function scoredRequestOf(request: ScoreRebalanceRequest): ScoredRequest {
  return {
    accountId: request.accountId,
    addedFunds: request.addedFunds?.value ?? '',
    trades: request.trades.map((t) => ({
      side: t.side,
      securityId: t.securityId,
      shares: t.shares?.value ?? '',
      cost: t.cost?.value ?? '',
    })),
  };
}

/** Records dialog opens and replays a canned close value. MatDialog
 *  is provided by MatDialogModule, so this stub must be installed in
 *  the component's own injector (TestBed.inject would miss it). */
class DialogStub {
  opened: { component: unknown; data: unknown }[] = [];
  result: ProposedTrade | undefined = undefined;

  open(component: unknown, config?: { data?: unknown }) {
    this.opened.push({ component, data: config?.data });
    return { afterClosed: () => of(this.result) };
  }
}

describe('RebalancePage', () => {
  let restoreApi: () => void;
  let dialog: DialogStub;
  let requests: ScoredRequest[];
  let accounts: AccountChoice[];
  let formInfoFails: boolean;
  let respond: (request: ScoreRebalanceRequest) => ScoreRebalanceResponse;

  beforeEach(() => {
    requests = [];
    accounts = sampleAccountChoices();
    formInfoFails = false;
    respond = () => sampleScore();
    dialog = new DialogStub();
    restoreApi = installFakeApi(({ service }) => {
      service(PositionService, {
        getPurchaseFormInfo: () => {
          if (formInfoFails) {
            throw new ConnectError('accounts are unavailable', Code.Unavailable);
          }
          return { accounts, securities: [] };
        },
      });
      service(AllocationService, {
        scoreRebalance: (request) => {
          requests.push(scoredRequestOf(request));
          return respond(request);
        },
      });
    });
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    TestBed.overrideComponent(RebalancePage, {
      add: { providers: [{ provide: MatDialog, useValue: dialog }] },
    });
  });

  afterEach(() => restoreApi());

  async function render() {
    const fixture = TestBed.createComponent(RebalancePage);
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

  function tables(fixture: { nativeElement: HTMLElement }): HTMLTableElement[] {
    return Array.from(host(fixture).querySelectorAll('table[mat-table]'));
  }

  function rowsOf(table: HTMLTableElement): string[][] {
    return Array.from(table.querySelectorAll('tr[mat-row]'), (row) =>
      Array.from(row.querySelectorAll('td'), (cell) => cell.textContent!.trim()),
    );
  }

  function fieldByLabel(fixture: { nativeElement: HTMLElement }, label: string): HTMLElement {
    const field = Array.from(host(fixture).querySelectorAll<HTMLElement>('mat-form-field')).find(
      (f) => f.querySelector('mat-label')?.textContent?.trim() === label,
    );
    if (!field) throw new Error(`no form field labelled ${label}`);
    return field;
  }

  /** Opens the Account mat-select and returns its (freshly opened)
   *  overlay panel. The panel is found through the trigger's
   *  aria-controls - a document-wide mat-option query can pick up a
   *  just-closed panel still lingering in the overlay container. */
  async function openAccountSelect(fixture: {
    nativeElement: HTMLElement;
    detectChanges(): void;
  }): Promise<HTMLElement> {
    const field = fieldByLabel(fixture, 'Account');
    const select = field.querySelector('mat-select');
    const trigger = field.querySelector<HTMLElement>('.mat-mdc-select-trigger');
    if (!select || !trigger) throw new Error('the Account select is not rendered');
    trigger.click();
    await settle(fixture as never);
    const panelId = select.getAttribute('aria-controls');
    if (!panelId) throw new Error('the Account select did not open');
    const panel = document.getElementById(panelId);
    if (!panel) throw new Error(`no open select panel ${panelId}`);
    return panel;
  }

  function optionTexts(panel: HTMLElement): string[] {
    return Array.from(panel.querySelectorAll('mat-option'), (o) => o.textContent!.trim());
  }

  /** Types into the Add Funds input the way a user does - a bare
   *  signal write never re-renders under zoneless change detection. */
  async function typeFunds(
    fixture: { nativeElement: HTMLElement; detectChanges(): void },
    value: string,
  ): Promise<HTMLInputElement> {
    const input = fieldByLabel(fixture, 'Add Funds to Sweeps').querySelector('input')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture as never);
    return input;
  }

  function buttonsByLabel(
    fixture: { nativeElement: HTMLElement },
    label: string,
  ): HTMLButtonElement[] {
    return Array.from(host(fixture).querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`));
  }

  it('lists every account the RPC returns, tax-deferred included', async () => {
    const fixture = await render();
    const panel = await openAccountSelect(fixture);
    expect(optionTexts(panel)).toEqual([
      'Vanguard : Brokerage - sweeps $500.00',
      'Vanguard : Roth IRA - sweeps $55.25',
      'EuroBank : EUR Brokerage - sweeps $290.00',
    ]);
  });

  it('shows the empty note and scores nothing until an account is picked', async () => {
    const fixture = await render();
    expect(requests).toEqual([]);
    expect(textOf(fixture)).toContain('Pick an account to score the plan.');
    expect(tables(fixture)).toHaveLength(0);
    expect(textOf(fixture)).not.toContain('Still to Spend');
  });

  it('scores the account picked from the select, carrying its bigint id', async () => {
    const fixture = await render();
    const panel = await openAccountSelect(fixture);
    const roth = Array.from(panel.querySelectorAll<HTMLElement>('mat-option')).find((o) =>
      o.textContent!.includes('Roth IRA'),
    )!;
    roth.click();
    await settle(fixture);
    expect(requests).toEqual([{ accountId: 2n, addedFunds: '0', trades: [] }]);
    expect(fixture.componentInstance.accountId()).toBe(2n);
    expect(textOf(fixture)).not.toContain('Pick an account to score the plan.');
  });

  it('auto-selects and auto-scores when exactly one account exists', async () => {
    accounts = [sampleAccountChoices()[0]];
    const fixture = await render();
    expect(fixture.componentInstance.accountId()).toBe(1n);
    expect(requests).toEqual([{ accountId: 1n, addedFunds: '0', trades: [] }]);
    expect(tables(fixture)).toHaveLength(1);
  });

  it('renders the allocation table and the spent/remaining stats', async () => {
    accounts = [sampleAccountChoices()[0]];
    const fixture = await render();
    const [allocation] = tables(fixture);
    const headers = Array.from(allocation.querySelectorAll('th'), (th) => th.textContent!.trim());
    expect(headers).toEqual(['Name', 'Before', 'After', 'Target', 'Residual Imbalance', '']);
    const rows = rowsOf(allocation);
    expect(rows.map((r) => r[0])).toEqual(['Cash', 'US Stock', 'Non US Stock', 'Bond', 'Other']);
    expect(rows[1].slice(0, 5)).toEqual([
      'US Stock',
      '23.58%',
      '23.58%',
      '40%',
      '($57,680.70)',
    ]);
    expect(textOf(fixture)).toContain('Spent So Far');
    expect(textOf(fixture)).toContain('$0.00');
    expect(textOf(fixture)).toContain('Still to Spend');
    expect(textOf(fixture)).toContain('$500.00');
  });

  it('disables the buy button at/over target and without candidates', async () => {
    accounts = [sampleAccountChoices()[0]];
    const fixture = await render();
    const buttons = buttonsByLabel(fixture, 'Propose purchase');
    expect(buttons).toHaveLength(5);
    // Cash: under target but no candidate funds. Other: at target.
    expect(buttons.map((b) => b.disabled)).toEqual([true, false, false, false, true]);
  });

  it('rescores on blur and on Enter, trimming the funds value', async () => {
    accounts = [sampleAccountChoices()[0]];
    const fixture = await render();
    const input = await typeFunds(fixture, ' 10000 ');
    expect(requests).toHaveLength(1); // typing alone does not rescore

    input.dispatchEvent(new Event('blur'));
    await settle(fixture);
    expect(requests[1]).toEqual({ accountId: 1n, addedFunds: '10000', trades: [] });

    await typeFunds(fixture, '2500.50');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(fixture);
    expect(requests[2]).toEqual({ accountId: 1n, addedFunds: '2500.50', trades: [] });
    expect(requests).toHaveLength(3);
  });

  it('silently skips the rescore for an invalid funds string, keeping stale results', async () => {
    accounts = [sampleAccountChoices()[0]];
    const fixture = await render();
    const notify = TestBed.inject(Notify);
    const errorSpy = vi.spyOn(notify, 'error');

    const input = await typeFunds(fixture, '-5');
    input.dispatchEvent(new Event('blur'));
    await settle(fixture);
    expect(fixture.componentInstance.fundsValid()).toBe(false);
    expect(requests).toHaveLength(1); // the earlier score is still on screen
    expect(tables(fixture)).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
    // The stale-result state is invisible: nothing flags the bad input.
    expect(host(fixture).querySelectorAll('mat-error')).toHaveLength(0);

    await typeFunds(fixture, '25');
    input.dispatchEvent(new Event('blur'));
    await settle(fixture);
    expect(requests).toHaveLength(2);
  });

  it('opens the buy dialog with the row class and ignores a cancelled dialog', async () => {
    accounts = [sampleAccountChoices()[0]];
    const fixture = await render();
    dialog.result = undefined;
    buttonsByLabel(fixture, 'Propose purchase')[3].click(); // Bond
    await settle(fixture);
    expect(dialog.opened).toHaveLength(1);
    expect(dialog.opened[0].component).toBe(RebalanceBuyDialog);
    expect((dialog.opened[0].data as { rebalanceClass: { name: string } }).rebalanceClass.name).toBe(
      'Bond',
    );
    expect(fixture.componentInstance.cart()).toEqual([]);
    expect(tables(fixture)).toHaveLength(1); // no cart table
    expect(requests).toHaveLength(1); // no rescore
  });

  it('adds the proposed trade to the cart and rescores with it', async () => {
    accounts = [sampleAccountChoices()[0]];
    const fixture = await render();
    respond = () =>
      sampleScore({
        spent: money('105.00', { display: '$105.00' }),
        remaining: money('395.00', { display: '$395.00' }),
      });
    dialog.result = { securityId: 2n, ticker: 'BONDX', shares: '10', cost: '105' };
    buttonsByLabel(fixture, 'Propose purchase')[3].click();
    await settle(fixture);

    expect(requests[1]).toEqual({
      accountId: 1n,
      addedFunds: '0',
      trades: [{ side: TradeSide.BUY, securityId: 2n, shares: '10', cost: '105' }],
    });
    const [cart] = tables(fixture);
    expect(textOf(fixture)).toContain('Rebalance Purchases');
    expect(rowsOf(cart)[0].slice(0, 3)).toEqual(['BONDX', '10', '105']);
    expect(tables(fixture)).toHaveLength(2);
    expect(textOf(fixture)).toContain('$105.00');
    expect(textOf(fixture)).toContain('$395.00');
  });

  it('removes a cart row and rescores without it', async () => {
    accounts = [sampleAccountChoices()[0]];
    const fixture = await render();
    dialog.result = { securityId: 2n, ticker: 'BONDX', shares: '10', cost: '105' };
    buttonsByLabel(fixture, 'Propose purchase')[3].click();
    await settle(fixture);
    expect(tables(fixture)).toHaveLength(2);

    buttonsByLabel(fixture, 'Remove from plan')[0].click();
    await settle(fixture);
    expect(fixture.componentInstance.cart()).toEqual([]);
    expect(tables(fixture)).toHaveLength(1);
    expect(textOf(fixture)).not.toContain('Rebalance Purchases');
    expect(requests[2]).toEqual({ accountId: 1n, addedFunds: '0', trades: [] });
  });

  it('keeps duplicate trades apart when one of them is removed', async () => {
    accounts = [sampleAccountChoices()[0]];
    const fixture = await render();
    for (const shares of ['10', '10']) {
      // A fresh object per open - remove() filters by identity.
      dialog.result = { securityId: 2n, ticker: 'BONDX', shares, cost: '105' };
      buttonsByLabel(fixture, 'Propose purchase')[3].click();
      await settle(fixture);
    }
    expect(fixture.componentInstance.cart()).toHaveLength(2);
    buttonsByLabel(fixture, 'Remove from plan')[0].click();
    await settle(fixture);
    expect(fixture.componentInstance.cart()).toHaveLength(1);
  });

  it('routes an account-load failure to the error snackbar', async () => {
    formInfoFails = true;
    const errorSpy = vi.spyOn(TestBed.inject(Notify), 'error');
    const fixture = await render();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0][0] as ConnectError).rawMessage).toBe('accounts are unavailable');
    expect(textOf(fixture)).toContain('Pick an account to score the plan.');
  });

  it('routes a scoring failure to the error snackbar and keeps the last score', async () => {
    accounts = [sampleAccountChoices()[0]];
    const fixture = await render();
    const notify = TestBed.inject(Notify);
    const errorSpy = vi.spyOn(notify, 'error');
    respond = () => {
      throw new ConnectError('set a target allocation before planning a rebalance', Code.FailedPrecondition);
    };
    await fixture.componentInstance.rescore();
    await settle(fixture);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0][0] as ConnectError).rawMessage).toBe(
      'set a target allocation before planning a rebalance',
    );
    expect(tables(fixture)).toHaveLength(1); // the previous score stays
  });

  it('never scores before an account is chosen, even with valid funds', async () => {
    const fixture = await render();
    const input = await typeFunds(fixture, '1000');
    input.dispatchEvent(new Event('blur'));
    await settle(fixture);
    expect(requests).toEqual([]);
    expect(textOf(fixture)).toContain('Pick an account to score the plan.');
  });
});
