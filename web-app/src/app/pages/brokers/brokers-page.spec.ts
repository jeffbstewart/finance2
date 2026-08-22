// Exemplar unit spec (docs/design/ui-testing.md): fake backend via
// installFakeApi, chart facades stubbed, zoneless TestBed. Per-page
// test agents copy this shape.
//
// Covers the `brokers` assignment: BrokersPage (table, footer totals,
// show-hidden toggle, unhide, pie facade, add FAB) and BrokerDialog
// (add vs rename modes, trimming, busy, error handling).
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef } from '@angular/material/dialog';
import { Router, provideRouter } from '@angular/router';
import { Code, ConnectError } from '@connectrpc/connect';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerService, type BrokerSummary } from '../../../proto-gen/brokers_pb';
import { ImportService, type ImportWarning } from '../../../proto-gen/imports_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { sampleBrokers, sampleImportWarnings } from '../../../testing/sample-data';
import { PieChartStub } from '../../../testing/chart-stubs';
import { Notify } from '../../core/notify';
import { PieChart } from '../../shared/charts/pie-chart';
import { BrokerDialog, type BrokerDialogData } from './broker-dialog';
import { BrokersPage } from './brokers-page';

/** Cell texts of the rows matching `selector` in the page's table. */
function cells(fixture: ComponentFixture<BrokersPage>, selector: string): string[][] {
  const host = fixture.nativeElement as HTMLElement;
  return Array.from(host.querySelectorAll(selector), (row) =>
    Array.from(row.querySelectorAll('th,td'), (c) => c.textContent!.trim()),
  );
}

function textOf(fixture: ComponentFixture<unknown>): string {
  return (fixture.nativeElement as HTMLElement).textContent!;
}

