// Unit spec for AllocationPage + TargetDialog (docs/design/ui-testing.md,
// inventory "AllocationPage"). Fake AllocationService via installFakeApi;
// both chart facades are swapped for the same-selector stubs so the specs
// assert the DATA handed to them, never canvas pixels.
import { provideZonelessChangeDetection, type Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MatDialog, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { Router, provideRouter } from '@angular/router';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AllocationService,
  ClassAllocationSchema,
  ClassContributorSchema,
  GetAllocationResponseSchema,
  type ClassAllocation,
  type GetAllocationResponse,
  type SetTargetAllocationRequest,
} from '../../../proto-gen/allocation_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { GroupedBarChartStub, PieChartStub } from '../../../testing/chart-stubs';
import { fraction, money, quantity } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { GroupedBarChart } from '../../shared/charts/grouped-bar-chart';
import { PieChart } from '../../shared/charts/pie-chart';
import { AllocationPage } from './allocation-page';
import { TargetDialog, type TargetDialogData } from './target-dialog';

// The seeded portfolio's allocation (SampleSeeder.kt: classes in their
// seeded display order, target 10/40/20/20/10). Shared-infrastructure
// gap: sample-data.ts carries no allocation builder yet, so the fixture
// lives here.
function sampleClasses(): ClassAllocation[] {
  return [
    create(ClassAllocationSchema, {
      name: 'Cash',
      current: money('845.25', { display: '$845.25' }),
      currentFraction: fraction('0.0210', '2.1%'),
      target: money('4024.105', { display: '$4,024.105' }),
      targetFraction: fraction('0.1', '10%'),
      delta: money('3178.855', { display: '$3,178.855' }),
      contributors: [
        create(ClassContributorSchema, {
          // The synthetic sweeps contribution carries no security id.
          securityId: 0n,
          ticker: 'Sweeps',
          shares: quantity('0', '0'),
          classWeight: fraction('1', '100%'),
          contribution: money('845.25', { display: '$845.25' }),
        }),
      ],
    }),
    create(ClassAllocationSchema, {
      name: 'US Stock',
      current: money('9489.30', { display: '$9,489.30' }),
      currentFraction: fraction('0.2358', '23.58%'),
      target: money('16096.42', { display: '$16,096.42' }),
      targetFraction: fraction('0.4', '40%'),
      delta: money('6607.12', { display: '$6,607.12' }),
      contributors: [
        create(ClassContributorSchema, {
          securityId: 1n,
          ticker: 'VTI',
          shares: quantity('47', '47'),
          classWeight: fraction('1', '100%'),
          contribution: money('9489.30', { display: '$9,489.30' }),
        }),
      ],
    }),
    create(ClassAllocationSchema, {
      name: 'Non US Stock',
      current: money('12064.00', { display: '$12,064.00' }),
      currentFraction: fraction('0.2998', '29.98%'),
      target: money('8048.21', { display: '$8,048.21' }),
      targetFraction: fraction('0.2', '20%'),
      delta: money('-4015.79', { display: '($4,015.79)' }),
      contributors: [
        create(ClassContributorSchema, {
          securityId: 4n,
          ticker: 'EUFUND',
          shares: quantity('100', '100'),
          classWeight: fraction('1', '100%'),
          contribution: money('12064.00', { display: '$12,064.00' }),
        }),
      ],
    }),
    create(ClassAllocationSchema, {
      name: 'Bond',
      current: money('1050.00', { display: '$1,050.00' }),
      currentFraction: fraction('0.0261', '2.61%'),
      target: money('8048.21', { display: '$8,048.21' }),
      targetFraction: fraction('0.2', '20%'),
      delta: money('6998.21', { display: '$6,998.21' }),
      contributors: [
        create(ClassContributorSchema, {
          securityId: 2n,
          ticker: 'BONDX',
          shares: quantity('100', '100'),
          classWeight: fraction('1', '100%'),
          contribution: money('1050.00', { display: '$1,050.00' }),
        }),
      ],
    }),
    create(ClassAllocationSchema, {
      name: 'Other',
      current: money('16792.50', { display: '$16,792.50' }),
      currentFraction: fraction('0.4173', '41.73%'),
      target: money('4024.105', { display: '$4,024.105' }),
      targetFraction: fraction('0.1', '10%'),
      delta: money('-12768.395', { display: '($12,768.395)' }),
      contributors: [
        create(ClassContributorSchema, {
          securityId: 3n,
          ticker: 'GOLD',
          shares: quantity('5', '5'),
          classWeight: fraction('1', '100%'),
          contribution: money('16792.50', { display: '$16,792.50' }),
        }),
      ],
    }),
  ];
}

