// Unit spec for SecuritiesPage (docs/design/ui-testing.md, inventory
// "SecuritiesPage"). Fake SecurityService via installFakeApi; the
// sparkline is plain SVG, so it is asserted directly rather than
// through a chart stub. MatDialog is stubbed at the component
// injector so the FAB's reload-on-change contract can be driven
// without an overlay - the dialog itself has its own spec.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideRouter } from '@angular/router';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SecurityListingSchema,
  SecurityService,
  SparklineSchema,
  type SecurityListing,
  type SetSecurityHiddenRequest,
} from '../../../proto-gen/securities_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { sampleSecurities } from '../../../testing/sample-data';
import { settle } from '../../../testing/settle';
import { decimal } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { AddSecurityDialog } from './add-security-dialog';
import { SecuritiesPage } from './securities-page';

/** Shared-infrastructure gap: sample-data.ts stops at VTI / EUFUND /
 *  GHOST, so the seeder's single-close case (a security priced only
 *  once inside the sparkline window) is built locally. */
function onePointSecurity(): SecurityListing {
  return create(SecurityListingSchema, {
    securityId: 6n,
    ticker: 'GOLD',
    description: 'Gold coins in a vault',
    sparkline: create(SparklineSchema, { adjustedCloses: [decimal('3358.5')] }),
  });
}

