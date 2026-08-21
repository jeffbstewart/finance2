// Unit spec for AccountDialog (docs/design/ui-testing.md, inventory
// "BrokerAccountsPage → AccountDialog"). The dialog is rendered
// directly with stub MAT_DIALOG_DATA / MatDialogRef providers; the
// AccountService is faked through installFakeApi.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSelect } from '@angular/material/select';
import { By } from '@angular/platform-browser';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountService,
  AccountSummarySchema,
  type AccountSummary,
  type CreateAccountRequest,
  type UpdateAccountRequest,
} from '../../../proto-gen/accounts_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { money } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { AccountDialog, type AccountDialogData } from './account-dialog';

/** The seeder's Vanguard Brokerage row, as the page hands it over. */
function brokerageAccount(): AccountSummary {
  return create(AccountSummarySchema, {
    accountId: 1n,
    brokerId: 1n,
    brokerName: 'Vanguard',
    name: 'Brokerage',
    accountNumber: 'X-1',
    currencyCode: 'USD',
    taxDeferred: false,
    sweepBalance: money('500.0000', { display: '$500.00' }),
    investmentValue: money('0', { display: '$0.00' }),
  });
}

type Created = Pick<
  CreateAccountRequest,
  'brokerId' | 'name' | 'accountNumber' | 'currencyCode' | 'taxDeferred'
>;
type Updated = {
  accountId: bigint;
  name: string;
  accountNumber: string;
  taxDeferred: boolean;
  sweepBalance: string;
};

