// Unit spec for PrivatePricesPage (docs/design/ui-testing.md,
// inventory "PrivatePricesPage"). SecurityService is faked via
// installFakeApi; MatDialog is stubbed at the *component* injector - 
// the page imports MatDialogModule, which re-provides MatDialog, so a
// root-level override would never be the instance the page uses.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideRouter } from '@angular/router';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PrivatePriceRowSchema,
  SecurityProfileSchema,
  SecurityService,
  type PrivatePriceRow,
} from '../../../proto-gen/securities_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { date, money } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { PrivatePriceDialog } from './private-price-dialog';
import { PrivatePricesPage } from './private-prices-page';

/** Mirrors the seeder's GOLD rows (newest first, as the server lists
 *  them). Shared-infrastructure gap: sample-data.ts has no private
 *  price builder yet, so it lives here for now. */
function samplePrices(): PrivatePriceRow[] {
  return [
    create(PrivatePriceRowSchema, {
      priceId: 21n,
      date: date('2026-08-16'),
      price: money('3358.5000', { display: '$3,358.50' }),
      source: 'plaid',
    }),
    create(PrivatePriceRowSchema, {
      priceId: 20n,
      date: date('2026-05-23'),
      price: money('3100.0000', { display: '$3,100.00' }),
    }),
  ];
}

/** One captured `MatDialog.open` call. */
interface Opened {
  component: unknown;
  data: { securityId: bigint; row?: PrivatePriceRow };
}

