// Unit spec for BuyDialog (docs/design/ui-testing.md, inventory
// "PositionsPage → BuyDialog"). The dialog is rendered directly with
// MAT_DIALOG_DATA / MatDialogRef stubs — no overlay involved.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountChoiceSchema,
  GetPurchaseFormInfoResponseSchema,
  LotRowSchema,
  PositionService,
  SecurityChoiceSchema,
  type AddPurchaseRequest,
  type GetPurchaseFormInfoResponse,
  type UpdatePurchaseRequest,
} from '../../../proto-gen/positions_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { date, money, quantity } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { BuyDialog, type BuyDialogData } from './buy-dialog';

// Shared-infrastructure gap: sample-data.ts carries no
// GetPurchaseFormInfo builder, so the seeder's accounts/securities are
// mirrored here (including the tax-deferred Roth the dialog filters).
function formInfo(): GetPurchaseFormInfoResponse {
  return create(GetPurchaseFormInfoResponseSchema, {
    accounts: [
      create(AccountChoiceSchema, {
        accountId: 1n,
        brokerName: 'Vanguard',
        name: 'Brokerage',
        currencyCode: 'USD',
        taxDeferred: false,
      }),
      create(AccountChoiceSchema, {
        accountId: 2n,
        brokerName: 'Vanguard',
        name: 'Roth IRA',
        currencyCode: 'USD',
        taxDeferred: true,
      }),
      create(AccountChoiceSchema, {
        accountId: 3n,
        brokerName: 'EuroBank',
        name: 'EUR Brokerage',
        currencyCode: 'EUR',
        taxDeferred: false,
      }),
    ],
    securities: [
      create(SecurityChoiceSchema, {
        securityId: 1n,
        ticker: 'VTI',
        description: 'Total Market ETF',
        currencyCode: 'USD',
      }),
      create(SecurityChoiceSchema, {
        securityId: 2n,
        ticker: 'BONDX',
        description: 'Aggregate Bond Fund',
        currencyCode: 'USD',
      }),
    ],
  });
}

/** The seeded lastYear−1 VTI lot, as the lot-details edit hands it over. */
function vtiLot() {
  return create(LotRowSchema, {
    lotId: 11n,
    bought: date('2024-03-01'),
    shares: quantity('30'),
    buyPricePerShare: money('150.0000', { display: '$150.00' }),
    commission: money('5.0000', { display: '$5.00' }),
  });
}