describe('BrokersPage', () => {
  let restoreApi: () => void;
  let listRequests: { includeHidden: boolean }[];
  let hideRequests: { brokerId: bigint; hidden: boolean }[];
  let dialogOpens: { component: unknown; config: unknown }[];
  let brokers: BrokerSummary[];
  let warnings: ImportWarning[];
  let warningRequests: { brokerId: bigint; accountId: bigint }[];
  let totals: { holdings: string; sweeps: string };
  let listError: ConnectError | undefined;
  let hideError: ConnectError | undefined;
  /** What the (stubbed) add dialog reports through afterClosed(). */
  let dialogResult: unknown;
  let openSpy: { mockRestore(): void };

  beforeEach(() => {
    listRequests = [];
    hideRequests = [];
    dialogOpens = [];
    brokers = sampleBrokers();
    warnings = [];
    warningRequests = [];
    totals = { holdings: '$64,000.00', sweeps: '$845.25' };
    listError = undefined;
    hideError = undefined;
    dialogResult = undefined;
    restoreApi = installFakeApi(({ service }) => {
      service(BrokerService, {
        listBrokers: (request) => {
          listRequests.push({ includeHidden: request.includeHidden });
          if (listError) throw listError;
          return {
            brokers: request.includeHidden ? brokers : brokers.filter((b) => !b.hidden),
            totalHoldings: { display: totals.holdings },
            totalSweeps: { display: totals.sweeps },
          };
        },
        setBrokerHidden: (request) => {
          hideRequests.push({ brokerId: request.brokerId, hidden: request.hidden });
          if (hideError) throw hideError;
          const broker = brokers.find((b) => b.brokerId === request.brokerId);
          if (broker) broker.hidden = request.hidden;
          return {};
        },
      });
      service(ImportService, {
        listImportWarnings: (request) => {
          warningRequests.push({ brokerId: request.brokerId, accountId: request.accountId });
          return {
            warnings: warnings.filter(
              (w) =>
                (request.accountId ? w.accountId === request.accountId : true) &&
                (request.brokerId && !request.accountId ? w.brokerId === request.brokerId : true),
            ),
          };
        },
      });
    });
    // The page only needs open()/afterClosed(); the dialog body itself
    // is exercised in the BrokerDialog suite below. The page imports
    // MatDialogModule, so MatDialog resolves from the component's own
    // standalone injector - a TestBed provider would not shadow it,
    // hence the prototype spy.
    openSpy = vi.spyOn(MatDialog.prototype, 'open').mockImplementation(((
      component: unknown,
      config: unknown,
    ) => {
      dialogOpens.push({ component, config });
      return { afterClosed: () => of(dialogResult) };
    }) as never);
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    TestBed.overrideComponent(BrokersPage, {
      remove: { imports: [PieChart] },
      add: { imports: [PieChartStub] },
    });
  });

  afterEach(() => {
    openSpy.mockRestore();
    restoreApi();
  });

  async function render() {
    const fixture = TestBed.createComponent(BrokersPage);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function rows(fixture: ComponentFixture<BrokersPage>): string[][] {
    return cells(fixture, 'tr[mat-row]');
  }

  function footer(fixture: ComponentFixture<BrokersPage>): string[] {
    return cells(fixture, 'tr[mat-footer-row]')[0] ?? [];
  }

  function pie(fixture: ComponentFixture<BrokersPage>): PieChartStub | undefined {
    const found = fixture.debugElement.query((el) => el.componentInstance instanceof PieChartStub);
    return found?.componentInstance as PieChartStub | undefined;
  }

  function button(fixture: ComponentFixture<BrokersPage>, ariaLabel: string): HTMLButtonElement {
    const host = fixture.nativeElement as HTMLElement;
    const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`);
    if (!found) throw new Error(`no button labelled ${ariaLabel}`);
    return found;
  }

  it('renders visible brokers with footer totals', async () => {
    const fixture = await render();
    const text = textOf(fixture);
    expect(text).toContain('Vanguard');
    expect(text).toContain('EuroBank');
    expect(text).not.toContain('Old Broker');
    expect(text).toContain('$64,000.00');
    expect(listRequests).toEqual([{ includeHidden: false }]);
    // name, total holdings, sweeps, row actions
    expect(rows(fixture)).toEqual([
      ['Vanguard', '$52,000.00', '$555.25', ''],
      ['EuroBank', '$12,000.00', '$290.00', ''],
    ]);
    expect(footer(fixture)).toEqual(['Total', '$64,000.00', '$845.25', '']);
  });

  it('links each broker name to its accounts page', async () => {
    const fixture = await render();
    const host = fixture.nativeElement as HTMLElement;
    const links = Array.from(host.querySelectorAll('td a'));
    expect(links.map((a) => a.textContent!.trim())).toEqual(['Vanguard', 'EuroBank']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/brokers/1', '/brokers/2']);
  });

  it('show-hidden refetches and reveals the hidden broker', async () => {
    const fixture = await render();
    fixture.componentInstance.toggleHidden(true);
    await settle(fixture);
    const text = (fixture.nativeElement as HTMLElement).textContent!;
    expect(text).toContain('Old Broker');
    expect(text).toContain('(hidden)');
    expect(listRequests).toEqual([{ includeHidden: false }, { includeHidden: true }]);
  });

  it('flipping the slide toggle from the DOM drives the refetch', async () => {
    const fixture = await render();
    const host = fixture.nativeElement as HTMLElement;
    const toggle = host.querySelector<HTMLButtonElement>('mat-slide-toggle button[role="switch"]');
    expect(toggle).toBeTruthy();
    toggle!.click();
    await settle(fixture);
    expect(fixture.componentInstance.showHidden()).toBe(true);
    expect(listRequests).toEqual([{ includeHidden: false }, { includeHidden: true }]);
    expect(rows(fixture)).toHaveLength(3);
  });

  it('marks and offers to unhide only the hidden rows', async () => {
    const fixture = await render();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('.hidden-tag')).toHaveLength(0);
    expect(host.querySelectorAll('button[aria-label="Unhide"]')).toHaveLength(0);

    fixture.componentInstance.toggleHidden(true);
    await settle(fixture);
    expect(host.querySelectorAll('.hidden-tag')).toHaveLength(1);
    const unhideButtons = Array.from(host.querySelectorAll('button[aria-label="Unhide"]'));
    expect(unhideButtons).toHaveLength(1);
    expect(unhideButtons[0].closest('tr')!.textContent).toContain('Old Broker');
  });

  it('unhide clears the flag, notifies, and refetches the current view', async () => {
    const fixture = await render();
    fixture.componentInstance.toggleHidden(true);
    await settle(fixture);
    const success = vi.spyOn(TestBed.inject(Notify), 'success');

    button(fixture, 'Unhide').click();
    await settle(fixture);

    expect(hideRequests).toEqual([{ brokerId: 3n, hidden: false }]);
    expect(success).toHaveBeenCalledWith('Old Broker is visible again');
    // The reload keeps the show-hidden view the user is looking at.
    expect(listRequests).toEqual([
      { includeHidden: false },
      { includeHidden: true },
      { includeHidden: true },
    ]);
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.hidden-tag')).toHaveLength(0);
    expect(pie(fixture)!.slices().map((s) => s.name)).toEqual([
      'Vanguard',
      'EuroBank',
      'Old Broker',
    ]);
  });

  it('routes an unhide failure to the error snackbar and leaves the row hidden', async () => {
    const fixture = await render();
    fixture.componentInstance.toggleHidden(true);
    await settle(fixture);
    const error = vi.spyOn(TestBed.inject(Notify), 'error');
    hideError = new ConnectError('the broker still has accounts', Code.FailedPrecondition);

    button(fixture, 'Unhide').click();
    await settle(fixture);

    expect(error).toHaveBeenCalledTimes(1);
    const err = error.mock.calls[0][0] as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.rawMessage).toBe('the broker still has accounts');
    expect(listRequests).toHaveLength(2); // a failed unhide does not refetch
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.hidden-tag')).toHaveLength(1);
  });

  it('routes a list failure to the error snackbar and renders no rows', async () => {
    listError = new ConnectError('database is unavailable', Code.Unavailable);
    const error = vi.spyOn(TestBed.inject(Notify), 'error');
    const fixture = await render();

    expect(error).toHaveBeenCalledTimes(1);
    expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('database is unavailable');
    expect(rows(fixture)).toEqual([]);
    expect(footer(fixture)).toEqual(['Total', '', '', '']);
    expect(pie(fixture)).toBeUndefined();
  });

  it('renders an empty portfolio as a bare table with zero totals', async () => {
    brokers = [];
    totals = { holdings: '$0.00', sweeps: '$0.00' };
    const fixture = await render();
    expect(rows(fixture)).toEqual([]);
    expect(footer(fixture)).toEqual(['Total', '$0.00', '$0.00', '']);
    expect(pie(fixture)).toBeUndefined();
    // This page has no empty-state copy (docs/design/ui-test-inventory.md).
    expect(textOf(fixture)).not.toContain('No brokers');
  });

  it('hides the pie when every listed broker is hidden', async () => {
    for (const broker of brokers) broker.hidden = true;
    const fixture = await render();
    expect(rows(fixture)).toEqual([]);
    fixture.componentInstance.toggleHidden(true);
    await settle(fixture);
    expect(rows(fixture)).toHaveLength(3);
    expect(pie(fixture)).toBeUndefined();
  });

  it('hands the pie facade only visible brokers as slices', async () => {
    const fixture = await render();
    const stub = fixture.debugElement.query(
      (el) => el.componentInstance instanceof PieChartStub,
    );
    expect(stub).toBeTruthy();
    const slices = (stub!.componentInstance as PieChartStub).slices();
    expect(slices.map((s) => s.name)).toEqual(['Vanguard', 'EuroBank']);
    expect(slices[0].display).toBe('$52,000.00');
    expect(slices[0].id).toBe('1');
    expect(slices[0].value).toBe(52000);
    // Hidden brokers stay out of the pie even when the table shows them.
    expect(pie(fixture)!.title()).toBe('Total Holdings By Broker');
  });

  it('keeps the pie in sync with the show-hidden table', async () => {
    const fixture = await render();
    fixture.componentInstance.toggleHidden(true);
    await settle(fixture);
    expect(rows(fixture)).toHaveLength(3);
    expect(pie(fixture)!.slices().map((s) => s.name)).toEqual(['Vanguard', 'EuroBank']);
  });

  it('navigates to the broker on a pie slice click', async () => {
    const fixture = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const stub = pie(fixture)!;
    stub.emitSliceClick(stub.slices()[1]);
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith(['/brokers', '2']);
  });

  it('the FAB opens an empty BrokerDialog and reloads when it reports a change', async () => {
    dialogResult = true;
    const fixture = await render();
    button(fixture, 'Add broker').click();
    await settle(fixture);
    expect(dialogOpens).toEqual([{ component: BrokerDialog, config: { data: {} } }]);
    expect(listRequests).toEqual([{ includeHidden: false }, { includeHidden: false }]);
  });

  it('badges a broker with its count of unresolved import warnings', async () => {
    warnings = sampleImportWarnings();
    const fixture = await render();
    expect(warningRequests).toEqual([{ brokerId: 0n, accountId: 0n }]);
    const host = fixture.nativeElement as HTMLElement;
    const badges = Array.from(host.querySelectorAll<HTMLAnchorElement>('.warning-badge'));
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent!.replace(/\s+/g, '')).toBe('warning2');
    expect(badges[0].getAttribute('href')).toBe('/brokers/1');
    expect(badges[0].getAttribute('aria-label')).toBe('2 import warnings');
    // Vanguard carries the badge; EuroBank has nothing to fix.
    expect(rows(fixture)[0][0]).toContain('Vanguard');
    expect(rows(fixture)[1]).toEqual(['EuroBank', '$12,000.00', '$290.00', '']);
  });

  it('shows no badge when the last import left nothing to fix', async () => {
    const fixture = await render();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.warning-badge')).toBeNull();
  });

  it('does not reload when the add dialog is dismissed', async () => {
    dialogResult = undefined;
    const fixture = await render();
    button(fixture, 'Add broker').click();
    await settle(fixture);
    expect(dialogOpens).toHaveLength(1);
    expect(listRequests).toEqual([{ includeHidden: false }]);
  });
});

describe('BrokerDialog', () => {
  let restoreApi: () => void;
  let createRequests: { name: string }[];
  let renameRequests: { brokerId: bigint; name: string }[];
  let closed: unknown[];
  let data: BrokerDialogData;
  let failure: ConnectError | undefined;
  /** Set to a pending promise to hold an RPC open (busy-state tests). */
  let gate: Promise<void> | undefined;

  beforeEach(() => {
    createRequests = [];
    renameRequests = [];
    closed = [];
    data = {};
    failure = undefined;
    gate = undefined;
    restoreApi = installFakeApi(({ service }) => {
      service(BrokerService, {
        createBroker: async (request) => {
          createRequests.push({ name: request.name });
          if (gate) await gate;
          if (failure) throw failure;
          return { brokerId: 4n };
        },
        renameBroker: async (request) => {
          renameRequests.push({ brokerId: request.brokerId, name: request.name });
          if (gate) await gate;
          if (failure) throw failure;
          return {};
        },
      });
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: MAT_DIALOG_DATA, useFactory: () => data },
        {
          provide: MatDialogRef,
          useValue: { close: (result?: unknown) => closed.push(result) },
        },
      ],
    });
  });

  afterEach(() => restoreApi());

  async function render() {
    const fixture = TestBed.createComponent(BrokerDialog);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function nameInput(fixture: ComponentFixture<BrokerDialog>): HTMLInputElement {
    const input = (fixture.nativeElement as HTMLElement).querySelector('input');
    if (!input) throw new Error('no name input rendered');
    return input;
  }

  /** Types like a user so ngModel fires and zoneless CD re-renders. */
  async function typeName(fixture: ComponentFixture<BrokerDialog>, text: string): Promise<void> {
    const input = nameInput(fixture);
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture);
  }

  function buttonByText(
    fixture: ComponentFixture<BrokerDialog>,
    text: string,
  ): HTMLButtonElement {
    const host = fixture.nativeElement as HTMLElement;
    const found = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent!.includes(text),
    );
    if (!found) throw new Error(`no ${text} button rendered`);
    return found;
  }

  it('opens in add mode with an empty name and a disabled Submit', async () => {
    const fixture = await render();
    expect(textOf(fixture)).toContain('Add New Broker');
    expect(textOf(fixture)).not.toContain('Edit Broker');
    expect(nameInput(fixture).value).toBe('');
    expect(buttonByText(fixture, 'Submit').disabled).toBe(true);
  });

  it('keeps Submit disabled for a whitespace-only name', async () => {
    const fixture = await render();
    await typeName(fixture, '   ');
    expect(buttonByText(fixture, 'Submit').disabled).toBe(true);
    expect(createRequests).toEqual([]);
  });

  it('creates the broker with a trimmed name, notifies, and closes with true', async () => {
    const fixture = await render();
    const success = vi.spyOn(TestBed.inject(Notify), 'success');
    await typeName(fixture, '  Fidelity  ');
    const submit = buttonByText(fixture, 'Submit');
    expect(submit.disabled).toBe(false);

    submit.click();
    await settle(fixture);

    expect(createRequests).toEqual([{ name: 'Fidelity' }]);
    expect(renameRequests).toEqual([]);
    expect(success).toHaveBeenCalledWith('Broker added');
    expect(closed).toEqual([true]);
  });

  it('opens in rename mode prefilled and renames the broker', async () => {
    data = { brokerId: 3n, name: 'Old Broker' };
    const fixture = await render();
    const success = vi.spyOn(TestBed.inject(Notify), 'success');
    expect(textOf(fixture)).toContain('Edit Broker');
    expect(nameInput(fixture).value).toBe('Old Broker');

    await typeName(fixture, ' Older Broker ');
    buttonByText(fixture, 'Submit').click();
    await settle(fixture);

    expect(renameRequests).toEqual([{ brokerId: 3n, name: 'Older Broker' }]);
    expect(createRequests).toEqual([]);
    expect(success).toHaveBeenCalledWith('Broker renamed');
    expect(closed).toEqual([true]);
  });

  it('disables Submit while the RPC is in flight', async () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const fixture = await render();
    await typeName(fixture, 'Fidelity');
    const submit = buttonByText(fixture, 'Submit');

    submit.click();
    await settle(fixture);
    expect(submit.disabled).toBe(true);
    expect(closed).toEqual([]);

    release();
    await settle(fixture);
    expect(closed).toEqual([true]);
  });

  it('keeps the dialog open and snackbars the server message on failure', async () => {
    const fixture = await render();
    const error = vi.spyOn(TestBed.inject(Notify), 'error');
    failure = new ConnectError('a broker named "Vanguard" already exists', Code.AlreadyExists);
    await typeName(fixture, 'Vanguard');

    buttonByText(fixture, 'Submit').click();
    await settle(fixture);

    expect(error).toHaveBeenCalledTimes(1);
    const err = error.mock.calls[0][0] as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.rawMessage).toBe('a broker named "Vanguard" already exists');
    expect(closed).toEqual([]); // the user keeps their typed name
    expect(nameInput(fixture).value).toBe('Vanguard');
    expect(buttonByText(fixture, 'Submit').disabled).toBe(false); // busy released
  });

  it('Cancel closes without calling the server', async () => {
    const fixture = await render();
    await typeName(fixture, 'Fidelity');
    buttonByText(fixture, 'Cancel').click();
    await settle(fixture);
    expect(createRequests).toEqual([]);
    expect(renameRequests).toEqual([]);
    // A falsy dialog result is what tells BrokersPage not to reload.
    expect(closed).toHaveLength(1);
    expect(closed[0]).toBeFalsy();
  });
});