function sampleAllocation(): GetAllocationResponse {
  return create(GetAllocationResponseSchema, {
    classes: sampleClasses(),
    portfolioTotal: money('40241.05', { display: '$40,241.05' }),
    targetSet: true,
  });
}

/** The same portfolio before a target is stored: the server zeroes the
 *  target columns and says `targetSet = false` (spec sec. 5.4). */
function untargetedAllocation(): GetAllocationResponse {
  return create(GetAllocationResponseSchema, {
    classes: sampleClasses().map((c) =>
      create(ClassAllocationSchema, {
        name: c.name,
        current: c.current,
        currentFraction: c.currentFraction,
        target: money('0', { display: '$0.00' }),
        targetFraction: fraction('0', '0%'),
        delta: money('0', { display: '$0.00' }),
        contributors: c.contributors,
      }),
    ),
    portfolioTotal: money('40241.05', { display: '$40,241.05' }),
    targetSet: false,
  });
}

function emptyAllocation(): GetAllocationResponse {
  return create(GetAllocationResponseSchema, {
    classes: [],
    portfolioTotal: money('0', { display: '$0.00' }),
    targetSet: false,
  });
}

function cells(root: HTMLElement, rowSelector: string): string[][] {
  return Array.from(root.querySelectorAll(rowSelector), (row) =>
    Array.from(row.querySelectorAll('th,td'), (c) => c.textContent!.trim()),
  );
}

function round2(values: number[]): number[] {
  return values.map((v) => Number(v.toFixed(2)));
}

function buttonNamed(root: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll('button')).find((b) =>
    b.textContent!.includes(text),
  );
  if (!button) throw new Error(`no button matching ${text}`);
  return button;
}

