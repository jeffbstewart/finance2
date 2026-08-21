// Unit spec for LotDetailsPage (docs/design/ui-testing.md, inventory
// "LotDetailsPage"). Fake PositionService/SecurityService/AccountService
// via installFakeApi; MatDialog is replaced with a recording stub so the
// page's dialog wiring is asserted without rendering an overlay.
//
// Shared-infrastructure gap: sample-data.ts has no lot/sale builders, so
// the seeder-shaped fixtures live here for now.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router, provideRouter } from '@angular/router';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountService, AccountSummarySchema } from '../../../proto-gen/accounts_pb';
import {
  GetLotDetailsResponseSchema,
  LotRowSchema,
  PositionService,
  SaleRowSchema,
  type GetLotDetailsRequest,
  type GetLotDetailsResponse,
} from '../../../proto-gen/positions_pb';
import {
  GetSecurityDetailsResponseSchema,
  SecurityProfileSchema,
  SecurityService,
} from '../../../proto-gen/securities_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { date, money, quantity } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { BuyDialog } from './buy-dialog';
import { LotDetailsPage } from './lot-details-page';
import { SellDialog } from './sell-dialog';

const VTI = 1n;
const BROKERAGE = 1n;
const CLOSED = 4n;

/** The seeder's two open VTI lots in Vanguard : Brokerage. */
function vtiLots() {
  return [
    create(LotRowSchema, {
      lotId: 11n,
      bought: date('2024-03-01'),
      shares: quantity('30'),
      buyPricePerShare: money('150.00', { display: '$150.00' }),
      currentPricePerShare: money('201.90', { display: '$201.90' }),
      commission: money('5.00', { display: '$5.00' }),
      sharesStillHeld: quantity('19'),
      basis: money('2853.1667', { display: '$2,853.1667' }),
      currentValue: money('3836.10', { display: '$3,836.10' }),
      shortTermGain: money('0', { display: '$0.00' }),
      longTermGain: money('982.9333', { display: '$982.9333' }),
      accountId: BROKERAGE,
      accountName: 'Brokerage',
    }),
    create(LotRowSchema, {
      lotId: 12n,
      bought: date('2025-01-20'),
      shares: quantity('20'),
      buyPricePerShare: money('180.00', { display: '$180.00' }),
      currentPricePerShare: money('201.90', { display: '$201.90' }),
      commission: money('5.00', { display: '$5.00' }),
      sharesStillHeld: quantity('16'),
      basis: money('2884.00', { display: '$2,884.00' }),
      currentValue: money('3230.40', { display: '$3,230.40' }),
      shortTermGain: money('0', { display: '$0.00' }),
      longTermGain: money('346.40', { display: '$346.40' }),
      accountId: BROKERAGE,
      accountName: 'Brokerage',
    }),
  ];
}

function vtiSales() {
  return [
    create(SaleRowSchema, {
      saleId: 21n,
      sold: date('2025-06-15'),
      shares: quantity('10'),
      pricePerShare: money('190.00', { display: '$190.00' }),
      saleCosts: money('9.00', { display: '$9.00' }),
      shortTermGain: money('35.40', { display: '$35.40' }),
      longTermGain: money('233.60', { display: '$233.60' }),
    }),
    create(SaleRowSchema, {
      saleId: 22n,
      sold: date('2026-07-22'),
      shares: quantity('5'),
      pricePerShare: money('200.00', { display: '$200.00' }),
      saleCosts: money('0', { display: '$0.00' }),
      shortTermGain: money('0', { display: '$0.00' }),
      longTermGain: money('249.1667', { display: '$249.1667' }),
    }),
  ];
}

function lotDetails(inflationAdjusted = false): GetLotDetailsResponse {
  return create(GetLotDetailsResponseSchema, {
    lots: vtiLots(),
    sales: vtiSales(),
    inflationAdjusted,
  });
}

