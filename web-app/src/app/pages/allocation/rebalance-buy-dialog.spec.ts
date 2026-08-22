// Unit spec for RebalanceBuyDialog (docs/design/ui-testing.md,
// inventory "RebalancePage"). The dialog makes no RPCs - it is pure
// client-side decimal math over the class's candidate funds - so
// there is no fake backend here, only MAT_DIALOG_DATA and a stub
// MatDialogRef.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { create } from '@bufbuild/protobuf';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CandidateFundSchema,
  RebalanceClassSchema,
  type CandidateFund,
  type RebalanceClass,
} from '../../../proto-gen/allocation_pb';
import { settle } from '../../../testing/settle';
import { fraction, money } from '../../../testing/wire';
import { RebalanceBuyDialog } from './rebalance-buy-dialog';

// Shared-infrastructure gap: sample-data.ts has no rebalance builders,
// so the Bond class of the seeded portfolio (BONDX at $10.50, and a
// second, less concentrated candidate for the ordering/weight text)
// is built here.
function bondCandidates(): CandidateFund[] {
  return [
    create(CandidateFundSchema, {
      securityId: 2n,
      ticker: 'BONDX',
      classWeight: fraction('1', '100%'),
      suggestedShares: { value: '3098.00000000' },
      pricePerShare: money('10.5000', { display: '$10.50' }),
      cost: money('32529.0000', { display: '$32,529.00' }),
    }),
    create(CandidateFundSchema, {
      securityId: 6n,
      ticker: 'BALANCED',
      classWeight: fraction('0.9', '90%'),
      suggestedShares: { value: '1200.00000000' },
      pricePerShare: money('30.0000', { display: '$30.00' }),
      cost: money('36000.0000', { display: '$36,000.00' }),
    }),
  ];
}

function bondClass(candidates: CandidateFund[] = bondCandidates()): RebalanceClass {
  return create(RebalanceClassSchema, {
    name: 'Bond',
    beforeFraction: fraction('0.0261', '2.61%'),
    afterFraction: fraction('0.0261', '2.61%'),
    targetFraction: fraction('0.2', '20%'),
    residual: money('-32535.00', { display: '($32,535.00)' }),
    atOrOverTarget: false,
    candidates,
  });
}

