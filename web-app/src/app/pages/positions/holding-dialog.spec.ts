// Unit spec for HoldingDialog (docs/design/ui-testing.md, inventory
// "PositionsPage → HoldingDialog"): position-level quantity entry for
// tax-deferred accounts. Rendered directly with MAT_DIALOG_DATA /
// MatDialogRef stubs — no overlay involved.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSummarySchema } from '../../../proto-gen/accounts_pb';
import {
  GetPurchaseFormInfoResponseSchema,
  PositionService,
  SecurityChoiceSchema,
  type SetHoldingRequest,
} from '../../../proto-gen/positions_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { money } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { HoldingDialog, type HoldingDialogData } from './holding-dialog';

/** The seeded Vanguard Roth IRA. */
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

// Shared-infrastructure gap: no GetPurchaseFormInfo builder in
// sample-data.ts, so the securities list is mirrored here.
function formInfo() {
  return create(GetPurchaseFormInfoResponseSchema, {
    securities: [
      create(SecurityChoiceSchema, {
        securityId: 1n,
        ticker: 'VTI',
        description: 'Total Market ETF',
        currencyCode: 'USD',
      }),
      create(SecurityChoiceSchema, {
        securityId: 3n,
        ticker: 'GOLD',
        description: 'Gold coins in a vault',
        currencyCode: 'USD',
      }),
    ],
  });
}