describe('SecuritiesPage', () => {
  let restoreApi: () => void;
  let listRequests: { includeHidden: boolean }[];
  let hideRequests: { securityId: bigint; hidden: boolean }[];
  let listing: () => SecurityListing[];
  let onSetHidden: (request: SetSecurityHiddenRequest) => void;
  let dialogResult: unknown;
  let dialogOpen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listRequests = [];
    hideRequests = [];
    listing = () => sampleSecurities();
    onSetHidden = () => {};
    dialogResult = undefined;
    dialogOpen = vi.fn(() => ({ afterClosed: () => of(dialogResult) }));

    restoreApi = installFakeApi(({ service }) => {
      service(SecurityService, {
        listSecurities: (request) => {
          listRequests.push({ includeHidden: request.includeHidden });
          const all = listing();
          return {
            securities: request.includeHidden ? all : all.filter((s) => !s.hidden),
          };
        },
        setSecurityHidden: (request) => {
          hideRequests.push({ securityId: request.securityId, hidden: request.hidden });
          onSetHidden(request);
          return {};
        },
      });
    });

    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    // Component-level provider: it wins over MatDialogModule's own.
    TestBed.overrideComponent(SecuritiesPage, {
      add: { providers: [{ provide: MatDialog, useValue: { open: dialogOpen } }] },
    });
  });

  afterEach(() => restoreApi());

  async function render(): Promise<ComponentFixture<SecuritiesPage>> {
    const fixture = TestBed.createComponent(SecuritiesPage);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function host(fixture: ComponentFixture<SecuritiesPage>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function rows(fixture: ComponentFixture<SecuritiesPage>): string[][] {
    return Array.from(host(fixture).querySelectorAll('tr[mat-row]'), (row) =>
      Array.from(row.querySelectorAll('td'), (cell) => cell.textContent!.trim()),
    );
  }

  function rowFor(fixture: ComponentFixture<SecuritiesPage>, ticker: string): HTMLElement {
    const row = Array.from(host(fixture).querySelectorAll<HTMLElement>('tr[mat-row]')).find((r) =>
      r.querySelector('a')?.textContent?.trim().startsWith(ticker),
    );
    if (!row) throw new Error(`no row for ${ticker}`);
    return row;
  }

  /** Flips the show-hidden slide toggle the way a user does. */
  async function toggleShowHidden(fixture: ComponentFixture<SecuritiesPage>): Promise<void> {
    const input = host(fixture).querySelector<HTMLInputElement>('mat-slide-toggle button');
    if (!input) throw new Error('slide toggle not rendered');
    input.click();
    await settle(fixture);
  }

  it('lists only visible securities and asks the server for exactly that', async () => {
    const fixture = await render();
    expect(listRequests).toEqual([{ includeHidden: false }]);
    const tickers = rows(fixture).map((row) => row[0]);
    expect(tickers).toEqual(['VTI', 'EUFUND']);
    expect(host(fixture).textContent).toContain('Total Market ETF');
    expect(host(fixture).textContent).not.toContain('GHOST');
    expect(host(fixture).querySelector('.empty-note')).toBeNull();
  });

  it('links each ticker to its details page', async () => {
    const fixture = await render();
    const links = Array.from(host(fixture).querySelectorAll('tr[mat-row] a'), (a) => [
      a.textContent!.trim(),
      a.getAttribute('href'),
    ]);
    expect(links).toEqual([
      ['VTI', '/securities/1'],
      ['EUFUND', '/securities/4'],
    ]);
  });

  it('show-hidden refetches and marks the hidden row', async () => {
    const fixture = await render();
    await toggleShowHidden(fixture);
    expect(listRequests).toEqual([{ includeHidden: false }, { includeHidden: true }]);
    expect(fixture.componentInstance.showHidden()).toBe(true);
    const ghost = rowFor(fixture, 'GHOST');
    expect(ghost.textContent).toContain('(hidden)');
    expect(ghost.querySelector('button[aria-label="Unhide"]')).not.toBeNull();
    // Visible rows carry neither the tag nor the action.
    expect(rowFor(fixture, 'VTI').textContent).not.toContain('(hidden)');
    expect(rowFor(fixture, 'VTI').querySelector('button')).toBeNull();
  });

  it('draws a sparkline path only with two or more closes', async () => {
    listing = () => [...sampleSecurities(), onePointSecurity()];
    const fixture = await render();
    // VTI carries four closes; EUFUND none; GOLD exactly one.
    expect(rowFor(fixture, 'VTI').querySelectorAll('svg path')).toHaveLength(1);
    expect(rowFor(fixture, 'EUFUND').querySelectorAll('svg path')).toHaveLength(0);
    expect(rowFor(fixture, 'GOLD').querySelectorAll('svg path')).toHaveLength(0);
    // Every row still gets the (aria-hidden) svg shell.
    expect(host(fixture).querySelectorAll('tr[mat-row] svg')).toHaveLength(3);
  });

  it('trend() converts wire decimals to plain chart magnitudes', async () => {
    const fixture = await render();
    const [vti, eufund] = sampleSecurities();
    expect(fixture.componentInstance.trend(vti)).toEqual([198, 199.5, 200.1, 201.9]);
    expect(fixture.componentInstance.trend(eufund)).toEqual([]);
  });

  it('shows the empty note when the portfolio has no securities', async () => {
    listing = () => [];
    const fixture = await render();
    expect(rows(fixture)).toEqual([]);
    expect(host(fixture).querySelector('.empty-note')!.textContent!.trim()).toBe(
      'No securities yet - add the first with the button below.',
    );
  });

  it('unhide clears the flag, announces it, and reloads', async () => {
    const fixture = await render();
    await toggleShowHidden(fixture);
    const notify = TestBed.inject(Notify);
    const success = vi.spyOn(notify, 'success');
    // The server would drop the flag; the fake list follows suit.
    onSetHidden = () => {
      listing = () => sampleSecurities().map((s) => (s.ticker === 'GHOST' ? { ...s, hidden: false } : s));
    };

    rowFor(fixture, 'GHOST').querySelector<HTMLButtonElement>('button[aria-label="Unhide"]')!.click();
    await settle(fixture);

    expect(hideRequests).toEqual([{ securityId: 5n, hidden: false }]);
    expect(success).toHaveBeenCalledWith('GHOST is visible again');
    // Reloaded with the toggle still on, and the tag is gone.
    expect(listRequests).toEqual([
      { includeHidden: false },
      { includeHidden: true },
      { includeHidden: true },
    ]);
    expect(rowFor(fixture, 'GHOST').textContent).not.toContain('(hidden)');
  });

  it('routes a failed unhide to the error snackbar and skips the reload', async () => {
    const fixture = await render();
    await toggleShowHidden(fixture);
    const notify = TestBed.inject(Notify);
    const error = vi.spyOn(notify, 'error');
    const success = vi.spyOn(notify, 'success');
    onSetHidden = () => {
      throw new ConnectError('security has open positions', Code.FailedPrecondition);
    };

    rowFor(fixture, 'GHOST').querySelector<HTMLButtonElement>('button[aria-label="Unhide"]')!.click();
    await settle(fixture);

    expect(error).toHaveBeenCalledTimes(1);
    const err = error.mock.calls[0][0] as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.rawMessage).toBe('security has open positions');
    expect(success).not.toHaveBeenCalled();
    expect(listRequests).toHaveLength(2); // no reload after the failure
    expect(rowFor(fixture, 'GHOST').textContent).toContain('(hidden)');
  });

  it('routes a failed list to the error snackbar and keeps the last rows', async () => {
    const fixture = await render();
    const notify = TestBed.inject(Notify);
    const error = vi.spyOn(notify, 'error');
    listing = () => {
      throw new ConnectError('database is unavailable', Code.Unavailable);
    };

    await fixture.componentInstance.reload();
    await settle(fixture);

    expect(error).toHaveBeenCalledTimes(1);
    expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('database is unavailable');
    expect(rows(fixture).map((row) => row[0])).toEqual(['VTI', 'EUFUND']);
    // The stale table stays, so the empty note must not appear.
    expect(host(fixture).querySelector('.empty-note')).toBeNull();
  });

  it('the add FAB opens AddSecurityDialog and reloads only when it reports a change', async () => {
    const fixture = await render();
    const fab = host(fixture).querySelector<HTMLButtonElement>('button[aria-label="Add security"]')!;

    fab.click();
    await settle(fixture);
    expect(dialogOpen).toHaveBeenCalledWith(AddSecurityDialog);
    expect(listRequests).toHaveLength(1); // cancelled: afterClosed() -> undefined

    dialogResult = true;
    fab.click();
    await settle(fixture);
    expect(dialogOpen).toHaveBeenCalledTimes(2);
    expect(listRequests).toEqual([{ includeHidden: false }, { includeHidden: false }]);
  });

  it('keeps the show-hidden choice when the dialog adds a security', async () => {
    const fixture = await render();
    await toggleShowHidden(fixture);
    dialogResult = true;
    host(fixture).querySelector<HTMLButtonElement>('button[aria-label="Add security"]')!.click();
    await settle(fixture);
    expect(listRequests.at(-1)).toEqual({ includeHidden: true });
  });
});
