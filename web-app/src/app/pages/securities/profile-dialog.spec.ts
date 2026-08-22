// Unit spec for ProfileDialog (docs/design/ui-testing.md, inventory
// "SecurityDetailsPage -> ProfileDialog"): prefill and UNSPECIFIED
// defaulting, the three enum selects, the expense-ratio decimal
// validator, and the submit/close/error paths.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PricingLocus,
  SecurityProfileSchema,
  SecurityService,
  SecurityType,
  TaxTreatment,
  type SecurityProfile,
  type UpdateSecurityProfileRequest,
} from '../../../proto-gen/securities_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { sampleAllSecurities } from '../../../testing/sample-data';
import { fraction } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { ProfileDialog } from './profile-dialog';

/** The seeder's VTI profile. Shared-infrastructure gap: sample-data.ts
 *  has no SecurityProfile builder yet. */
function profile(
  overrides: MessageInitShape<typeof SecurityProfileSchema> = {},
): SecurityProfile {
  return create(SecurityProfileSchema, {
    securityId: 1n,
    ticker: 'VTI',
    description: 'Total Market ETF',
    currencyCode: 'USD',
    securityType: SecurityType.ETF,
    pricingLocus: PricingLocus.MARKET,
    taxTreatment: TaxTreatment.LOTS,
    netExpenseRatio: fraction('0.0003', '0.03%'),
    ...overrides,
  });
}

type Update = {
  securityId: bigint;
  description: string;
  securityType: SecurityType;
  pricingLocus: PricingLocus;
  taxTreatment: TaxTreatment;
  netExpenseRatio: string;
};

function updateOf(request: UpdateSecurityProfileRequest): Update {
  return {
    securityId: request.securityId,
    description: request.description,
    securityType: request.securityType,
    pricingLocus: request.pricingLocus,
    taxTreatment: request.taxTreatment,
    netExpenseRatio: request.netExpenseRatio?.value ?? '',
  };
}

/** The identifier / mirror fields, presence included (proto3 optional). */
type Identifiers = {
  marketTicker?: string;
  cusip?: string;
  isin?: string;
  mirrorsSecurityId?: bigint;
};

function identifiersOf(request: UpdateSecurityProfileRequest): Identifiers {
  return {
    marketTicker: request.marketTicker,
    cusip: request.cusip,
    isin: request.isin,
    mirrorsSecurityId: request.mirrorsSecurityId,
  };
}

let tickers: (string | undefined)[] = [];