describe('BuyDialog', () => {
  let restoreApi: () => void;
  let closed: unknown[];
  let added: AddPurchaseRequest[];
  let updated: UpdatePurchaseRequest[];
  let formInfoCalls: number;
  let formInfoFails: ConnectError | undefined;
  let mutationFails: ConnectError | undefined;

  beforeEach(() => {
    closed = [];
    added = [];
    updated = [];
    formInfoCalls = 0;
    formInfoFails = undefined;
    mutationFails = undefined;

    restoreApi = installFakeApi(({ service }) => {
      service(PositionService, {
        getPurchaseFormInfo: () => {
          formInfoCalls++;
          if (formInfoFails) throw formInfoFails;
          return formInfo();
        },
        addPurchase: (request) => {
          if (mutationFails) throw mutationFails;
          added.push(request);
          return { lotId: 99n };
        },
        updatePurchase: (request) => {
          if (mutationFails) throw mutationFails;
          updated.push(request);
          return {};
        },
      });
    });
  });

  afterEach(() => restoreApi());

  async function render(data: BuyDialogData): Promise<ComponentFixture<BuyDialog>> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        {
          provide: MatDialogRef,
          useValue: { close: (v: unknown) => closed.push(v) } as unknown as MatDialogRef<BuyDialog>,
        },
      ],
    });
    const fixture = TestBed.createComponent(BuyDialog);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function textOf(fixture: ComponentFixture<BuyDialog>): string {
    return (fixture.nativeElement as HTMLElement).textContent!;
  }

  function labels(fixture: ComponentFixture<BuyDialog>): string[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('mat-label'),
      (l) => l.textContent!.trim(),
    );
  }

  /** mat-select options only exist inside the overlay once opened, so
   *  the choices are read from the signals the template iterates. */
  function accountChoices(fixture: ComponentFixture<BuyDialog>): string[] {
    return fixture.componentInstance
      .accounts()
      .map((a) => `${a.brokerName} : ${a.name} (${a.currencyCode})`);
  }

  function securityChoices(fixture: ComponentFixture<BuyDialog>): string[] {
    return fixture.componentInstance.securities().map((s) => `${s.ticker}: ${s.description}`);
  }

  /** The Submit button — the datepicker toggle is a <button> too. */
  function submit(fixture: ComponentFixture<BuyDialog>): HTMLButtonElement {
    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((b) => b.textContent!.includes('Submit'));
    if (!button) throw new Error('Submit button not rendered');
    return button;
  }

  describe('purchase mode', () => {
    it('titles the dialog Purchase Security and shows every field', async () => {
      const fixture = await render({});
      expect(textOf(fixture)).toContain('Purchase Security');
      expect(labels(fixture)).toEqual([
        'Date', 'Account', 'Security', 'Shares', 'Price Per Share', 'Commission',
      ]);
      expect(textOf(fixture)).toContain('If you paid no commission, enter 0 here.');
    });

    it('drops tax-deferred accounts from the account choices', async () => {
      const fixture = await render({});
      expect(formInfoCalls).toBe(1);
      expect(accountChoices(fixture)).toEqual([
        'Vanguard : Brokerage (USD)',
        'EuroBank : EUR Brokerage (EUR)',
      ]);
      expect(securityChoices(fixture)).toEqual([
        'VTI: Total Market ETF',
        'BONDX: Aggregate Bond Fund',
      ]);
    });

    it('keeps the preselected account id as a bigint', async () => {
      const fixture = await render({ accountId: 1n, securityId: 2n });
      expect(fixture.componentInstance.accountId).toBe(1n);
      expect(fixture.componentInstance.securityId).toBe(2n);
    });

    it('starts with Submit disabled and an empty form', async () => {
      const fixture = await render({});
      expect(fixture.componentInstance.date).toBeNull();
      expect(fixture.componentInstance.shares).toBe('');
      expect(submit(fixture).disabled).toBe(true);
    });

    it('records the purchase with trimmed decimals and a civil date', async () => {
      const fixture = await render({ accountId: 1n, securityId: 1n });
      const page = fixture.componentInstance;
      const success = vi.spyOn(TestBed.inject(Notify), 'success');
      page.date = new Date(2026, 2, 4); // 2026-03-04 local
      page.shares = ' 10 ';
      page.pricePerShare = ' 195.25 ';
      page.commission = ' 0 ';
      expect(page.valid()).toBe(true);
      await page.submit();
      await settle(fixture);

      expect(added).toHaveLength(1);
      expect(added[0].accountId).toBe(1n);
      expect(added[0].securityId).toBe(1n);
      expect(added[0].bought).toMatchObject({ year: 2026, month: 3, day: 4 });
      expect(added[0].shares?.value).toBe('10');
      expect(added[0].pricePerShare?.value).toBe('195.25');
      expect(added[0].commission?.value).toBe('0');
      expect(updated).toEqual([]);
      expect(success).toHaveBeenCalledWith('Purchase recorded');
      expect(closed).toEqual([true]);
      expect(page.busy()).toBe(false);
    });

    it('surfaces a form-info failure as the error snackbar with empty choices', async () => {
      formInfoFails = new ConnectError('cannot list accounts', Code.Unavailable);
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          { provide: MAT_DIALOG_DATA, useValue: {} },
          { provide: MatDialogRef, useValue: { close: () => {} } },
        ],
      });
      const error = vi.spyOn(TestBed.inject(Notify), 'error');
      const fixture = TestBed.createComponent(BuyDialog);
      fixture.detectChanges();
      await settle(fixture);
      expect(error).toHaveBeenCalledTimes(1);
      expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('cannot list accounts');
      expect(fixture.componentInstance.accounts()).toEqual([]);
      expect(fixture.componentInstance.securities()).toEqual([]);
    });

    it('keeps the dialog open and clears busy when the server rejects', async () => {
      const fixture = await render({ accountId: 1n, securityId: 1n });
      const page = fixture.componentInstance;
      const error = vi.spyOn(TestBed.inject(Notify), 'error');
      mutationFails = new ConnectError('shares must be positive', Code.InvalidArgument);
      page.date = new Date(2026, 2, 4);
      page.shares = '10';
      page.pricePerShare = '195.25';
      page.commission = '0';
      await page.submit();
      await settle(fixture);
      expect(error).toHaveBeenCalledTimes(1);
      expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('shares must be positive');
      expect(closed).toEqual([]);
      expect(page.busy()).toBe(false);
    });
  });

  describe('validation', () => {
    it('requires a date, both selections, and three plain decimals', async () => {
      const fixture = await render({});
      const page = fixture.componentInstance;
      expect(page.valid()).toBe(false);

      page.date = new Date(2026, 2, 4);
      page.shares = '10';
      page.pricePerShare = '195.25';
      page.commission = '0';
      expect(page.valid()).toBe(false); // no account or security yet

      page.accountId = 1n;
      expect(page.valid()).toBe(false); // still no security
      page.securityId = 1n;
      expect(page.valid()).toBe(true);

      page.date = null;
      expect(page.valid()).toBe(false);
      page.date = new Date(2026, 2, 4);

      for (const bad of ['', ' ', '-5', '1e3', '1.2.3', 'abc']) {
        page.shares = bad;
        expect(page.valid(), `shares ${JSON.stringify(bad)}`).toBe(false);
      }
      page.shares = '10';
      page.pricePerShare = '-1';
      expect(page.valid()).toBe(false);
      page.pricePerShare = '195.25';
      page.commission = '';
      expect(page.valid()).toBe(false); // commission is required, 0 is the "none" value
      page.commission = '0';
      expect(page.valid()).toBe(true);
    });

    it('reflects validity in the Submit button after a DOM edit', async () => {
      const fixture = await render({ accountId: 1n, securityId: 1n });
      expect(submit(fixture).disabled).toBe(true);
      const inputs = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>('input'),
      );
      // Date, Shares, Price Per Share, Commission — no selects in this mode.
      const values = ['3/4/2026', '10', '195.25', '0'];
      inputs.forEach((input, i) => {
        input.value = values[i];
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await settle(fixture);
      expect(submit(fixture).disabled).toBe(false);
    });
  });

  describe('edit mode', () => {
    it('hides the account and security selects and skips the form-info RPC', async () => {
      const fixture = await render({ lot: vtiLot() });
      expect(textOf(fixture)).toContain('Edit Position');
      expect(labels(fixture)).toEqual(['Date', 'Shares', 'Price Per Share', 'Commission']);
      expect(formInfoCalls).toBe(0);
    });

    it('prefills from the lot, exact values not display strings', async () => {
      const fixture = await render({ lot: vtiLot() });
      const page = fixture.componentInstance;
      expect(page.date).toEqual(new Date(2024, 2, 1));
      expect(page.shares).toBe('30');
      expect(page.pricePerShare).toBe('150.0000');
      expect(page.commission).toBe('5.0000');
      expect(page.valid()).toBe(true); // account/security are fixed
    });

    it('updates the lot by id and never adds a purchase', async () => {
      const fixture = await render({ lot: vtiLot() });
      const page = fixture.componentInstance;
      const success = vi.spyOn(TestBed.inject(Notify), 'success');
      page.shares = '28';
      await page.submit();
      await settle(fixture);
      expect(updated).toHaveLength(1);
      expect(updated[0].lotId).toBe(11n);
      expect(updated[0].bought).toMatchObject({ year: 2024, month: 3, day: 1 });
      expect(updated[0].shares?.value).toBe('28');
      expect(updated[0].pricePerShare?.value).toBe('150.0000');
      expect(added).toEqual([]);
      expect(success).toHaveBeenCalledWith('Position updated');
      expect(closed).toEqual([true]);
    });
  });
});