describe('AccountDialog', () => {
  let restoreApi: () => void;
  let created: Created[];
  let updated: Updated[];
  let createError: ConnectError | null;
  let updateError: ConnectError | null;
  let gateCreate: Promise<void> | null;
  let closed: unknown[];

  beforeEach(() => {
    created = [];
    updated = [];
    createError = null;
    updateError = null;
    gateCreate = null;
    closed = [];

    restoreApi = installFakeApi(({ service }) => {
      service(AccountService, {
        createAccount: async (request: CreateAccountRequest) => {
          if (gateCreate) await gateCreate;
          created.push({
            brokerId: request.brokerId,
            name: request.name,
            accountNumber: request.accountNumber,
            currencyCode: request.currencyCode,
            taxDeferred: request.taxDeferred,
          });
          if (createError) throw createError;
          return { accountId: 9n };
        },
        updateAccount: (request: UpdateAccountRequest) => {
          updated.push({
            accountId: request.accountId,
            name: request.name,
            accountNumber: request.accountNumber,
            taxDeferred: request.taxDeferred,
            sweepBalance: request.sweepBalance?.value ?? '',
          });
          if (updateError) throw updateError;
          return {};
        },
      });
    });
  });

  afterEach(() => restoreApi());

  function render(data: AccountDialogData) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close: (v: unknown) => closed.push(v) } },
      ],
    });
    const fixture = TestBed.createComponent(AccountDialog);
    fixture.detectChanges();
    return fixture;
  }

  type Fixture = ReturnType<typeof render>;

  function host(fixture: Fixture): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function labels(fixture: Fixture): string[] {
    return Array.from(host(fixture).querySelectorAll('mat-label'), (l) => l.textContent!.trim());
  }

  function fieldFor(fixture: Fixture, label: string): HTMLElement {
    const field = Array.from(host(fixture).querySelectorAll<HTMLElement>('mat-form-field')).find(
      (f) => f.querySelector('mat-label')?.textContent?.trim().startsWith(label),
    );
    if (!field) throw new Error(`no form field labelled ${label}`);
    return field;
  }

  /** Types the way a user does: a bare field assignment never
   *  re-renders under zoneless change detection. */
  async function type(fixture: Fixture, label: string, value: string): Promise<void> {
    const input = fieldFor(fixture, label).querySelector<HTMLInputElement>('input')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture);
  }

  function selectFor(fixture: Fixture, label: string): MatSelect {
    const found = fixture.debugElement
      .queryAll(By.directive(MatSelect))
      .find((d) =>
        (d.nativeElement as HTMLElement)
          .closest('mat-form-field')
          ?.querySelector('mat-label')
          ?.textContent?.trim()
          .startsWith(label),
      );
    if (!found) throw new Error(`no select labelled ${label}`);
    return found.componentInstance as MatSelect;
  }

  /** Opens the overlay panel and returns the rendered option elements. */
  async function openOptions(fixture: Fixture, label: string): Promise<HTMLElement[]> {
    selectFor(fixture, label).open();
    await settle(fixture);
    return Array.from(document.querySelectorAll<HTMLElement>('mat-option'));
  }

  async function pick(fixture: Fixture, label: string, optionText: string): Promise<void> {
    const options = await openOptions(fixture, label);
    const option = options.find((o) => o.textContent!.trim() === optionText);
    if (!option) throw new Error(`no option "${optionText}" under ${label}`);
    option.click();
    await settle(fixture);
  }

  function submitButton(fixture: Fixture): HTMLButtonElement {
    const button = Array.from(host(fixture).querySelectorAll('button')).find((b) =>
      b.textContent!.includes('Submit'),
    );
    if (!button) throw new Error('Submit button not rendered');
    return button;
  }

  describe('create mode', () => {
    const data: AccountDialogData = { brokerId: 1n };

    it('offers Currency and no Sweeps field', async () => {
      const fixture = render(data);
      expect(host(fixture).textContent).toContain('Add Account');
      expect(labels(fixture)).toEqual([
        'Account Name',
        'Account Number',
        'Tax Status',
        'Currency',
      ]);
    });

    it('disables Submit until both text fields are non-blank', async () => {
      const fixture = render(data);
      expect(submitButton(fixture).disabled).toBe(true);

      await type(fixture, 'Account Name', '   ');
      expect(submitButton(fixture).disabled).toBe(true);

      await type(fixture, 'Account Name', 'Joint');
      expect(submitButton(fixture).disabled).toBe(true); // number still blank

      await type(fixture, 'Account Number', 'Z-9');
      expect(submitButton(fixture).disabled).toBe(false);
    });

    it('creates the account with trimmed values and the chosen currency', async () => {
      const fixture = render(data);
      const success = vi.spyOn(TestBed.inject(Notify), 'success');
      await type(fixture, 'Account Name', '  Joint  ');
      await type(fixture, 'Account Number', '  Z-9  ');
      await pick(fixture, 'Currency', 'EUR');

      submitButton(fixture).click();
      await settle(fixture);

      expect(created).toEqual([
        {
          brokerId: 1n,
          name: 'Joint',
          accountNumber: 'Z-9',
          currencyCode: 'EUR',
          taxDeferred: false,
        },
      ]);
      expect(success).toHaveBeenCalledWith('Account added');
      expect(closed).toEqual([true]);
    });

    it('defaults to USD and carries the boolean Tax Status value', async () => {
      const fixture = render(data);
      const options = await openOptions(fixture, 'Tax Status');
      expect(options.map((o) => o.textContent!.trim())).toEqual(['Taxable', 'Tax Deferred']);
      // The option values are booleans, not strings (inventory note).
      expect(selectFor(fixture, 'Tax Status').options.map((o) => o.value)).toEqual([false, true]);

      await pick(fixture, 'Tax Status', 'Tax Deferred');
      await type(fixture, 'Account Name', 'Joint');
      await type(fixture, 'Account Number', 'Z-9');
      submitButton(fixture).click();
      await settle(fixture);

      expect(created[0].taxDeferred).toBe(true);
      expect(created[0].currencyCode).toBe('USD');
    });

    it('holds Submit disabled while the RPC is in flight', async () => {
      const fixture = render(data);
      let release!: () => void;
      gateCreate = new Promise<void>((resolve) => (release = resolve));
      await type(fixture, 'Account Name', 'Joint');
      await type(fixture, 'Account Number', 'Z-9');

      submitButton(fixture).click();
      await settle(fixture);
      expect(submitButton(fixture).disabled).toBe(true);
      expect(closed).toEqual([]);

      release();
      await settle(fixture);
      expect(closed).toEqual([true]);
    });

    it('keeps the dialog open and reports a rejected create', async () => {
      const fixture = render(data);
      const error = vi.spyOn(TestBed.inject(Notify), 'error');
      createError = new ConnectError(
        'an account named "Brokerage" already exists at this broker',
        Code.AlreadyExists,
      );
      await type(fixture, 'Account Name', 'Brokerage');
      await type(fixture, 'Account Number', 'X-1');

      submitButton(fixture).click();
      await settle(fixture);

      expect(closed).toEqual([]);
      expect(error).toHaveBeenCalledTimes(1);
      expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe(
        'an account named "Brokerage" already exists at this broker',
      );
      // busy() is released in `finally`, so a retry is possible.
      expect(submitButton(fixture).disabled).toBe(false);
    });
  });

  describe('edit mode', () => {
    const data: AccountDialogData = { brokerId: 1n, account: brokerageAccount() };

    it('swaps Currency for a currency-labelled Sweeps field', () => {
      const fixture = render(data);
      expect(host(fixture).textContent).toContain('Edit Account');
      expect(labels(fixture)).toEqual([
        'Account Name',
        'Account Number',
        'Tax Status',
        'Sweeps Balance (USD)',
      ]);
    });

    it('prefills from the account, including the exact sweep amount', async () => {
      const fixture = render(data);
      // ngModel's initial view write lands a microtask later.
      await settle(fixture);
      const value = (label: string) =>
        fieldFor(fixture, label).querySelector<HTMLInputElement>('input')!.value;
      expect(value('Account Name')).toBe('Brokerage');
      expect(value('Account Number')).toBe('X-1');
      // The exact wire decimal, not the formatted display.
      expect(value('Sweeps Balance')).toBe('500.0000');
      expect(selectFor(fixture, 'Tax Status').value).toBe(false);
    });

    it('updates the account with the trimmed sweep balance', async () => {
      const fixture = render(data);
      const success = vi.spyOn(TestBed.inject(Notify), 'success');
      await type(fixture, 'Sweeps Balance', '  612.50  ');
      await pick(fixture, 'Tax Status', 'Tax Deferred');

      submitButton(fixture).click();
      await settle(fixture);

      expect(updated).toEqual([
        {
          accountId: 1n,
          name: 'Brokerage',
          accountNumber: 'X-1',
          taxDeferred: true,
          sweepBalance: '612.50',
        },
      ]);
      expect(success).toHaveBeenCalledWith('Account updated');
      expect(closed).toEqual([true]);
      expect(created).toEqual([]);
    });

    it('sends a non-numeric sweep balance to the server unvalidated', async () => {
      // Not a bug — the inventory records that sweepBalance has no
      // client-side validator; the server answers INVALID_ARGUMENT.
      const fixture = render(data);
      const error = vi.spyOn(TestBed.inject(Notify), 'error');
      updateError = new ConnectError(
        'sweep balance is not a valid amount: "twelve"',
        Code.InvalidArgument,
      );
      await type(fixture, 'Sweeps Balance', 'twelve');
      expect(submitButton(fixture).disabled).toBe(false);

      submitButton(fixture).click();
      await settle(fixture);

      expect(updated[0].sweepBalance).toBe('twelve');
      expect(error).toHaveBeenCalledTimes(1);
      expect(closed).toEqual([]);
    });

    it('an emptied name disables Submit rather than clearing the account', async () => {
      const fixture = render(data);
      await type(fixture, 'Account Name', '');
      expect(submitButton(fixture).disabled).toBe(true);
      expect(updated).toEqual([]);
    });
  });
});
