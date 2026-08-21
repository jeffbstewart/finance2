// Unit spec for AddSecurityDialog (docs/design/ui-testing.md,
// inventory "SecuritiesPage → AddSecurityDialog"). The dialog is
// rendered directly with a stub MatDialogRef — the overlay adds
// nothing to what is under test — and Router.navigate is spied on
// rather than routed, because the post-add hop targets a details
// page this spec does not build.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { Router, provideRouter } from '@angular/router';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  SecurityProfileSchema,
  SecurityService,
  type AddSecurityRequest,
  type AddSecurityResponse,
} from '../../../proto-gen/securities_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { Notify } from '../../core/notify';
import { AddSecurityDialog } from './add-security-dialog';

describe('AddSecurityDialog', () => {
  let restoreApi: () => void;
  let requests: { ticker: string; currencyCode: string }[];
  let respond: (request: AddSecurityRequest) => AddSecurityResponse | Promise<AddSecurityResponse>;
  let close: ReturnType<typeof vi.fn>;
  let navigate: MockInstance<Router['navigate']>;

  function added(ticker: string, securityId: bigint): AddSecurityResponse {
    return {
      $typeName: 'finance.AddSecurityResponse',
      security: create(SecurityProfileSchema, { securityId, ticker, currencyCode: 'USD' }),
    } as AddSecurityResponse;
  }

  beforeEach(() => {
    requests = [];
    respond = (request) => added(request.ticker, 42n);
    close = vi.fn();
    restoreApi = installFakeApi(({ service }) => {
      service(SecurityService, {
        addSecurity: (request) => {
          requests.push({ ticker: request.ticker, currencyCode: request.currencyCode });
          return respond(request);
        },
      });
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: MatDialogRef, useValue: { close } },
      ],
    });
  });

  afterEach(() => restoreApi());

  async function render(): Promise<ComponentFixture<AddSecurityDialog>> {
    const fixture = TestBed.createComponent(AddSecurityDialog);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function host(fixture: ComponentFixture<AddSecurityDialog>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function button(fixture: ComponentFixture<AddSecurityDialog>, label: string): HTMLButtonElement {
    const found = Array.from(host(fixture).querySelectorAll('button')).find(
      (b) => b.textContent!.trim() === label,
    );
    if (!found) throw new Error(`no ${label} button`);
    return found;
  }

  /** Types into the ticker input so ngModel — not a field poke —
   *  carries the value (zoneless never sees a bare assignment). */
  async function typeTicker(
    fixture: ComponentFixture<AddSecurityDialog>,
    text: string,
  ): Promise<void> {
    const input = host(fixture).querySelector<HTMLInputElement>('input[matInput]')!;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture);
  }

  /** Opens the currency mat-select (overlay-rendered) and picks one. */
  async function pickCurrency(
    fixture: ComponentFixture<AddSecurityDialog>,
    code: string,
  ): Promise<void> {
    host(fixture).querySelector<HTMLElement>('mat-select')!.click();
    await settle(fixture);
    const option = Array.from(document.querySelectorAll<HTMLElement>('mat-option')).find(
      (o) => o.textContent!.trim() === code,
    );
    if (!option) throw new Error(`no ${code} option`);
    option.click();
    await settle(fixture);
  }

  it('renders the two fields and disables Submit until a ticker is typed', async () => {
    const fixture = await render();
    expect(host(fixture).textContent).toContain('Add New Security');
    expect(button(fixture, 'Submit').disabled).toBe(true);

    await typeTicker(fixture, '   ');
    expect(button(fixture, 'Submit').disabled).toBe(true); // whitespace is not a ticker

    await typeTicker(fixture, 'vti');
    expect(button(fixture, 'Submit').disabled).toBe(false);
  });

  it('upper-cases and trims the ticker and defaults the currency to USD', async () => {
    const fixture = await render();
    await typeTicker(fixture, '  vti  ');
    button(fixture, 'Submit').click();
    await settle(fixture);
    expect(requests).toEqual([{ ticker: 'VTI', currencyCode: 'USD' }]);
  });

  it('sends the currency chosen in the select', async () => {
    const fixture = await render();
    await typeTicker(fixture, 'eufund');
    await pickCurrency(fixture, 'EUR');
    expect(fixture.componentInstance.currencyCode).toBe('EUR');
    button(fixture, 'Submit').click();
    await settle(fixture);
    expect(requests).toEqual([{ ticker: 'EUFUND', currencyCode: 'EUR' }]);
  });

  it('announces the add, closes with true, and navigates to the new details page', async () => {
    const notify = TestBed.inject(Notify);
    const success = vi.spyOn(notify, 'success');
    respond = () => added('BONDX', 7n);
    const fixture = await render();
    await typeTicker(fixture, 'bondx');
    button(fixture, 'Submit').click();
    await settle(fixture);

    expect(success).toHaveBeenCalledWith('BONDX added — fill in its profile');
    expect(close).toHaveBeenCalledWith(true);
    expect(navigate).toHaveBeenCalledWith(['/securities', 7n]);
    // The close precedes the navigation, so the list reload is queued
    // before the router leaves the page.
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
    expect(fixture.componentInstance.busy()).toBe(false);
  });

  it('keeps Submit disabled while the add is in flight', async () => {
    let release!: (response: AddSecurityResponse) => void;
    respond = () => new Promise<AddSecurityResponse>((resolve) => (release = resolve));
    const fixture = await render();
    await typeTicker(fixture, 'vti');
    button(fixture, 'Submit').click();
    await settle(fixture);

    expect(fixture.componentInstance.busy()).toBe(true);
    expect(button(fixture, 'Submit').disabled).toBe(true);
    expect(close).not.toHaveBeenCalled();

    release(added('VTI', 42n));
    await settle(fixture);
    expect(fixture.componentInstance.busy()).toBe(false);
    expect(close).toHaveBeenCalledWith(true);
  });

  it('surfaces a rejected add in the error snackbar and leaves the dialog open', async () => {
    const notify = TestBed.inject(Notify);
    const error = vi.spyOn(notify, 'error');
    const success = vi.spyOn(notify, 'success');
    respond = () => {
      throw new ConnectError('ticker "VTI" already exists', Code.AlreadyExists);
    };
    const fixture = await render();
    await typeTicker(fixture, 'vti');
    button(fixture, 'Submit').click();
    await settle(fixture);

    expect(error).toHaveBeenCalledTimes(1);
    const err = error.mock.calls[0][0] as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.rawMessage).toBe('ticker "VTI" already exists');
    expect(success).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    // busy() is released in `finally`, so the user can correct and retry.
    expect(fixture.componentInstance.busy()).toBe(false);
    expect(button(fixture, 'Submit').disabled).toBe(false);
    expect(fixture.componentInstance.ticker).toBe('vti'); // input keeps what was typed
  });

  it('Cancel closes without a value and never calls the server', async () => {
    const fixture = await render();
    await typeTicker(fixture, 'vti');
    button(fixture, 'Cancel').click();
    await settle(fixture);
    expect(requests).toEqual([]);
    // A bare `mat-dialog-close` attribute closes with '' (not
    // undefined); falsy either way, so the list never reloads.
    expect(close).toHaveBeenCalledWith('');
  });
});