/** Same lots restated in today's dollars: cost columns move, prices don't. */
function inflatedDetails(): GetLotDetailsResponse {
  const response = lotDetails(true);
  response.lots[0].basis = money('3000.00', { display: '$3,000.00' });
  response.lots[0].buyPricePerShare = money('157.50', { display: '$157.50' });
  return response;
}

function empty(): GetLotDetailsResponse {
  return create(GetLotDetailsResponseSchema, {});
}

interface OpenedDialog {
  component: unknown;
  data: Record<string, unknown>;
}

describe('LotDetailsPage', () => {
  let restoreApi: () => void;
  let requests: { securityId: bigint; accountId: bigint; inflationAdjusted: boolean }[];
  let respond: (request: GetLotDetailsRequest) => GetLotDetailsResponse;
  let deletedLots: bigint[];
  let deletedSales: bigint[];
  let hidden: { securityId: bigint; hidden: boolean }[];
  let opened: OpenedDialog[];
  let dialogResult: unknown;

  beforeEach(() => {
    requests = [];
    deletedLots = [];
    deletedSales = [];
    hidden = [];
    opened = [];
    dialogResult = undefined;
    respond = (request) => lotDetails(request.inflationAdjusted);
    const dialogStub = {
      open: (component: unknown, config?: { data?: unknown }) => {
        opened.push({ component, data: (config?.data ?? {}) as Record<string, unknown> });
        return { afterClosed: () => of(dialogResult) };
      },
    };
    restoreApi = installFakeApi(({ service }) => {
      service(PositionService, {
        getLotDetails: (request) => {
          requests.push({
            securityId: request.securityId,
            accountId: request.accountId,
            inflationAdjusted: request.inflationAdjusted,
          });
          return respond(request);
        },
        deletePurchase: (request) => {
          deletedLots.push(request.lotId);
          return {};
        },
        deleteSale: (request) => {
          deletedSales.push(request.saleId);
          return {};
        },
      });
      service(SecurityService, {
        getSecurityDetails: () =>
          create(GetSecurityDetailsResponseSchema, {
            security: create(SecurityProfileSchema, {
              securityId: VTI,
              ticker: 'VTI',
              description: 'Total Market ETF',
              currencyCode: 'USD',
            }),
          }),
        setSecurityHidden: (request) => {
          hidden.push({ securityId: request.securityId, hidden: request.hidden });
          return {};
        },
      });
      service(AccountService, {
        getAccount: (request) => ({
          account: create(AccountSummarySchema, {
            accountId: request.accountId,
            brokerId: 1n,
            brokerName: 'Vanguard',
            name: 'Brokerage',
            currencyCode: 'USD',
          }),
        }),
      });
    });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    // MatDialog comes from MatDialogModule, not the root injector, so it
    // has to be overridden on the component itself — TestBed.inject
    // would hand back a different instance than the page resolves.
    TestBed.overrideComponent(LotDetailsPage, {
      add: { providers: [{ provide: MatDialog, useValue: dialogStub }] },
    });
  });

  afterEach(() => {
    restoreApi();
    vi.restoreAllMocks();
  });

  async function render(account = '') {
    const fixture = TestBed.createComponent(LotDetailsPage);
    fixture.componentRef.setInput('id', String(VTI));
    fixture.componentRef.setInput('account', account);
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

  function cells(table: HTMLTableElement, rowSelector: string): string[][] {
    return Array.from(table.querySelectorAll(rowSelector), (row) =>
      Array.from(row.querySelectorAll('th,td'), (c) => c.textContent!.trim()),
    );
  }

  /** Buttons carry a mat-icon ligature in their text, so match on a
   *  substring or on the aria-label the icon buttons use. */
  function buttonNamed(fixture: { nativeElement: HTMLElement }, name: string): HTMLButtonElement {
    const button = Array.from(host(fixture).querySelectorAll('button')).find(
      (b) => b.textContent!.includes(name) || b.getAttribute('aria-label') === name,
    );
    if (!button) throw new Error(`no button named ${name}`);
    return button;
  }

  function checkboxes(fixture: { nativeElement: HTMLElement }): HTMLInputElement[] {
    return Array.from(host(fixture).querySelectorAll('mat-checkbox input[type="checkbox"]'));
  }

  it('loads all accounts and shows the Account column when unscoped', async () => {
    const fixture = await render();
    expect(requests).toEqual([{ securityId: VTI, accountId: 0n, inflationAdjusted: false }]);
    expect(textOf(fixture)).toContain('Positions for VTI in All Accounts');
    const [lots] = tables(fixture);
    expect(cells(lots, 'tr[mat-header-row]')[0]).toEqual([
      '', 'Account', 'Bought', 'Shares', 'Buy $/Share', 'Now $/Share', 'Comm.',
      'Still Held', 'Basis', 'Current Value', 'ST Gain', 'LT Gain', '',
    ]);
    const rows = cells(lots, 'tr[mat-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0].slice(1, 12)).toEqual([
      'Brokerage', '2024-03-01', '30', '$150.00', '$201.90', '$5.00',
      '19', '$2,853.1667', '$3,836.10', '$0.00', '$982.9333',
    ]);
    expect(rows[1][2]).toBe('2025-01-20');
    expect(rows[1][7]).toBe('16');
  });

  it('scopes to one account, drops the Account column, and titles by broker', async () => {
    const fixture = await render(String(BROKERAGE));
    expect(requests).toEqual([
      { securityId: VTI, accountId: BROKERAGE, inflationAdjusted: false },
    ]);
    expect(textOf(fixture)).toContain('Positions for VTI in Vanguard : Brokerage');
    const [lots] = tables(fixture);
    expect(cells(lots, 'tr[mat-header-row]')[0]).toEqual([
      '', 'Bought', 'Shares', 'Buy $/Share', 'Now $/Share', 'Comm.',
      'Still Held', 'Basis', 'Current Value', 'ST Gain', 'LT Gain', '',
    ]);
    expect(cells(lots, 'tr[mat-row]')[0][1]).toBe('2024-03-01');
  });

  it('inflation toggle refetches, daggers the five cost headers, and footnotes', async () => {
    const fixture = await render();
    expect(textOf(fixture)).not.toContain('†');
    respond = () => inflatedDetails();
    fixture.componentInstance.toggleInflation(true);
    await settle(fixture);

    expect(requests).toEqual([
      { securityId: VTI, accountId: 0n, inflationAdjusted: false },
      { securityId: VTI, accountId: 0n, inflationAdjusted: true },
    ]);
    const [lots] = tables(fixture);
    const header = cells(lots, 'tr[mat-header-row]')[0];
    expect(header.filter((h) => h.includes('†'))).toEqual([
      'Buy $/Share †', 'Comm. †', 'Basis †', 'ST Gain †', 'LT Gain †',
    ]);
    expect(host(fixture).querySelector('p.footnote')!.textContent!.trim()).toBe(
      "† restated in today's dollars via CPI",
    );
    // Only the cost columns are restated; the current price is untouched.
    const row = cells(lots, 'tr[mat-row]')[0];
    expect(row[4]).toBe('$157.50');
    expect(row[5]).toBe('$201.90');
  });

  it('renders a select checkbox only for lots with shares still held', async () => {
    respond = () => {
      const response = lotDetails();
      response.lots[1].sharesStillHeld = quantity('0');
      return response;
    };
    const fixture = await render();
    expect(cells(tables(fixture)[0], 'tr[mat-row]')).toHaveLength(2);
    expect(checkboxes(fixture)).toHaveLength(1);
  });

  it('keeps Sell disabled until a lot is selected and passes the picks to SellDialog', async () => {
    const fixture = await render(String(BROKERAGE));
    const sell = buttonNamed(fixture, 'Sell');
    expect(sell.disabled).toBe(true);

    checkboxes(fixture)[0].click();
    await settle(fixture);
    expect(sell.disabled).toBe(false);

    sell.click();
    await settle(fixture);
    expect(opened).toHaveLength(1);
    expect(opened[0].component).toBe(SellDialog);
    expect(opened[0].data).toMatchObject({
      securityId: VTI,
      accountId: BROKERAGE,
      ticker: 'VTI',
      accountName: 'Brokerage',
      brokerName: 'Vanguard',
    });
    expect((opened[0].data['lots'] as { lotId: bigint }[]).map((l) => l.lotId)).toEqual([11n]);
  });

  it('refuses to sell lots spanning two accounts and says so', async () => {
    respond = () => {
      const response = lotDetails();
      response.lots[1].accountId = CLOSED;
      response.lots[1].accountName = 'Closed Account';
      return response;
    };
    const fixture = await render();
    const notify = TestBed.inject(Notify);
    const infoSpy = vi.spyOn(notify, 'info');

    checkboxes(fixture)[0].click();
    checkboxes(fixture)[1].click();
    await settle(fixture);
    buttonNamed(fixture, 'Sell').click();
    await settle(fixture);

    expect(infoSpy).toHaveBeenCalledWith('Pick lots from a single account to sell');
    expect(opened).toHaveLength(0);
  });

  it('falls back to the lot row account name when the view is unscoped', async () => {
    const fixture = await render();
    checkboxes(fixture)[1].click();
    await settle(fixture);
    buttonNamed(fixture, 'Sell').click();
    await settle(fixture);
    expect(opened[0].data).toMatchObject({ accountName: 'Brokerage', brokerName: '' });
    expect((opened[0].data['lots'] as { lotId: bigint }[]).map((l) => l.lotId)).toEqual([12n]);
  });

  it('clears the selection when the page reloads', async () => {
    const fixture = await render(String(BROKERAGE));
    checkboxes(fixture)[0].click();
    await settle(fixture);
    expect(fixture.componentInstance.selected().size).toBe(1);

    await fixture.componentInstance.reload();
    await settle(fixture);
    expect(fixture.componentInstance.selected().size).toBe(0);
    expect(buttonNamed(fixture, 'Sell').disabled).toBe(true);
  });

  it('unchecking a lot removes it from the selection', async () => {
    const fixture = await render(String(BROKERAGE));
    checkboxes(fixture)[0].click();
    await settle(fixture);
    checkboxes(fixture)[0].click();
    await settle(fixture);
    expect(fixture.componentInstance.selected().size).toBe(0);
    expect(buttonNamed(fixture, 'Sell').disabled).toBe(true);
  });

  it('opens BuyDialog scoped to the account and reloads when it reports a change', async () => {
    dialogResult = true;
    const fixture = await render(String(BROKERAGE));
    buttonNamed(fixture, 'Buy').click();
    await settle(fixture);
    expect(opened).toHaveLength(1);
    expect(opened[0].component).toBe(BuyDialog);
    expect(opened[0].data).toEqual({ accountId: BROKERAGE, securityId: VTI });
    expect(requests).toHaveLength(2);
  });

  it('passes no accountId to BuyDialog when unscoped and skips a cancelled reload', async () => {
    dialogResult = undefined;
    const fixture = await render();
    buttonNamed(fixture, 'Buy').click();
    await settle(fixture);
    expect(opened[0].data).toEqual({ accountId: undefined, securityId: VTI });
    expect(requests).toHaveLength(1);
  });

  it('edits a lot through BuyDialog in lot mode', async () => {
    dialogResult = true;
    const fixture = await render(String(BROKERAGE));
    buttonNamed(fixture, 'Edit lot').click();
    await settle(fixture);
    expect(opened[0].component).toBe(BuyDialog);
    expect((opened[0].data['lot'] as { lotId: bigint }).lotId).toBe(11n);
    expect(requests).toHaveLength(2);
  });

  it('confirms before deleting a lot and does nothing when declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fixture = await render(String(BROKERAGE));
    buttonNamed(fixture, 'Delete lot').click();
    await settle(fixture);
    expect(confirmSpy).toHaveBeenCalledWith('Delete the 2024-03-01 lot of 30 shares?');
    expect(deletedLots).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('deletes the lot and reloads once the confirm is accepted', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fixture = await render(String(BROKERAGE));
    const notify = TestBed.inject(Notify);
    const successSpy = vi.spyOn(notify, 'success');
    buttonNamed(fixture, 'Delete lot').click();
    await settle(fixture);
    expect(deletedLots).toEqual([11n]);
    expect(successSpy).toHaveBeenCalledWith('Lot deleted');
    expect(requests).toHaveLength(2);
  });

  it('shows the sale history only when the response carries sales', async () => {
    const fixture = await render(String(BROKERAGE));
    expect(textOf(fixture)).toContain('Sale History');
    const [, sales] = tables(fixture);
    expect(cells(sales, 'tr[mat-header-row]')[0]).toEqual([
      'Sold', 'Shares', '$/Share', 'Sale Costs', 'ST Gain', 'LT Gain', '',
    ]);
    expect(cells(sales, 'tr[mat-row]')[0].slice(0, 6)).toEqual([
      '2025-06-15', '10', '$190.00', '$9.00', '$35.40', '$233.60',
    ]);

    respond = () => create(GetLotDetailsResponseSchema, { lots: vtiLots() });
    await fixture.componentInstance.reload();
    await settle(fixture);
    expect(textOf(fixture)).not.toContain('Sale History');
    expect(tables(fixture)).toHaveLength(1);
  });

  it('confirms and deletes a sale', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fixture = await render(String(BROKERAGE));
    buttonNamed(fixture, 'Delete sale').click();
    await settle(fixture);
    expect(confirmSpy).toHaveBeenCalledWith('Delete the 2025-06-15 sale of 10 shares?');
    expect(deletedSales).toEqual([21n]);
    expect(requests).toHaveLength(2);
  });

  it('offers Hide this Security only on the empty unscoped view', async () => {
    respond = () => empty();
    const fixture = await render();
    expect(textOf(fixture)).toContain('No lots for VTI here.');
    expect(buttonNamed(fixture, 'Hide this Security')).toBeTruthy();
    expect(checkboxes(fixture)).toHaveLength(0);
  });

  it('omits Hide this Security when the empty view is scoped to an account', async () => {
    respond = () => empty();
    const fixture = await render(String(BROKERAGE));
    expect(textOf(fixture)).toContain('No lots for VTI here.');
    expect(textOf(fixture)).not.toContain('Hide this Security');
  });

  it('hides the security and returns to the securities list', async () => {
    respond = () => empty();
    const fixture = await render();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const notify = TestBed.inject(Notify);
    const successSpy = vi.spyOn(notify, 'success');

    buttonNamed(fixture, 'Hide this Security').click();
    await settle(fixture);
    expect(hidden).toEqual([{ securityId: VTI, hidden: true }]);
    expect(successSpy).toHaveBeenCalledWith('VTI hidden');
    expect(navigate).toHaveBeenCalledWith(['/securities']);
  });

  it('routes a load failure to the error snackbar and renders no lots', async () => {
    respond = () => {
      throw new ConnectError('no security 99', Code.NotFound);
    };
    const fixture = TestBed.createComponent(LotDetailsPage);
    fixture.componentRef.setInput('id', String(VTI));
    const notify = TestBed.inject(Notify);
    const errorSpy = vi.spyOn(notify, 'error');
    fixture.detectChanges();
    await settle(fixture);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const err = errorSpy.mock.calls[0][0] as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.rawMessage).toBe('no security 99');
    expect(cells(tables(fixture)[0], 'tr[mat-row]')).toEqual([]);
    // The ticker never loaded, so the title keeps its empty slot.
    expect(textOf(fixture)).toContain('in All Accounts');
  });

  it('links to the security details page for the routed id', async () => {
    const fixture = await render();
    const link = host(fixture).querySelector('a[href]')!;
    expect(link.getAttribute('href')).toBe('/securities/1');
  });
});