describe('PrivatePricesPage', () => {
  let restoreApi: () => void;
  let listRequests: bigint[];
  let detailRequests: bigint[];
  let deleteRequests: bigint[];
  let prices: PrivatePriceRow[];
  let ticker: string | undefined;
  let listRespond: () => { prices: PrivatePriceRow[] };
  let deleteRespond: () => object;
  let opened: Opened[];
  let closeWith: unknown;
  let confirmSpy: ReturnType<typeof vi.spyOn>;
  let success: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listRequests = [];
    detailRequests = [];
    deleteRequests = [];
    prices = samplePrices();
    ticker = 'GOLD';
    listRespond = () => ({ prices });
    deleteRespond = () => ({});
    opened = [];
    closeWith = true;

    restoreApi = installFakeApi(({ service }) => {
      service(SecurityService, {
        listPrivatePrices: (request) => {
          listRequests.push(request.securityId);
          return listRespond();
        },
        getSecurityDetails: (request) => {
          detailRequests.push(request.securityId);
          return {
            security: ticker === undefined
              ? undefined
              : create(SecurityProfileSchema, {
                  securityId: request.securityId,
                  ticker,
                  description: 'Gold coins in a vault',
                }),
          };
        },
        deletePrivatePrice: (request) => {
          deleteRequests.push(request.priceId);
          return deleteRespond();
        },
      });
    });

    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    // The page imports MatDialogModule, so MatDialog is re-provided in
    // its own injector - the stub has to go on the component.
    TestBed.overrideComponent(PrivatePricesPage, {
      add: {
        providers: [
          {
            provide: MatDialog,
            useValue: {
              open: (component: unknown, config: { data: Opened['data'] }) => {
                opened.push({ component, data: config.data });
                return { afterClosed: () => of(closeWith) };
              },
            },
          },
        ],
      },
    });

    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const notify = TestBed.inject(Notify);
    success = vi.spyOn(notify, 'success').mockImplementation(() => {});
    error = vi.spyOn(notify, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreApi();
    vi.restoreAllMocks();
  });

  async function render(id = '7') {
    const fixture = TestBed.createComponent(PrivatePricesPage);
    fixture.componentRef.setInput('id', id);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function host(fixture: { nativeElement: HTMLElement }): HTMLElement {
    return fixture.nativeElement;
  }

  function rows(fixture: { nativeElement: HTMLElement }): string[][] {
    return Array.from(host(fixture).querySelectorAll('tr[mat-row]'), (row) =>
      Array.from(row.querySelectorAll('td'), (cell) => cell.textContent!.trim()),
    );
  }

  function iconButton(
    fixture: { nativeElement: HTMLElement },
    label: string,
    index = 0,
  ): HTMLButtonElement {
    const buttons = host(fixture).querySelectorAll<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    const button = buttons[index];
    if (!button) throw new Error(`no "${label}" button at index ${index}`);
    return button;
  }

  it('loads prices and the ticker in parallel and renders newest first', async () => {
    const fixture = await render('7');
    expect(listRequests).toEqual([7n]);
    expect(detailRequests).toEqual([7n]);
    expect(host(fixture).textContent).toContain(
      'Edit Privately Traded Price History for GOLD',
    );
    // Date, price, and where the row came from; then the actions cell.
    expect(rows(fixture).map((row) => row.slice(0, 3))).toEqual([
      ['2026-08-16', '$3,358.50', 'plaid'],
      ['2026-05-23', '$3,100.00', 'manual'],
    ]);
    expect(host(fixture).querySelector('.empty-note')).toBeNull();
  });

  it('links back to the security details page for the routed id', async () => {
    const fixture = await render('42');
    const back = host(fixture).querySelector<HTMLAnchorElement>('mat-card-actions a')!;
    expect(back.getAttribute('href')).toBe('/securities/42');
    expect(back.textContent).toContain('Back to GOLD');
  });

  it('shows the empty note and an empty table when there are no prices', async () => {
    prices = [];
    const fixture = await render();
    expect(rows(fixture)).toHaveLength(0);
    expect(host(fixture).querySelector('.empty-note')!.textContent!.trim()).toBe(
      'No prices yet - add the first with the button below.',
    );
  });

  it('renders a blank ticker when the details response carries no security', async () => {
    ticker = undefined;
    const fixture = await render();
    expect(host(fixture).textContent).toContain(
      'Edit Privately Traded Price History for',
    );
    expect(fixture.componentInstance.ticker()).toBe('');
  });

  it('routes a load failure to the error snackbar and renders no rows', async () => {
    listRespond = () => {
      throw new ConnectError('no security 7', Code.NotFound);
    };
    const fixture = await render();
    expect(error).toHaveBeenCalledTimes(1);
    expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('no security 7');
    expect(rows(fixture)).toHaveLength(0);
    expect(host(fixture).querySelector('.empty-note')).not.toBeNull();
  });

  it('the FAB opens the dialog in add mode and reloads when it reports a change', async () => {
    const fixture = await render('7');
    iconButton(fixture, 'Add price').click();
    await settle(fixture);
    expect(opened).toHaveLength(1);
    expect(opened[0].component).toBe(PrivatePriceDialog);
    expect(opened[0].data).toEqual({ securityId: 7n });
    expect(listRequests).toEqual([7n, 7n]);
  });

  it('does not reload when the dialog closes without a change', async () => {
    closeWith = undefined;
    const fixture = await render();
    iconButton(fixture, 'Add price').click();
    await settle(fixture);
    expect(opened).toHaveLength(1);
    expect(listRequests).toHaveLength(1);
  });

  it('the row edit button opens the dialog with that row', async () => {
    const fixture = await render('7');
    iconButton(fixture, 'Edit price', 1).click();
    await settle(fixture);
    expect(opened).toHaveLength(1);
    expect(opened[0].data.securityId).toBe(7n);
    expect(opened[0].data.row?.priceId).toBe(20n);
    expect(opened[0].data.row?.price?.display).toBe('$3,100.00');
    expect(listRequests).toHaveLength(2); // closeWith === true reloads
  });

  it('delete confirms with the row date and price, then deletes and reloads', async () => {
    const fixture = await render();
    iconButton(fixture, 'Delete price').click();
    await settle(fixture);
    expect(confirmSpy).toHaveBeenCalledWith('Delete the 2026-08-16 price $3,358.50?');
    expect(deleteRequests).toEqual([21n]);
    expect(success).toHaveBeenCalledWith('Price deleted');
    expect(listRequests).toHaveLength(2);
  });

  it('a declined confirm deletes nothing', async () => {
    confirmSpy.mockReturnValue(false);
    const fixture = await render();
    iconButton(fixture, 'Delete price', 1).click();
    await settle(fixture);
    expect(deleteRequests).toEqual([]);
    expect(success).not.toHaveBeenCalled();
    expect(listRequests).toHaveLength(1);
  });

  it('a failed delete surfaces the server message and does not reload', async () => {
    deleteRespond = () => {
      throw new ConnectError('no price 21', Code.NotFound);
    };
    const fixture = await render();
    iconButton(fixture, 'Delete price').click();
    await settle(fixture);
    expect(deleteRequests).toEqual([21n]);
    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('no price 21');
    expect(listRequests).toHaveLength(1);
  });

  it('reload picks up rows added while the page was open', async () => {
    const fixture = await render();
    prices = [
      create(PrivatePriceRowSchema, {
        priceId: 22n,
        date: date('2026-08-21'),
        price: money('3400.0000', { display: '$3,400.00' }),
      }),
      ...samplePrices(),
    ];
    iconButton(fixture, 'Add price').click();
    await settle(fixture);
    expect(rows(fixture).map((row) => row[0])).toEqual([
      '2026-08-21',
      '2026-08-16',
      '2026-05-23',
    ]);
  });
});