describe('HoldingDialog', () => {
  let restoreApi: () => void;
  let closed: unknown[];
  let saved: SetHoldingRequest[];
  let formInfoCalls: number;
  let formInfoFails: ConnectError | undefined;
  let saveFails: ConnectError | undefined;

  beforeEach(() => {
    closed = [];
    saved = [];
    formInfoCalls = 0;
    formInfoFails = undefined;
    saveFails = undefined;
    restoreApi = installFakeApi(({ service }) => {
      service(PositionService, {
        getPurchaseFormInfo: () => {
          formInfoCalls++;
          if (formInfoFails) throw formInfoFails;
          return formInfo();
        },
        setHolding: (request) => {
          if (saveFails) throw saveFails;
          saved.push(request);
          return {};
        },
      });
    });
  });

  afterEach(() => restoreApi());

  async function render(data: HoldingDialogData): Promise<ComponentFixture<HoldingDialog>> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        {
          provide: MatDialogRef,
          useValue: { close: (v: unknown) => closed.push(v) },
        },
      ],
    });
    const fixture = TestBed.createComponent(HoldingDialog);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function textOf(fixture: ComponentFixture<HoldingDialog>): string {
    return (fixture.nativeElement as HTMLElement).textContent!;
  }

  function labels(fixture: ComponentFixture<HoldingDialog>): string[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('mat-label'),
      (l) => l.textContent!.trim(),
    );
  }

  function submit(fixture: ComponentFixture<HoldingDialog>): HTMLButtonElement {
    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((b) => b.textContent!.includes('Submit'));
    if (!button) throw new Error('Submit button not rendered');
    return button;
  }

  describe('new holding', () => {
    it('titles with the account name and offers a security select', async () => {
      const fixture = await render({ account: roth() });
      expect(textOf(fixture)).toContain('Set Holding — Roth IRA');
      expect(labels(fixture)).toEqual(['Security', 'Shares Held']);
      expect(formInfoCalls).toBe(1);
      expect(fixture.componentInstance.securities().map((s) => s.ticker)).toEqual(['VTI', 'GOLD']);
    });

    it('starts empty with Submit disabled', async () => {
      const fixture = await render({ account: roth() });
      expect(fixture.componentInstance.securityId).toBeUndefined();
      expect(fixture.componentInstance.quantity).toBe('');
      expect(fixture.componentInstance.valid()).toBe(false);
      expect(submit(fixture).disabled).toBe(true);
    });

    it('saves the holding against the dialog account', async () => {
      const fixture = await render({ account: roth() });
      const page = fixture.componentInstance;
      const success = vi.spyOn(TestBed.inject(Notify), 'success');
      page.securityId = 1n;
      page.quantity = ' 12 ';
      expect(page.valid()).toBe(true);
      await page.submit();
      await settle(fixture);
      expect(saved).toHaveLength(1);
      expect(saved[0].accountId).toBe(2n);
      expect(saved[0].securityId).toBe(1n);
      expect(saved[0].quantity?.value).toBe('12');
      expect(success).toHaveBeenCalledWith('Holding saved');
      expect(closed).toEqual([true]);
      expect(page.busy()).toBe(false);
    });

    it('routes a form-info failure to the error snackbar with no choices', async () => {
      formInfoFails = new ConnectError('cannot list securities', Code.Unavailable);
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          { provide: MAT_DIALOG_DATA, useValue: { account: roth() } },
          { provide: MatDialogRef, useValue: { close: () => {} } },
        ],
      });
      const error = vi.spyOn(TestBed.inject(Notify), 'error');
      const fixture = TestBed.createComponent(HoldingDialog);
      fixture.detectChanges();
      await settle(fixture);
      expect(error).toHaveBeenCalledTimes(1);
      expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('cannot list securities');
      expect(fixture.componentInstance.securities()).toEqual([]);
    });

    it('keeps the dialog open and clears busy when the server rejects', async () => {
      const fixture = await render({ account: roth() });
      const page = fixture.componentInstance;
      const error = vi.spyOn(TestBed.inject(Notify), 'error');
      saveFails = new ConnectError('holdings require a tax-deferred account', Code.FailedPrecondition);
      page.securityId = 1n;
      page.quantity = '12';
      await page.submit();
      await settle(fixture);
      expect(error).toHaveBeenCalledTimes(1);
      expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe(
        'holdings require a tax-deferred account',
      );
      expect(closed).toEqual([]);
      expect(page.busy()).toBe(false);
    });
  });

  describe('editing an existing holding', () => {
    const editData = (): HoldingDialogData => ({
      account: roth(),
      securityId: 3n,
      ticker: 'GOLD',
      quantity: '5',
    });

    it('locks the security to a plain label and skips the form-info RPC', async () => {
      const fixture = await render(editData());
      expect(textOf(fixture)).toContain('Edit Holding — Roth IRA');
      expect(textOf(fixture)).toContain('GOLD');
      expect(labels(fixture)).toEqual(['Shares Held']);
      expect(formInfoCalls).toBe(0);
      expect(fixture.componentInstance.securities()).toEqual([]);
    });

    it('prefills the quantity and is immediately valid', async () => {
      const fixture = await render(editData());
      expect(fixture.componentInstance.quantity).toBe('5');
      expect(fixture.componentInstance.valid()).toBe(true);
      expect(submit(fixture).disabled).toBe(false);
    });

    // BUG: the dialog's docstring and the UI inventory both say
    // "quantity 0 deletes", and valid() accepts "0" — but SetHolding
    // rejects any non-positive quantity ("quantity must be positive;
    // delete the holding to remove it") and the dialog never calls
    // DeleteHolding. Pinning the client half of the current behavior;
    // the server's rejection is pinned in e2e/specs/positions.spec.ts.
    it('accepts quantity 0 client-side and sends it as-is', async () => {
      const fixture = await render(editData());
      const page = fixture.componentInstance;
      page.quantity = '0';
      expect(page.valid()).toBe(true);
      await page.submit();
      await settle(fixture);
      expect(saved).toHaveLength(1);
      expect(saved[0].securityId).toBe(3n);
      expect(saved[0].quantity?.value).toBe('0');
      expect(closed).toEqual([true]);
    });
  });

  describe('validation', () => {
    it('requires a security and a plain non-negative decimal quantity', async () => {
      const fixture = await render({ account: roth() });
      const page = fixture.componentInstance;
      page.quantity = '12';
      expect(page.valid()).toBe(false); // no security yet
      page.securityId = 1n;
      expect(page.valid()).toBe(true);
      for (const bad of ['', '  ', '-3', '1e2', '3.', 'twelve']) {
        page.quantity = bad;
        expect(page.valid(), `quantity ${JSON.stringify(bad)}`).toBe(false);
      }
      page.quantity = '12.500';
      expect(page.valid()).toBe(true);
    });

    it('enables Submit once the quantity is typed into the DOM', async () => {
      const fixture = await render({ account: roth() });
      fixture.componentInstance.securityId = 1n;
      const input = (fixture.nativeElement as HTMLElement).querySelector('input')!;
      input.value = '12';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await settle(fixture);
      expect(submit(fixture).disabled).toBe(false);
    });
  });
});
