// Unit spec for SellDialog (docs/design/ui-testing.md, inventory
// "LotDetailsPage / SellDialog"). The dialog is rendered directly with
// MAT_DIALOG_DATA and a MatDialogRef stub — the stepper's linear gating
// and the exact step-2 validation messages are the point.
//
// Shared-infrastructure gap: sample-data.ts has no LotRow builder, so
// the two seeded VTI lots are constructed here.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Date as CivilDateMsg } from '../../../proto-gen/common_pb';
import {
  LotRowSchema,
  PositionService,
  type LotRow,
  type RecordSaleRequest,
} from '../../../proto-gen/positions_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { date, money, quantity } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { SellDialog, type SellDialogData } from './sell-dialog';

const VTI = 1n;
const BROKERAGE = 1n;

/** The seeder's two open VTI lots: 19 held @ $150, 16 held @ $180. */
function lots(): LotRow[] {
  return [
    create(LotRowSchema, {
      lotId: 11n,
      bought: date('2024-03-01'),
      shares: quantity('30'),
      buyPricePerShare: money('150.00', { display: '$150.00' }),
      sharesStillHeld: quantity('19'),
      accountId: BROKERAGE,
      accountName: 'Brokerage',
    }),
    create(LotRowSchema, {
      lotId: 12n,
      bought: date('2025-01-20'),
      shares: quantity('20'),
      buyPricePerShare: money('180.00', { display: '$180.00' }),
      sharesStillHeld: quantity('16'),
      accountId: BROKERAGE,
      accountName: 'Brokerage',
    }),
  ];
}

interface RecordedSale {
  accountId: bigint;
  securityId: bigint;
  sold?: CivilDateMsg;
  shares: string;
  pricePerShare: string;
  saleCosts: string;
  allocations: { lotId: bigint; shares: string }[];
}

function recorded(request: RecordSaleRequest): RecordedSale {
  return {
    accountId: request.accountId,
    securityId: request.securityId,
    sold: request.sold,
    shares: request.shares?.value ?? '',
    pricePerShare: request.pricePerShare?.value ?? '',
    saleCosts: request.saleCosts?.value ?? '',
    allocations: request.allocations.map((a) => ({
      lotId: a.lotId,
      shares: a.shares?.value ?? '',
    })),
  };
}