describe('AllocationPage', () => {
  let restoreApi: () => void;
  let calls: number;
  let respond: () => GetAllocationResponse;

  beforeEach(() => {
    calls = 0;
    respond = () => sampleAllocation();
    restoreApi = installFakeApi(({ service }) => {
      service(AllocationService, {
        getAllocation: () => {
          calls += 1;
          return respond();
        },
      });
    });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    TestBed.overrideComponent(AllocationPage, {
      remove: { imports: [PieChart, GroupedBarChart] },
      add: { imports: [PieChartStub, GroupedBarChartStub] },
    });
  });

  afterEach(() => restoreApi());

  async function render(): Promise<ComponentFixture<AllocationPage>> {
    const fixture = TestBed.createComponent(AllocationPage);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  // By.directive matches host elements only; an `instanceof` predicate
  // also matches the stub's inner nodes, which report their owning
  // component and would double every hit.
  function stubs<T>(fixture: ComponentFixture<AllocationPage>, kind: Type<T>): T[] {
    return fixture.debugElement
      .queryAll(By.directive(kind))
      .map((el) => el.componentInstance as T);
  }

  const pies = (fixture: ComponentFixture<AllocationPage>) => stubs(fixture, PieChartStub);
  const bars = (fixture: ComponentFixture<AllocationPage>) => stubs(fixture, GroupedBarChartStub);

  it('loads once on construction and renders the class table with footer totals', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    expect(calls).toBe(1);
    expect(root.textContent).toContain('Asset Allocation');
    expect(root.textContent).toContain('Portfolio total: $40,241.05');
    expect(cells(root, 'tr[mat-header-row]')[0]).toEqual([
      'Asset Class', 'Total Holdings', 'Target Holdings', 'Delta', 'Percent', 'Target Percent',
    ]);
    const rows = cells(root, 'tr[mat-row]');
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r[0])).toEqual([
      'Cash', 'US Stock', 'Non US Stock', 'Bond', 'Other',
    ]);
    expect(rows[0]).toEqual(['Cash', '$845.25', '$4,024.105', '$3,178.855', '2.1%', '10%']);
    expect(rows[1]).toEqual([
      'US Stock', '$9,489.30', '$16,096.42', '$6,607.12', '23.58%', '40%',
    ]);
    expect(rows[2][3]).toBe('($4,015.79)'); // negative deltas render parenthesized
    // Only the holdings column carries a footer total.
    expect(cells(root, 'tr[mat-footer-row]')[0]).toEqual([
      'Total', '$40,241.05', '', '', '', '',
    ]);
  });

  it('links each class row to its details page', async () => {
    const fixture = await render();
    const links = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('td a'),
      (a) => a.getAttribute('href'),
    );
    expect(links).toEqual([
      '/allocation/class/Cash',
      '/allocation/class/US%20Stock',
      '/allocation/class/Non%20US%20Stock',
      '/allocation/class/Bond',
      '/allocation/class/Other',
    ]);
  });

  it('offers the rebalance planner in the card actions', async () => {
    const fixture = await render();
    const action = (fixture.nativeElement as HTMLElement).querySelector('mat-card-actions a')!;
    expect(action.getAttribute('href')).toBe('/allocation/rebalance');
    expect(action.textContent).toContain('Rebalance through Purchases');
  });

  it('hides the target prompt when a target is stored', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.target-prompt')).toHaveLength(0);
    expect(root.textContent).not.toContain('No target allocation is set yet.');
  });

  it('prompts to set a target when targetSet is false, still drawing the charts', async () => {
    respond = () => untargetedAllocation();
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.target-prompt')).toHaveLength(1);
    expect(root.textContent).toContain('No target allocation is set yet.');
    expect(buttonNamed(root, 'Set Target Allocation')).toBeTruthy();
    expect(root.querySelectorAll('.chart-grid .chart-cell')).toHaveLength(4);
    expect(cells(root, 'tr[mat-row]')).toHaveLength(5);
    // The target pie has nothing to draw when every target is zero.
    const [current, target] = pies(fixture);
    expect(current.slices()).toHaveLength(5);
    expect(target.slices()).toEqual([]);
  });

  it('hands each pie only its non-zero slices', async () => {
    respond = () =>
      create(GetAllocationResponseSchema, {
        classes: [
          ...sampleClasses().slice(0, 2),
          create(ClassAllocationSchema, {
            name: 'Bond',
            current: money('0', { display: '$0.00' }),
            currentFraction: fraction('0', '0%'),
            target: money('8048.21', { display: '$8,048.21' }),
            targetFraction: fraction('0.2', '20%'),
            delta: money('8048.21', { display: '$8,048.21' }),
          }),
        ],
        portfolioTotal: money('10334.55', { display: '$10,334.55' }),
        targetSet: true,
      });
    const fixture = await render();
    const [current, target] = pies(fixture);
    expect(current.title()).toBe('Current Allocation');
    expect(target.title()).toBe('Target Allocation');
    // Bond drops out of the current pie (zero holdings) but not the target.
    expect(current.slices().map((s) => s.name)).toEqual(['Cash', 'US Stock']);
    expect(target.slices().map((s) => s.name)).toEqual(['Cash', 'US Stock', 'Bond']);
    expect(current.slices()[1]).toEqual({
      id: 'US Stock',
      name: 'US Stock',
      value: 9489.3,
      display: '$9,489.30',
    });
    expect(target.slices()[2].display).toBe('$8,048.21');
  });

  it('hands the bar charts every class, percents scaled to 100', async () => {
    const fixture = await render();
    const [percent, delta] = bars(fixture);
    expect(percent.title()).toBe('Current vs Target (%)');
    expect(percent.categories()).toEqual(['Cash', 'US Stock', 'Non US Stock', 'Bond', 'Other']);
    expect(percent.series().map((s) => s.name)).toEqual(['Current %', 'Target %']);
    // sortKey x 100 is float arithmetic - the wire's display strings are
    // the exact view, so the bar values are compared at 2 decimals.
    expect(round2(percent.series()[0].values)).toEqual([2.1, 23.58, 29.98, 2.61, 41.73]);
    expect(percent.series()[0].displays).toEqual([
      '2.1%', '23.58%', '29.98%', '2.61%', '41.73%',
    ]);
    expect(round2(percent.series()[1].values)).toEqual([10, 40, 20, 20, 10]);

    expect(delta.title()).toBe('Asset Changes Required Without Investing');
    expect(delta.categories()).toEqual(['Cash', 'US Stock', 'Non US Stock', 'Bond', 'Other']);
    expect(delta.series()).toHaveLength(1);
    expect(delta.series()[0].values).toEqual([
      3178.855, 6607.12, -4015.79, 6998.21, -12768.395,
    ]);
    expect(delta.series()[0].displays[2]).toBe('($4,015.79)');
  });

  it('navigates to the class details page when a pie slice is clicked', async () => {
    const fixture = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    for (const pie of pies(fixture)) {
      pie.emitSliceClick({ id: 'Non US Stock', name: 'Non US Stock', value: 1, display: '' });
    }
    await settle(fixture);
    expect(navigate).toHaveBeenCalledTimes(2); // both pies open the class
    expect(navigate).toHaveBeenCalledWith(['/allocation/class', 'Non US Stock']);
  });

  it('renders an empty table and empty charts for an empty portfolio', async () => {
    respond = () => emptyAllocation();
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    expect(cells(root, 'tr[mat-row]')).toHaveLength(0);
    expect(root.textContent).toContain('Portfolio total: $0.00');
    expect(pies(fixture).every((p) => p.slices().length === 0)).toBe(true);
    expect(bars(fixture).every((b) => b.categories().length === 0)).toBe(true);
    // The page has no empty-state copy of its own - only the prompt.
    expect(root.textContent).toContain('No target allocation is set yet.');
  });

  it('routes an RPC failure to the error snackbar', async () => {
    respond = () => {
      throw new ConnectError('VTI has no price entries yet', Code.FailedPrecondition);
    };
    const notify = TestBed.inject(Notify);
    const errorSpy = vi.spyOn(notify, 'error');
    const fixture = await render();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const err = errorSpy.mock.calls[0][0] as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.rawMessage).toBe('VTI has no price entries yet');
    expect(cells(fixture.nativeElement as HTMLElement, 'tr[mat-row]')).toHaveLength(0);
  });

  describe('edit-target affordances', () => {
    // MatDialog is provided by MatDialogModule, so it resolves in the
    // component's own injector - TestBed.inject would hand back a
    // different instance whose spies never fire.
    function stubDialog(fixture: ComponentFixture<AllocationPage>, result: unknown) {
      const dialog = fixture.debugElement.injector.get(MatDialog);
      const opened: { component: unknown; data: TargetDialogData | undefined }[] = [];
      vi.spyOn(dialog, 'open').mockImplementation(((component: unknown, config?: unknown) => {
        opened.push({
          component,
          data: (config as { data?: TargetDialogData } | undefined)?.data,
        });
        return { afterClosed: () => of(result) };
      }) as never);
      return opened;
    }

    it('opens TargetDialog with the loaded classes and reloads when it saves', async () => {
      const fixture = await render();
      const opened = stubDialog(fixture, true);
      buttonNamed(fixture.nativeElement as HTMLElement, 'Edit Target Asset Allocation').click();
      await settle(fixture);
      expect(opened).toHaveLength(1);
      expect(opened[0].component).toBe(TargetDialog);
      expect(opened[0].data?.classes.map((c) => c.name)).toEqual([
        'Cash', 'US Stock', 'Non US Stock', 'Bond', 'Other',
      ]);
      expect(calls).toBe(2);
    });

    it('does not reload when the dialog is dismissed', async () => {
      const fixture = await render();
      const opened = stubDialog(fixture, undefined);
      buttonNamed(fixture.nativeElement as HTMLElement, 'Edit Target Asset Allocation').click();
      await settle(fixture);
      expect(opened).toHaveLength(1);
      expect(calls).toBe(1);
    });

    it('opens the same dialog from the missing-target prompt', async () => {
      respond = () => untargetedAllocation();
      const fixture = await render();
      const opened = stubDialog(fixture, false);
      buttonNamed(fixture.nativeElement as HTMLElement, 'Set Target Allocation').click();
      await settle(fixture);
      expect(opened).toHaveLength(1);
      expect(opened[0].component).toBe(TargetDialog);
      expect(calls).toBe(1); // `false` is not a save
    });
  });
});

