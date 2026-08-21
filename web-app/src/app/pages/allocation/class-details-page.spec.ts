// Unit spec for ClassDetailsPage (docs/design/ui-testing.md, inventory
// "ClassDetailsPage"). The page re-fetches the whole allocation and
// picks its class out by name, so the specs drive the required router
// input and assert what survives the lookup.
import { provideZonelessChangeDetection, type Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AllocationService,
  ClassAllocationSchema,
  ClassContributorSchema,
  GetAllocationResponseSchema,
  type GetAllocationResponse,
} from '../../../proto-gen/allocation_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { PieChartStub } from '../../../testing/chart-stubs';
import { fraction, money, quantity } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { PieChart } from '../../shared/charts/pie-chart';
import { ClassDetailsPage } from './class-details-page';

// Mirrors SampleSeeder.kt: Cash holds only the synthetic Sweeps entry,
// US Stock is VTI alone, and Non US Stock splits across two funds so the
// contributor pie has more than one slice. Shared-infrastructure gap:
// sample-data.ts has no allocation builder yet.
function sampleAllocation(): GetAllocationResponse {
  return create(GetAllocationResponseSchema, {
    classes: [
      create(ClassAllocationSchema, {
        name: 'Cash',
        current: money('845.25', { display: '$845.25' }),
        currentFraction: fraction('0.0210', '2.1%'),
        contributors: [
          create(ClassContributorSchema, {
            securityId: 0n, // the synthetic sweeps entry has no security
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
        current: money('12664.00', { display: '$12,664.00' }),
        currentFraction: fraction('0.3147', '31.47%'),
        contributors: [
          create(ClassContributorSchema, {
            securityId: 4n,
            ticker: 'EUFUND',
            shares: quantity('100', '100'),
            classWeight: fraction('1', '100%'),
            contribution: money('12064.00', { display: '$12,064.00' }),
          }),
          create(ClassContributorSchema, {
            securityId: 6n,
            ticker: 'BLEND',
            shares: quantity('10', '10'),
            classWeight: fraction('0.3', '30%'),
            contribution: money('600.00', { display: '$600.00' }),
          }),
        ],
      }),
      create(ClassAllocationSchema, {
        name: 'Bond',
        current: money('0', { display: '$0.00' }),
        currentFraction: fraction('0', '0%'),
      }),
    ],
    portfolioTotal: money('40241.05', { display: '$40,241.05' }),
    targetSet: true,
  });
}

function cells(root: HTMLElement, rowSelector: string): string[][] {
  return Array.from(root.querySelectorAll(rowSelector), (row) =>
    Array.from(row.querySelectorAll('th,td'), (c) => c.textContent!.trim()),
  );
}

describe('ClassDetailsPage', () => {
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
    TestBed.overrideComponent(ClassDetailsPage, {
      remove: { imports: [PieChart] },
      add: { imports: [PieChartStub] },
    });
  });

  afterEach(() => restoreApi());

  /** The router binds `name` as a component input, so specs set it
   *  before the first detectChanges — ngOnInit reads it. */
  async function render(name: string): Promise<ComponentFixture<ClassDetailsPage>> {
    const fixture = TestBed.createComponent(ClassDetailsPage);
    fixture.componentRef.setInput('name', name);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function stubs<T>(fixture: ComponentFixture<ClassDetailsPage>, kind: Type<T>): T[] {
    return fixture.debugElement.queryAll(By.directive(kind)).map((el) => el.componentInstance as T);
  }

  it('titles the card with the class and shows its share of the portfolio', async () => {
    const fixture = await render('US Stock');
    const root = fixture.nativeElement as HTMLElement;
    expect(calls).toBe(1);
    expect(root.querySelector('mat-card-title')!.textContent!.trim()).toBe(
      'Positions in US Stock',
    );
    expect(root.querySelector('mat-card-subtitle')!.textContent!.trim()).toBe(
      '$9,489.30 of the portfolio',
    );
  });

  it('renders the contributors table with class-scoped headers', async () => {
    const fixture = await render('Non US Stock');
    const root = fixture.nativeElement as HTMLElement;
    expect(cells(root, 'tr[mat-header-row]')[0]).toEqual([
      'Ticker', 'Shares', 'Weight in Non US Stock', 'Contribution to Non US Stock',
    ]);
    expect(cells(root, 'tr[mat-row]')).toEqual([
      ['EUFUND', '100', '100%', '$12,064.00'],
      ['BLEND', '10', '30%', '$600.00'],
    ]);
    // No footer row on this table.
    expect(root.querySelectorAll('tr[mat-footer-row]')).toHaveLength(0);
  });

  it('links each ticker to its security details page', async () => {
    const fixture = await render('Non US Stock');
    const links = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('td a'),
      (a) => a.getAttribute('href'),
    );
    expect(links).toEqual(['/securities/4', '/securities/6']);
  });

  it('hands the pie one slice per contributor, keyed by security id', async () => {
    const fixture = await render('Non US Stock');
    const [pie] = stubs(fixture, PieChartStub);
    expect(pie.title()).toBe('Contributions to Non US Stock');
    expect(pie.slices()).toEqual([
      { id: '4', name: 'EUFUND', value: 12064, display: '$12,064.00' },
      { id: '6', name: 'BLEND', value: 600, display: '$600.00' },
    ]);
  });

  it('navigates to the security when a slice is clicked', async () => {
    const fixture = await render('Non US Stock');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    stubs(fixture, PieChartStub)[0].emitSliceClick({
      id: '4',
      name: 'EUFUND',
      value: 12064,
      display: '$12,064.00',
    });
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith(['/securities', '4']);
  });

  it('shows the synthetic sweeps row for the Cash class', async () => {
    const fixture = await render('Cash');
    const root = fixture.nativeElement as HTMLElement;
    expect(cells(root, 'tr[mat-row]')).toEqual([['Sweeps', '0', '100%', '$845.25']]);
    // BUG: the sweeps contribution carries no security, so the ticker
    // cell links to /securities/0 and the pie slice's id is "0" — a
    // dead link into the security details page. Pinned as-is.
    expect(root.querySelector('td a')!.getAttribute('href')).toBe('/securities/0');
    expect(stubs(fixture, PieChartStub)[0].slices()[0].id).toBe('0');
  });

  it('shows the empty note and no pie for a class nothing contributes to', async () => {
    const fixture = await render('Bond');
    const root = fixture.nativeElement as HTMLElement;
    expect(cells(root, 'tr[mat-row]')).toHaveLength(0);
    expect(root.querySelector('.empty-note')!.textContent!.trim()).toBe(
      'Nothing contributes to Bond yet.',
    );
    expect(stubs(fixture, PieChartStub)).toHaveLength(0);
    expect(root.querySelector('mat-card-subtitle')!.textContent!.trim()).toBe(
      '$0.00 of the portfolio',
    );
  });

  it('degrades to the empty note when the class name matches nothing', async () => {
    const fixture = await render('Commodities');
    const root = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.allocation()).toBeUndefined();
    expect(cells(root, 'tr[mat-row]')).toHaveLength(0);
    expect(root.querySelector('.empty-note')!.textContent!.trim()).toBe(
      'Nothing contributes to Commodities yet.',
    );
    expect(root.querySelector('mat-card-subtitle')!.textContent!.trim()).toBe(
      'of the portfolio',
    );
  });

  it('matches the class name exactly, including its spaces', async () => {
    const fixture = await render('non us stock');
    expect(fixture.componentInstance.allocation()).toBeUndefined();
  });

  it('routes an RPC failure to the error snackbar', async () => {
    respond = () => {
      throw new ConnectError('GOLD has no price entries yet', Code.FailedPrecondition);
    };
    const errorSpy = vi.spyOn(TestBed.inject(Notify), 'error');
    const fixture = await render('US Stock');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0][0] as ConnectError).rawMessage).toBe(
      'GOLD has no price entries yet',
    );
    expect(cells(fixture.nativeElement as HTMLElement, 'tr[mat-row]')).toHaveLength(0);
    expect((fixture.nativeElement as HTMLElement).querySelector('.empty-note')).toBeTruthy();
  });

  it('re-reads the allocation on an explicit reload', async () => {
    const fixture = await render('US Stock');
    await fixture.componentInstance.reload();
    await settle(fixture);
    expect(calls).toBe(2);
    expect(cells(fixture.nativeElement as HTMLElement, 'tr[mat-row]')).toEqual([
      ['VTI', '47', '100%', '$9,489.30'],
    ]);
  });
});