describe('ProfileDialog', () => {
  let restoreApi: () => void;
  let updates: Update[];
  let identifiers: Identifiers[];
  let respond: () => unknown;
  let closed: unknown[];

  beforeEach(() => {
    updates = [];
    identifiers = [];
    closed = [];
    respond = () => ({});
    restoreApi = installFakeApi(({ service }) => {
      service(SecurityService, {
        updateSecurityProfile: (request) => {
          updates.push(updateOf(request));
          identifiers.push(identifiersOf(request));
          tickers.push(request.ticker);
          return respond() as never;
        },
      });
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: MatDialogRef, useValue: { close: (v: unknown) => closed.push(v) } },
      ],
    });
  });

  afterEach(() => restoreApi());

  async function render(security: SecurityProfile = profile()) {
    TestBed.overrideProvider(MAT_DIALOG_DATA, { useValue: { security } });
    const fixture = TestBed.createComponent(ProfileDialog);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function host(fixture: { nativeElement: unknown }): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  /** The matInput under the mat-form-field whose label starts with `label`. */
  function inputFor(fixture: { nativeElement: unknown }, label: string): HTMLInputElement {
    const field = Array.from(host(fixture).querySelectorAll('mat-form-field')).find((f) =>
      f.querySelector('mat-label')?.textContent?.trim().startsWith(label),
    );
    const input = field?.querySelector('input');
    if (!input) throw new Error(`no input labelled ${label}`);
    return input;
  }

  async function type(
    fixture: { nativeElement: unknown; detectChanges(): void },
    label: string,
    value: string,
  ): Promise<void> {
    const input = inputFor(fixture, label);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture as never);
  }

  function submitButton(fixture: { nativeElement: unknown }): HTMLButtonElement {
    const button = Array.from(host(fixture).querySelectorAll('button')).find((b) =>
      b.textContent!.includes('Submit'),
    );
    if (!button) throw new Error('Submit button not rendered');
    return button;
  }

  /** The mat-select trigger under the form field labelled `label`. */
  function selectTrigger(fixture: { nativeElement: unknown }, label: string): HTMLElement {
    const trigger = Array.from(host(fixture).querySelectorAll('mat-form-field'))
      .find((f) => f.querySelector('mat-label')?.textContent?.trim() === label)
      ?.querySelector<HTMLElement>('[role="combobox"]');
    if (!trigger) throw new Error(`no select labelled ${label}`);
    return trigger;
  }

  /** Opens a mat-select and returns its option elements. The panel is
   *  found through the trigger's aria-controls - a just-closed panel
   *  can still sit in the shared overlay container. */
  async function openSelect(
    fixture: { nativeElement: unknown; detectChanges(): void },
    label: string,
  ): Promise<HTMLElement[]> {
    const trigger = selectTrigger(fixture, label);
    trigger.click();
    await settle(fixture as never);
    const panelId = trigger.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!panel) throw new Error(`select ${label} did not open`);
    return Array.from(panel.querySelectorAll<HTMLElement>('mat-option'));
  }

  /** Picks an option by its visible text - the values are enum numbers. */
  async function pickOption(
    fixture: { nativeElement: unknown; detectChanges(): void },
    label: string,
    optionText: string,
  ): Promise<void> {
    const options = await openSelect(fixture, label);
    const option = options.find((o) => o.textContent!.trim().startsWith(optionText));
    if (!option) throw new Error(`no option ${optionText} under ${label}`);
    option.click();
    await settle(fixture as never);
  }

  it('prefills the form from the security profile', async () => {
    const fixture = await render();
    const dialog = fixture.componentInstance;
    expect(host(fixture).textContent).toContain('Edit VTI');
    expect(inputFor(fixture, 'Description').value).toBe('Total Market ETF');
    expect(inputFor(fixture, 'Net Expense Ratio').value).toBe('0.0003');
    expect(dialog.securityType).toBe(SecurityType.ETF);
    expect(dialog.pricingLocus).toBe(PricingLocus.MARKET);
    expect(dialog.taxTreatment).toBe(TaxTreatment.LOTS);
    expect(submitButton(fixture).disabled).toBe(false);
  });

  it('defaults unspecified enums and a missing ratio', async () => {
    const fixture = await render(
      profile({
        securityType: SecurityType.SECURITY_TYPE_UNSPECIFIED,
        pricingLocus: PricingLocus.PRICING_LOCUS_UNSPECIFIED,
        taxTreatment: TaxTreatment.TAX_TREATMENT_UNSPECIFIED,
        netExpenseRatio: undefined,
        description: '',
      }),
    );
    const dialog = fixture.componentInstance;
    expect(dialog.securityType).toBe(SecurityType.STOCK);
    expect(dialog.pricingLocus).toBe(PricingLocus.MARKET);
    expect(dialog.taxTreatment).toBe(TaxTreatment.LOTS);
    expect(inputFor(fixture, 'Net Expense Ratio').value).toBe('0');
    expect(inputFor(fixture, 'Description').value).toBe('');
  });

  it('rejects non-decimal expense ratios and disables Submit', async () => {
    const fixture = await render();
    for (const bad of ['abc', '-0.01', '1e-4', '']) {
      await type(fixture, 'Net Expense Ratio', bad);
      expect(fixture.componentInstance.ratioValid()).toBe(false);
      expect(submitButton(fixture).disabled).toBe(true);
      // BUG: the mat-error never reaches the screen. mat-form-field
      // only projects errors while the control's errorState is true,
      // and this is a bare ngModel with no Angular validator - so the
      // user gets a disabled Submit and no explanation.
      expect(host(fixture).querySelector('mat-error')).toBeNull();
      expect(host(fixture).textContent).not.toContain('Enter a plain decimal like 0.0004');
    }
    await type(fixture, 'Net Expense Ratio', '0.0004');
    expect(fixture.componentInstance.ratioValid()).toBe(true);
    expect(submitButton(fixture).disabled).toBe(false);
  });

  it('offers every security type, pricing locus and tax treatment', async () => {
    const fixture = await render();
    const texts = async (label: string) =>
      (await openSelect(fixture, label)).map((o) => o.textContent!.trim());

    expect(await texts('Security Type')).toEqual([
      'Stock',
      'ETF',
      'Mutual Fund',
      'Collective Trust',
      'Private Investment',
    ]);
    expect(await texts('Pricing')).toEqual([
      'Market (provider quotes)',
      'Manual (private price history)',
    ]);
    expect(await texts('Tax Treatment')).toEqual([
      'Purchase lots (capital gains)',
      'Mark-to-market (PFIC sec. 1296, ordinary income)',
    ]);
  });

  it('prefills the symbol, sends it upper-cased and trimmed, and refuses a blank one', async () => {
    tickers = [];
    const fixture = await render();
    expect(inputFor(fixture, 'Symbol').value).toBe('VTI');
    await type(fixture, 'Symbol', '   ');
    expect(submitButton(fixture).disabled).toBe(true);
    await type(fixture, 'Symbol', ' vbtix-tr ');
    expect(submitButton(fixture).disabled).toBe(false);
    submitButton(fixture).click();
    await settle(fixture);
    expect(tickers).toEqual(['VBTIX-TR']);
  });

  it('sends the identifiers, and the mirror only when candidates were offered', async () => {
    // Without candidates (an older caller) the mirror field is absent
    // from the form and from the request, so the server keeps it.
    const plain = await render();
    await type(plain, 'CUSIP', ' 922908769 ');
    submitButton(plain).click();
    await settle(plain);
    expect(identifiers).toEqual([
      { marketTicker: '', cusip: '922908769', isin: '', mirrorsSecurityId: undefined },
    ]);
    expect(host(plain).textContent).not.toContain('Mirrors');
  });

  it('offers every other security as the mirror and sends the chosen one', async () => {
    TestBed.overrideProvider(MAT_DIALOG_DATA, {
      useValue: {
        security: profile({ securityId: 4n, ticker: 'EUFUND-TR' }),
        mirrorCandidates: sampleAllSecurities(),
      },
    });
    const fixture = TestBed.createComponent(ProfileDialog);
    fixture.detectChanges();
    await settle(fixture);
    const options = (await openSelect(fixture, 'Mirrors')).map((o) => o.textContent!.trim());
    // Every seeded listing but EUFUND itself (id 4), hidden GHOST included.
    expect(options).toEqual([
      'None',
      'BONDX - Aggregate Bond Fund',
      'GHOST - Hidden test security',
      'GOLD - Gold coins in a vault',
      'SOLO - Priced, never held',
      'VTI - Total Market ETF',
    ]);
    await pickOption(fixture, 'Mirrors', 'VTI - Total Market ETF');
    await pickOption(fixture, 'Pricing', 'Market');
    await type(fixture, 'Provider symbol', 'vti.us');
    submitButton(fixture).click();
    await settle(fixture);
    expect(identifiers).toEqual([
      { marketTicker: 'vti.us', cusip: '', isin: '', mirrorsSecurityId: 1n },
    ]);
  });

  it('submits the edited profile, notifies, and closes with true', async () => {
    const fixture = await render();
    const success = vi.spyOn(TestBed.inject(Notify), 'success');

    await type(fixture, 'Description', '  Vanguard Total Market  ');
    await type(fixture, 'Net Expense Ratio', ' 0.0004 ');
    await pickOption(fixture, 'Security Type', 'Mutual Fund');
    await pickOption(fixture, 'Pricing', 'Manual');
    await pickOption(fixture, 'Tax Treatment', 'Mark-to-market');

    submitButton(fixture).click();
    await settle(fixture);

    expect(updates).toEqual([
      {
        securityId: 1n,
        description: 'Vanguard Total Market',
        securityType: SecurityType.MUTUAL_FUND,
        pricingLocus: PricingLocus.MANUAL,
        taxTreatment: TaxTreatment.MARK_TO_MARKET,
        netExpenseRatio: '0.0004',
      },
    ]);
    expect(success).toHaveBeenCalledWith('Profile updated');
    expect(closed).toEqual([true]);
  });

  it('disables Submit while the update is in flight', async () => {
    const fixture = await render();
    let release!: () => void;
    respond = () => new Promise<unknown>((resolve) => (release = () => resolve({})));
    submitButton(fixture).click();
    await settle(fixture);
    expect(fixture.componentInstance.busy()).toBe(true);
    expect(submitButton(fixture).disabled).toBe(true);
    release();
    await settle(fixture);
    expect(fixture.componentInstance.busy()).toBe(false);
    expect(closed).toEqual([true]);
  });

  it('keeps the dialog open and reports a rejected update', async () => {
    const fixture = await render();
    const errorSpy = vi.spyOn(TestBed.inject(Notify), 'error');
    respond = () => {
      throw new ConnectError('net expense ratio must not be negative', Code.InvalidArgument);
    };
    submitButton(fixture).click();
    await settle(fixture);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0][0] as ConnectError).rawMessage).toBe(
      'net expense ratio must not be negative',
    );
    expect(updates).toHaveLength(1);
    expect(closed).toEqual([]);
    expect(fixture.componentInstance.busy()).toBe(false);
    expect(submitButton(fixture).disabled).toBe(false);
  });
});