describe('RebalanceBuyDialog', () => {
  let closed: unknown[];
  let rebalanceClass: RebalanceClass;

  beforeEach(() => {
    closed = [];
    rebalanceClass = bondClass();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: MAT_DIALOG_DATA, useValue: { rebalanceClass } },
        {
          provide: MatDialogRef,
          useValue: { close: (result?: unknown) => closed.push(result) },
        },
      ],
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(RebalanceBuyDialog);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function host(fixture: { nativeElement: HTMLElement }): HTMLElement {
    return fixture.nativeElement;
  }

  function labels(fixture: { nativeElement: HTMLElement }): string[] {
    return Array.from(host(fixture).querySelectorAll('mat-label'), (l) => l.textContent!.trim());
  }

  function fieldByLabel(fixture: { nativeElement: HTMLElement }, label: string): HTMLElement {
    const field = Array.from(host(fixture).querySelectorAll<HTMLElement>('mat-form-field')).find(
      (f) => f.querySelector('mat-label')?.textContent?.trim() === label,
    );
    if (!field) throw new Error(`no form field labelled ${label}`);
    return field;
  }

  function inputByLabel(fixture: { nativeElement: HTMLElement }, label: string): HTMLInputElement {
    return fieldByLabel(fixture, label).querySelector('input')!;
  }

  function buttonByText(fixture: { nativeElement: HTMLElement }, text: string): HTMLButtonElement {
    const button = Array.from(host(fixture).querySelectorAll('button')).find((b) =>
      b.textContent!.includes(text),
    );
    if (!button) throw new Error(`no button labelled ${text}`);
    return button;
  }

  /** Opens the Security mat-select and returns its freshly opened
   *  overlay panel, found through the trigger's aria-controls: a
   *  document-wide mat-option query can pick up a just-closed panel
   *  still lingering in the shared overlay container. */
  async function openSecuritySelect(fixture: {
    nativeElement: HTMLElement;
    detectChanges(): void;
  }): Promise<HTMLElement> {
    const field = fieldByLabel(fixture, 'Security');
    const select = field.querySelector('mat-select');
    const trigger = field.querySelector<HTMLElement>('.mat-mdc-select-trigger');
    if (!select || !trigger) throw new Error('the Security select is not rendered');
    trigger.click();
    await settle(fixture as never);
    const panelId = select.getAttribute('aria-controls');
    if (!panelId) throw new Error('the Security select did not open');
    const panel = document.getElementById(panelId);
    if (!panel) throw new Error(`no open select panel ${panelId}`);
    return panel;
  }

  async function pickCandidate(
    fixture: { nativeElement: HTMLElement; detectChanges(): void },
    ticker: string,
  ): Promise<void> {
    const panel = await openSecuritySelect(fixture);
    const option = Array.from(panel.querySelectorAll<HTMLElement>('mat-option')).find((o) =>
      o.textContent!.includes(ticker),
    );
    if (!option) throw new Error(`no candidate option for ${ticker}`);
    option.click();
    await settle(fixture as never);
  }

  /** Types into a matInput the way a user does - a bare signal write
   *  never re-renders under zoneless change detection. */
  async function type(
    fixture: { nativeElement: HTMLElement; detectChanges(): void },
    label: string,
    value: string,
  ): Promise<void> {
    const input = inputByLabel(fixture, label);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture as never);
  }

  it('shows only the security select until a candidate is picked', async () => {
    const fixture = await render();
    expect(labels(fixture)).toEqual(['Security']);
    expect(host(fixture).textContent).toContain('Propose Security Purchase for Rebalance');
    expect(buttonByText(fixture, 'Add to Plan').disabled).toBe(true);
    expect(fixture.componentInstance.valid()).toBe(false);
  });

  it('lists the class candidates with their weight in the class', async () => {
    const fixture = await render();
    const panel = await openSecuritySelect(fixture);
    expect(Array.from(panel.querySelectorAll('mat-option'), (o) => o.textContent!.trim())).toEqual([
      'BONDX - 100% in Bond',
      'BALANCED - 90% in Bond',
    ]);
  });

  it('auto-fills the suggested purchase and shows the price read-only', async () => {
    const fixture = await render();
    await pickCandidate(fixture, 'BONDX');
    expect(labels(fixture)).toEqual(['Security', 'Price Per Share', 'Shares', 'Net Cost']);
    const price = inputByLabel(fixture, 'Price Per Share');
    expect(price.value).toBe('$10.50');
    expect(price.readOnly).toBe(true);
    // The wire values, verbatim: the suggestion is not reformatted.
    expect(inputByLabel(fixture, 'Shares').value).toBe('3098.00000000');
    expect(inputByLabel(fixture, 'Net Cost').value).toBe('32529.0000');
    expect(buttonByText(fixture, 'Add to Plan').disabled).toBe(false);
  });

  it('re-fills from the newly picked candidate when the security changes', async () => {
    const fixture = await render();
    await pickCandidate(fixture, 'BONDX');
    await pickCandidate(fixture, 'BALANCED');
    expect(inputByLabel(fixture, 'Price Per Share').value).toBe('$30.00');
    expect(inputByLabel(fixture, 'Shares').value).toBe('1200.00000000');
    expect(inputByLabel(fixture, 'Net Cost').value).toBe('36000.0000');
  });

  it('recomputes net cost from shares with exact decimal arithmetic', async () => {
    const fixture = await render();
    await pickCandidate(fixture, 'BONDX');
    await type(fixture, 'Shares', '10');
    expect(inputByLabel(fixture, 'Net Cost').value).toBe('105');
    await type(fixture, 'Shares', '0.3');
    expect(inputByLabel(fixture, 'Net Cost').value).toBe('3.15');
    // Truncation to 4 places, never a float: 0.33333333 x 10.50.
    await type(fixture, 'Shares', '0.33333333');
    expect(inputByLabel(fixture, 'Net Cost').value).toBe('3.4999');
  });

  it('recomputes shares from net cost with exact decimal arithmetic', async () => {
    const fixture = await render();
    await pickCandidate(fixture, 'BONDX');
    await type(fixture, 'Net Cost', '105');
    expect(inputByLabel(fixture, 'Shares').value).toBe('10');
    // 100 / 10.50 truncated to 8 places.
    await type(fixture, 'Net Cost', '100');
    expect(inputByLabel(fixture, 'Shares').value).toBe('9.52380952');
  });

  it('leaves the counterpart alone and blocks submit on a non-decimal entry', async () => {
    const fixture = await render();
    await pickCandidate(fixture, 'BONDX');
    await type(fixture, 'Shares', '10');
    expect(inputByLabel(fixture, 'Net Cost').value).toBe('105');

    await type(fixture, 'Shares', '-4');
    expect(inputByLabel(fixture, 'Net Cost').value).toBe('105'); // stale, by design
    expect(buttonByText(fixture, 'Add to Plan').disabled).toBe(true);
    // Nothing on screen explains why Add to Plan is disabled: the
    // dialog renders no mat-error for a malformed shares/cost.
    expect(host(fixture).querySelectorAll('mat-error')).toHaveLength(0);

    await type(fixture, 'Net Cost', '1e3');
    expect(inputByLabel(fixture, 'Shares').value).toBe('-4');
    expect(buttonByText(fixture, 'Add to Plan').disabled).toBe(true);

    await type(fixture, 'Shares', '4');
    await type(fixture, 'Net Cost', '42');
    expect(buttonByText(fixture, 'Add to Plan').disabled).toBe(false);
  });

  // CandidateFund carries no purchase modality, so the dialog cannot
  // tell a mutual fund (bought in dollars) from an ETF (bought in
  // whole shares) - see the e2e spec, which pins the server's
  // rejection of a net-cost-driven ETF trade.
  it('closes with the trimmed trade for the cart', async () => {
    const fixture = await render();
    await pickCandidate(fixture, 'BONDX');
    await type(fixture, 'Shares', ' 10 ');
    await type(fixture, 'Net Cost', ' 105 ');
    buttonByText(fixture, 'Add to Plan').click();
    await settle(fixture);
    expect(closed).toEqual([{ securityId: 2n, ticker: 'BONDX', shares: '10', cost: '105' }]);
  });

  it('Cancel closes without a trade', async () => {
    const fixture = await render();
    await pickCandidate(fixture, 'BONDX');
    buttonByText(fixture, 'Cancel').click();
    await settle(fixture);
    // A valueless mat-dialog-close closes with '' - not undefined - 
    // which the page's `if (!trade) return` guard treats as no trade.
    expect(closed).toEqual(['']);
  });

  it('skips the recompute when the candidate has no price', async () => {
    const priceless = create(CandidateFundSchema, {
      securityId: 7n,
      ticker: 'NOPRICE',
      classWeight: fraction('1', '100%'),
      suggestedShares: { value: '0.00000000' },
    });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: MAT_DIALOG_DATA,
          useValue: { rebalanceClass: bondClass([priceless]) },
        },
        {
          provide: MatDialogRef,
          useValue: { close: (result?: unknown) => closed.push(result) },
        },
      ],
    });
    const fixture = await render();
    await pickCandidate(fixture, 'NOPRICE');
    expect(inputByLabel(fixture, 'Price Per Share').value).toBe('');
    await type(fixture, 'Shares', '10');
    // With no price the cost stays empty and Add to Plan stays
    // disabled, with nothing on screen to say the candidate is
    // unusable. (The server filters priceless securities out of the
    // candidate list, so this is defence in depth.)
    expect(inputByLabel(fixture, 'Net Cost').value).toBe('');
    expect(buttonByText(fixture, 'Add to Plan').disabled).toBe(true);
  });

  it('submit() hands back the candidate id, not the displayed ticker text', () => {
    const fixture = TestBed.createComponent(RebalanceBuyDialog);
    const dialog = fixture.componentInstance;
    const spy = vi.spyOn(TestBed.inject(MatDialogRef), 'close');
    dialog.pick(rebalanceClass.candidates[1]);
    expect(dialog.shares()).toBe('1200.00000000');
    dialog.submit();
    expect(spy).toHaveBeenCalledWith({
      securityId: 6n,
      ticker: 'BALANCED',
      shares: '1200.00000000',
      cost: '36000.0000',
    });
  });
});