describe('TargetDialog', () => {
  let restoreApi: () => void;
  let requests: SetTargetAllocationRequest[];
  let fail: string | null;
  let closed: unknown[];

  beforeEach(() => {
    requests = [];
    fail = null;
    closed = [];
    restoreApi = installFakeApi(({ service }) => {
      service(AllocationService, {
        setTargetAllocation: (request) => {
          requests.push(request);
          if (fail) throw new ConnectError(fail, Code.InvalidArgument);
          return {};
        },
      });
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: MAT_DIALOG_DATA, useValue: { classes: sampleClasses() } },
        {
          provide: MatDialogRef,
          useValue: { close: (result?: unknown) => closed.push(result) },
        },
      ],
    });
  });

  afterEach(() => restoreApi());

  async function render(data?: TargetDialogData): Promise<ComponentFixture<TargetDialog>> {
    if (data) TestBed.overrideProvider(MAT_DIALOG_DATA, { useValue: data });
    const fixture = TestBed.createComponent(TargetDialog);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function fieldFor(root: HTMLElement, label: string): HTMLInputElement {
    const field = Array.from(root.querySelectorAll('mat-form-field')).find(
      (f) => f.querySelector('mat-label')?.textContent?.trim() === label,
    );
    const input = field?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error(`no field labelled ${label}`);
    return input;
  }

  /** Types a percent the way a user does: a bare field assignment never
   *  re-renders under zoneless, and only (ngModelChange) revalidates. */
  async function type(
    fixture: ComponentFixture<TargetDialog>,
    label: string,
    value: string,
  ): Promise<void> {
    const input = fieldFor(fixture.nativeElement as HTMLElement, label);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture);
  }

  function errorText(root: HTMLElement): string | null {
    return root.querySelector('.validation-error')?.textContent?.trim() ?? null;
  }

  it('prefills one field per class from the stored target fractions', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Edit Target Asset Allocation');
    const labels = Array.from(root.querySelectorAll('mat-label'), (l) => l.textContent!.trim());
    expect(labels).toEqual(['Cash %', 'US Stock %', 'Non US Stock %', 'Bond %', 'Other %']);
    expect(labels.map((l) => fieldFor(root, l).value)).toEqual(['10', '40', '20', '20', '10']);
    expect(errorText(root)).toBeNull();
  });

  it('falls back to 0 for a class with no stored target', async () => {
    const fixture = await render({
      classes: [
        create(ClassAllocationSchema, { name: 'Cash' }),
        create(ClassAllocationSchema, { name: 'Bond', targetFraction: fraction('0.2', '20%') }),
      ],
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(fieldFor(root, 'Cash %').value).toBe('0');
    expect(fieldFor(root, 'Bond %').value).toBe('20');
  });

  it('reports a sum that misses 100 with the running total', async () => {
    const fixture = await render();
    await type(fixture, 'Other %', '0');
    const root = fixture.nativeElement as HTMLElement;
    expect(errorText(root)).toBe('Percents must sum to 100 (currently 90)');
    expect(buttonNamed(root, 'Submit').disabled).toBe(true);
    await type(fixture, 'Other %', '10.5');
    expect(errorText(root)).toBe('Percents must sum to 100 (currently 100.5)');
  });

  it('accepts a sum inside the one-hundredth tolerance', async () => {
    const fixture = await render();
    await type(fixture, 'Cash %', '9.99');
    const root = fixture.nativeElement as HTMLElement;
    expect(errorText(root)).toBeNull();
    expect(buttonNamed(root, 'Submit').disabled).toBe(false);
    await type(fixture, 'Cash %', '9.98');
    expect(errorText(root)).toBe('Percents must sum to 100 (currently 99.98)');
  });

  it('rejects non-numeric, over-precise, and out-of-range percents by class name', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    await type(fixture, 'Non US Stock %', 'twenty');
    expect(errorText(root)).toBe('Non US Stock: enter a number between 0 and 100');
    await type(fixture, 'Non US Stock %', '-5'); // negatives are not decimals here
    expect(errorText(root)).toBe('Non US Stock: enter a number between 0 and 100');
    await type(fixture, 'Non US Stock %', '20.001');
    expect(errorText(root)).toBe('Non US Stock: at most two decimal places');
    await type(fixture, 'Non US Stock %', '101');
    expect(errorText(root)).toBe('Non US Stock: must be between 0 and 100');
    await type(fixture, 'Non US Stock %', '20');
    expect(errorText(root)).toBeNull();
  });

  it('tolerates surrounding whitespace', async () => {
    const fixture = await render();
    await type(fixture, 'Bond %', ' 20 ');
    expect(errorText(fixture.nativeElement as HTMLElement)).toBeNull();
  });

  it('sends percents to the wire as fractions and closes with true', async () => {
    const fixture = await render();
    await type(fixture, 'Cash %', '2.5');
    await type(fixture, 'Bond %', '27.5');
    const success = vi.spyOn(TestBed.inject(Notify), 'success');
    buttonNamed(fixture.nativeElement as HTMLElement, 'Submit').click();
    await settle(fixture);
    expect(requests).toHaveLength(1);
    expect(requests[0].entries.map((e) => [e.assetClass, e.fraction?.value])).toEqual([
      ['Cash', '0.025'],
      ['US Stock', '0.4'],
      ['Non US Stock', '0.2'],
      ['Bond', '0.275'],
      ['Other', '0.1'],
    ]);
    expect(success).toHaveBeenCalledWith('Target allocation saved');
    expect(closed).toEqual([true]);
  });

  it('keeps every class in the payload, zero rows included', async () => {
    const fixture = await render();
    await type(fixture, 'Other %', '0');
    await type(fixture, 'Cash %', '20');
    buttonNamed(fixture.nativeElement as HTMLElement, 'Submit').click();
    await settle(fixture);
    expect(requests).toHaveLength(1);
    expect(requests[0].entries).toHaveLength(5);
    expect(requests[0].entries[4].assetClass).toBe('Other');
    expect(requests[0].entries[4].fraction?.value).toBe('0');
  });

  it('re-validates on Submit even when the prefill was never touched', async () => {
    // BUG: validate() runs only from (ngModelChange), so a dialog opened
    // on a target that does not sum to 100 shows an enabled Submit and
    // no message until the click. submit() re-validates, so nothing
    // invalid reaches the server - the pinned behavior is the late
    // feedback, not a bad write.
    const fixture = await render({
      classes: [
        create(ClassAllocationSchema, { name: 'Cash', targetFraction: fraction('0.5', '50%') }),
        create(ClassAllocationSchema, { name: 'Bond', targetFraction: fraction('0.2', '20%') }),
      ],
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(errorText(root)).toBeNull();
    expect(buttonNamed(root, 'Submit').disabled).toBe(false);
    buttonNamed(root, 'Submit').click();
    await settle(fixture);
    expect(requests).toHaveLength(0);
    expect(errorText(root)).toBe('Percents must sum to 100 (currently 70)');
    expect(buttonNamed(root, 'Submit').disabled).toBe(true);
    expect(closed).toEqual([]);
  });

  it('keeps the dialog open and surfaces the error when the server rejects', async () => {
    fail = 'target fractions sum to 0.9900; they must sum to 1 (+/-0.0001)';
    const fixture = await render();
    const errorSpy = vi.spyOn(TestBed.inject(Notify), 'error');
    buttonNamed(fixture.nativeElement as HTMLElement, 'Submit').click();
    await settle(fixture);
    expect(requests).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0][0] as ConnectError).rawMessage).toBe(fail);
    expect(closed).toEqual([]);
    // busy() is cleared in `finally`, so the user can retry.
    expect(fixture.componentInstance.busy()).toBe(false);
    expect(buttonNamed(fixture.nativeElement as HTMLElement, 'Submit').disabled).toBe(false);
  });

  it('closes without saving on Cancel', async () => {
    const fixture = await render();
    buttonNamed(fixture.nativeElement as HTMLElement, 'Cancel').click();
    await settle(fixture);
    expect(requests).toHaveLength(0);
    // mat-dialog-close with no value closes with the empty string.
    expect(closed).toEqual(['']);
  });
});