describe('SellDialog', () => {
  let restoreApi: () => void;
  let sales: RecordedSale[];
  let failWith: ConnectError | undefined;
  let closed: unknown[];

  beforeEach(() => {
    sales = [];
    failWith = undefined;
    closed = [];
    restoreApi = installFakeApi(({ service }) => {
      service(PositionService, {
        recordSale: (request) => {
          if (failWith) throw failWith;
          sales.push(recorded(request));
          return { saleId: 99n };
        },
      });
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            securityId: VTI,
            accountId: BROKERAGE,
            ticker: 'VTI',
            accountName: 'Brokerage',
            brokerName: 'Vanguard',
            lots: lots(),
          } satisfies SellDialogData,
        },
        { provide: MatDialogRef, useValue: { close: (result: unknown) => closed.push(result) } },
      ],
    });
  });

  afterEach(() => {
    restoreApi();
    vi.restoreAllMocks();
  });

  async function render() {
    const fixture = TestBed.createComponent(SellDialog);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function host(fixture: { nativeElement: HTMLElement }): HTMLElement {
    return fixture.nativeElement;
  }

  function fieldsLabelled(fixture: { nativeElement: HTMLElement }, label: string): HTMLInputElement[] {
    return Array.from(host(fixture).querySelectorAll('mat-form-field'))
      .filter((f) => f.querySelector('mat-label')?.textContent?.trim() === label)
      .map((f) => f.querySelector('input')!)
      .filter(Boolean);
  }

  /** Types into an input the way a user does so ngModel sees the change —
   *  a bare field assignment never re-renders under zoneless. */
  async function type(
    fixture: { nativeElement: HTMLElement; detectChanges(): void },
    label: string,
    value: string,
    index = 0,
  ): Promise<void> {
    const input = fieldsLabelled(fixture, label)[index];
    if (!input) throw new Error(`no input labelled ${label} at ${index}`);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture as never);
  }

  function buttonsNamed(fixture: { nativeElement: HTMLElement }, name: string): HTMLButtonElement[] {
    return Array.from(host(fixture).querySelectorAll('button')).filter(
      (b) => b.textContent!.trim() === name,
    );
  }

  function buttonNamed(fixture: { nativeElement: HTMLElement }, name: string): HTMLButtonElement {
    const [button] = buttonsNamed(fixture, name);
    if (!button) throw new Error(`no button named ${name}`);
    return button;
  }

  /** Every step keeps its own Next in the DOM, so index by step number. */
  function nextButton(fixture: { nativeElement: HTMLElement }, step: 1 | 2): HTMLButtonElement {
    const button = buttonsNamed(fixture, 'Next')[step - 1];
    if (!button) throw new Error(`no Next button for step ${step}`);
    return button;
  }

  function validationError(fixture: { nativeElement: HTMLElement }): string | null {
    const p = host(fixture).querySelector('p.validation-error');
    return p ? p.textContent!.trim() : null;
  }

  /** Fills step 1 with a valid sale of `shares` and advances. */
  async function completeStep1(
    fixture: { nativeElement: HTMLElement; detectChanges(): void },
    shares = '10',
  ): Promise<void> {
    await type(fixture, 'Sale Date', '6/15/2026');
    await type(fixture, 'Shares to Sell', shares);
    await type(fixture, 'Price Per Share', '190');
    await type(fixture, 'Commission', '9');
    nextButton(fixture, 1).click();
    await settle(fixture as never);
  }

  it('titles itself with the ticker and names the account context', async () => {
    const fixture = await render();
    expect(host(fixture).querySelector('h2')!.textContent).toContain('Sell VTI');
    expect(host(fixture).textContent).toContain('Vanguard : Brokerage');
    expect(host(fixture).textContent).toContain('VTI');
  });

  it('keeps step 1 incomplete until the date and all three decimals are filled', async () => {
    const fixture = await render();
    const page = fixture.componentInstance;
    expect(page.step1Valid()).toBe(false);

    await type(fixture, 'Sale Date', '6/15/2026');
    await type(fixture, 'Shares to Sell', '10');
    await type(fixture, 'Price Per Share', '190');
    expect(page.step1Valid()).toBe(false); // commission is required, 0 allowed
    expect(nextButton(fixture, 1).disabled).toBe(true);

    await type(fixture, 'Commission', '0');
    expect(page.step1Valid()).toBe(true);
    expect(nextButton(fixture, 1).disabled).toBe(false);
    expect(page.date).toEqual(new Date(2026, 5, 15));
  });

  it('rejects a negative or exponent share count in step 1', async () => {
    const fixture = await render();
    const page = fixture.componentInstance;
    await type(fixture, 'Sale Date', '6/15/2026');
    await type(fixture, 'Price Per Share', '190');
    await type(fixture, 'Commission', '0');

    await type(fixture, 'Shares to Sell', '-10');
    expect(page.step1Valid()).toBe(false);
    await type(fixture, 'Shares to Sell', '1e3');
    expect(page.step1Valid()).toBe(false);
    await type(fixture, 'Shares to Sell', '10');
    expect(page.step1Valid()).toBe(true);
  });

  it('walks all three steps and records the sale with per-lot allocations', async () => {
    const fixture = await render();
    await completeStep1(fixture);

    expect(validationError(fixture)).toBe('Per-lot shares must sum to 10');
    await type(fixture, 'Sell Shares', '6', 0);
    await type(fixture, 'Sell Shares', '4', 1);
    expect(validationError(fixture)).toBe(null);
    expect(fixture.componentInstance.pickedCount()).toBe(2);

    nextButton(fixture, 2).click();
    await settle(fixture);
    expect(host(fixture).textContent).toContain('from 2 lots.');

    buttonNamed(fixture, 'Sell Lots').click();
    await settle(fixture);

    expect(sales).toEqual([
      {
        accountId: BROKERAGE,
        securityId: VTI,
        sold: { $typeName: 'finance.Date', year: 2026, month: 6, day: 15 },
        shares: '10',
        pricePerShare: '190',
        saleCosts: '9',
        allocations: [
          { lotId: 11n, shares: '6' },
          { lotId: 12n, shares: '4' },
        ],
      },
    ]);
    expect(closed).toEqual([true]);
  });

  it('omits blank and zero lot picks from the payload and the summary count', async () => {
    const fixture = await render();
    await completeStep1(fixture);
    await type(fixture, 'Sell Shares', '10', 0);
    await type(fixture, 'Sell Shares', '0', 1);
    expect(validationError(fixture)).toBe(null);
    expect(fixture.componentInstance.pickedCount()).toBe(1);

    nextButton(fixture, 2).click();
    await settle(fixture);
    expect(host(fixture).textContent).toContain('from 1 lot.');

    buttonNamed(fixture, 'Sell Lots').click();
    await settle(fixture);
    expect(sales[0].allocations).toEqual([{ lotId: 11n, shares: '10' }]);
  });

  it('blocks a pick that exceeds the lot with the still-held message', async () => {
    const fixture = await render();
    await completeStep1(fixture, '20');
    await type(fixture, 'Sell Shares', '20', 0);
    expect(validationError(fixture)).toBe('Lot bought 2024-03-01: only 19 still held');
    expect(nextButton(fixture, 2).disabled).toBe(true);

    await type(fixture, 'Sell Shares', '19', 0);
    await type(fixture, 'Sell Shares', '1', 1);
    expect(validationError(fixture)).toBe(null);
    expect(nextButton(fixture, 2).disabled).toBe(false);
  });

  it('names the offending lot when a pick is not a decimal', async () => {
    const fixture = await render();
    await completeStep1(fixture);
    await type(fixture, 'Sell Shares', 'all', 1);
    expect(validationError(fixture)).toBe('Lot bought 2025-01-20: enter a share count');
  });

  it('rejects a pick with more than eight decimal places', async () => {
    const fixture = await render();
    await completeStep1(fixture);
    await type(fixture, 'Sell Shares', '1.123456789', 0);
    expect(validationError(fixture)).toBe('Lot bought 2024-03-01: too many decimal places');
  });

  it('rejects a step-1 total with more than eight decimal places', async () => {
    const fixture = await render();
    const page = fixture.componentInstance;
    page.shares = '1.123456789';
    expect(page.step2Error()).toBe('Shares to sell has too many decimal places');
  });

  it('sums fractional picks exactly at scale 8', async () => {
    const fixture = await render();
    const page = fixture.componentInstance;
    page.shares = '0.3';
    page.allocations()[0].sellShares = '0.1';
    page.allocations()[1].sellShares = '0.2';
    expect(page.step2Error()).toBe(null);

    page.allocations()[1].sellShares = '0.20000001';
    expect(page.step2Error()).toBe('Per-lot shares must sum to 0.3');
  });

  it('holds off on validating step 2 until step 1 has a share count', async () => {
    const fixture = await render();
    const page = fixture.componentInstance;
    expect(page.shares).toBe('');
    // BUG (pinned, not fixed): with no step-1 total, step2Error() short-
    // circuits to null and step2Valid() reports true. Harmless today —
    // the linear stepper will not reach step 2 until step 1 completes —
    // but the validator alone does not defend the invariant.
    expect(page.step2Error()).toBe(null);
    expect(page.step2Valid()).toBe(true);
  });

  it('routes a rejected sale to the error snackbar and leaves the dialog open', async () => {
    const fixture = await render();
    const notify = TestBed.inject(Notify);
    const errorSpy = vi.spyOn(notify, 'error');
    await completeStep1(fixture);
    await type(fixture, 'Sell Shares', '6', 0);
    await type(fixture, 'Sell Shares', '4', 1);
    nextButton(fixture, 2).click();
    await settle(fixture);

    failWith = new ConnectError('lot 11 has only 19 shares still held', Code.InvalidArgument);
    buttonNamed(fixture, 'Sell Lots').click();
    await settle(fixture);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const err = errorSpy.mock.calls[0][0] as ConnectError;
    expect(err.rawMessage).toBe('lot 11 has only 19 shares still held');
    expect(closed).toEqual([]);
    expect(fixture.componentInstance.busy()).toBe(false);
    expect(buttonNamed(fixture, 'Sell Lots').disabled).toBe(false);
  });

  it('trims whitespace out of every submitted decimal', async () => {
    const fixture = await render();
    const page = fixture.componentInstance;
    page.date = new Date(2026, 5, 15);
    page.shares = ' 10 ';
    page.pricePerShare = ' 190.25 ';
    page.saleCosts = ' 0 ';
    page.allocations()[0].sellShares = ' 10 ';
    await page.submit();
    expect(sales[0]).toMatchObject({
      shares: '10',
      pricePerShare: '190.25',
      saleCosts: '0',
      allocations: [{ lotId: 11n, shares: '10' }],
    });
  });

  it('lists every candidate lot with its held shares and buy price', async () => {
    const fixture = await render();
    const labels = Array.from(host(fixture).querySelectorAll('.lot-label'), (s) =>
      s.textContent!.replace(/\s+/g, ' ').trim(),
    );
    expect(labels).toEqual([
      'Bought 2024-03-01 — 19 held at $150.00',
      'Bought 2025-01-20 — 16 held at $180.00',
    ]);
  });
});
