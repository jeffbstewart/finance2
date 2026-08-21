// Unit spec for SecurityDetailsPage's header + Price History tab
// (docs/design/ui-testing.md, inventory "SecurityDetailsPage").
// The Asset Allocation editor and the MTM ledger are separate
// assignments — they are only stubbed/faked far enough that the tab
// group renders. The clock is pinned because the duration filter is
// computed client-side from `new Date()`.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router, provideRouter } from '@angular/router';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BollingerPointSchema,
  ClassificationSetSchema,
  GetSecurityDetailsResponseSchema,
  IndicatorPointSchema,
  ListMtmMarksResponseSchema,
  PricePointSchema,
  PricingLocus,
  SecurityProfileSchema,
  SecurityService,
  SecurityType,
  TaxTreatment,
  TechnicalIndicatorsSchema,
  type GetSecurityDetailsRequest,
  type GetSecurityDetailsResponse,
  type SecurityProfile,
} from '../../../proto-gen/securities_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { PieChartStub, TimeSeriesChartStub } from '../../../testing/chart-stubs';
import { civil, decimal, fraction, money } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { PieChart } from '../../shared/charts/pie-chart';
import { TimeSeriesChart } from '../../shared/charts/time-series-chart';
import { ClassificationEditor } from './classification-editor';
import { ProfileDialog } from './profile-dialog';
import { SecurityDetailsPage } from './security-details-page';

// The pinned "today". Duration cutoffs: 1 Year → 2025-08-20,
// 1 Quarter → 2026-05-20, 1 Month → 2026-07-20.
const TODAY = new Date(2026, 7, 20);

/** Four adjusted closes straddling every duration cutoff above.
 *  Shared-infrastructure gap: sample-data.ts has no security-details
 *  builder, so the seeder's VTI profile is mirrored here. */
const CLOSES: [string, string][] = [
  ['2025-06-01', '180.00'],
  ['2026-05-20', '190.00'],
  ['2026-07-25', '200.10'],
  ['2026-08-19', '201.90'],
];

function vtiProfile(
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
    classifications: [
      create(ClassificationSetSchema, {
        kind: 'ASSET_CLASS',
        asOf: civil('2026-07-21'),
        weights: { 'US Stock': fraction('1', '100%') },
      }),
    ],
    ...overrides,
  });
}

function detailsFor(
  security: SecurityProfile,
  closes: [string, string][] = CLOSES,
): GetSecurityDetailsResponse {
  return create(GetSecurityDetailsResponseSchema, {
    security,
    priceHistory: closes.map(([iso, close]) =>
      create(PricePointSchema, {
        date: civil(iso),
        close: decimal(close),
        adjustedClose: decimal(close),
      }),
    ),
    indicators: create(TechnicalIndicatorsSchema, {
      sma: closes.map(([iso, close]) =>
        create(IndicatorPointSchema, { date: civil(iso), value: decimal(close) }),
      ),
      ema: closes.map(([iso, close]) =>
        create(IndicatorPointSchema, { date: civil(iso), value: decimal(close) }),
      ),
      bollinger: closes.map(([iso, close]) =>
        create(BollingerPointSchema, {
          date: civil(iso),
          mean: decimal(close),
          upper: decimal(`${Number(close) + 2}`),
          lower: decimal(`${Number(close) - 2}`),
        }),
      ),
    }),
  });
}

describe('SecurityDetailsPage', () => {
  let restoreApi: () => void;
  let requests: { securityId: bigint; inflationAdjusted: boolean }[];
  let respond: (request: GetSecurityDetailsRequest) => GetSecurityDetailsResponse;

  beforeEach(() => {
    // Only Date is faked: settle() relies on real setTimeout.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TODAY);
    requests = [];
    respond = () => detailsFor(vtiProfile());
    restoreApi = installFakeApi(({ service }) => {
      service(SecurityService, {
        getSecurityDetails: (request) => {
          requests.push({
            securityId: request.securityId,
            inflationAdjusted: request.inflationAdjusted,
          });
          return respond(request);
        },
        // The MTM tab's ledger belongs to another assignment; it is
        // faked only so the child does not reject loudly.
        listMtmMarks: () =>
          create(ListMtmMarksResponseSchema, {
            acquisitionCostUsd: money('9911.00', { display: '$9,911.00' }),
          }),
      });
    });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    TestBed.overrideComponent(SecurityDetailsPage, {
      remove: { imports: [TimeSeriesChart] },
      add: { imports: [TimeSeriesChartStub] },
    });
    // The eagerly-instantiated Asset Allocation tab draws a pie.
    TestBed.overrideComponent(ClassificationEditor, {
      remove: { imports: [PieChart] },
      add: { imports: [PieChartStub] },
    });
  });

  afterEach(() => {
    restoreApi();
    vi.useRealTimers();
  });

  async function render(inputs: { id?: string; tab?: string } = {}) {
    const fixture = TestBed.createComponent(SecurityDetailsPage);
    fixture.componentRef.setInput('id', inputs.id ?? '1');
    if (inputs.tab !== undefined) fixture.componentRef.setInput('tab', inputs.tab);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  /** The fixture's root element, typed (fixture.nativeElement is any). */
  function host(fixture: { nativeElement: unknown }): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function textOf(fixture: { nativeElement: unknown }): string {
    return host(fixture).textContent!;
  }

  function chart(fixture: {
    debugElement: { query(fn: (el: { componentInstance: unknown }) => boolean): unknown };
  }): TimeSeriesChartStub | undefined {
    const found = fixture.debugElement.query(
      (el) => el.componentInstance instanceof TimeSeriesChartStub,
    ) as { componentInstance: TimeSeriesChartStub } | null;
    return found?.componentInstance;
  }

  function tabLabels(fixture: { nativeElement: unknown }): string[] {
    return Array.from(host(fixture).querySelectorAll('[role="tab"]'), (t) =>
      t.textContent!.trim(),
    );
  }

  function selectedTab(fixture: { nativeElement: unknown }): string {
    const tab = host(fixture).querySelector('[role="tab"][aria-selected="true"]');
    return tab?.textContent?.trim() ?? '';
  }

  it('requests the routed security unadjusted and renders the header', async () => {
    const fixture = await render({ id: '7' });
    expect(requests).toEqual([{ securityId: 7n, inflationAdjusted: false }]);
    const text = textOf(fixture);
    expect(text).toContain('VTI: Total Market ETF');
    expect(text).toContain('Publicly Traded');
    expect(text).toContain('ETF');
    expect(text).toContain('USD');
    expect(text).toContain('Net Expense Ratio: 0.03%');
    expect(text).not.toContain('(hidden)');
  });

  it('keeps the card empty until the details land', async () => {
    let release!: (r: GetSecurityDetailsResponse) => void;
    respond = () => new Promise<GetSecurityDetailsResponse>((r) => (release = r)) as never;
    const fixture = await render();
    expect(host(fixture).querySelector('mat-card-header')).toBeNull();
    expect(tabLabels(fixture)).toEqual([]);
    release(detailsFor(vtiProfile()));
    await settle(fixture);
    expect(host(fixture).querySelector('mat-card-header')).not.toBeNull();
    expect(tabLabels(fixture)).toEqual(['Price History', 'Asset Allocation']);
  });

  it('falls back to placeholder text for a blank description and no ratio', async () => {
    respond = () =>
      detailsFor(
        vtiProfile({ description: '', netExpenseRatio: undefined, hidden: true }),
      );
    const fixture = await render();
    const text = textOf(fixture);
    expect(text).toContain('VTI: (no description yet)');
    expect(text).toContain('Net Expense Ratio: —');
    expect(text).toContain('(hidden)');
  });

  it('labels a MANUAL security privately traded and offers the price editor', async () => {
    respond = () =>
      detailsFor(
        vtiProfile({
          securityId: 3n,
          ticker: 'GOLD',
          description: 'Gold coins in a vault',
          securityType: SecurityType.PRIVATE_INVESTMENT,
          pricingLocus: PricingLocus.MANUAL,
        }),
      );
    const fixture = await render({ id: '3' });
    expect(textOf(fixture)).toContain('Privately Traded');
    expect(textOf(fixture)).toContain('Private Investment');
    const link = host(fixture).querySelector<HTMLAnchorElement>('a[href]');
    expect(link?.textContent).toContain('Edit price history');
    expect(link?.getAttribute('href')).toBe('/securities/3/prices');
  });

  it('hides the price editor link for a MARKET security', async () => {
    const fixture = await render();
    expect(textOf(fixture)).not.toContain('Edit price history');
    expect(host(fixture).querySelector('a[href]')).toBeNull();
  });

  it('renders an Unknown type label for an unspecified security type', async () => {
    respond = () =>
      detailsFor(vtiProfile({ securityType: SecurityType.SECURITY_TYPE_UNSPECIFIED }));
    const fixture = await render();
    expect(textOf(fixture)).toContain('Publicly Traded · Unknown · USD');
  });

  it('hands the chart facade one adjusted-close series by default', async () => {
    const fixture = await render();
    const series = chart(fixture)!.series();
    expect(series).toHaveLength(1);
    expect(series[0].name).toBe('Adjusted Close');
    expect(series[0].points).toEqual([
      { date: '2025-06-01', value: 180 },
      { date: '2026-05-20', value: 190 },
      { date: '2026-07-25', value: 200.1 },
      { date: '2026-08-19', value: 201.9 },
    ]);
  });

  it('adds one dashed series for SMA and for EMA', async () => {
    const fixture = await render();
    const page = fixture.componentInstance;
    page.indicator.set('sma');
    await settle(fixture);
    let series = chart(fixture)!.series();
    expect(series.map((s) => s.name)).toEqual(['Adjusted Close', 'SMA (20)']);
    expect(series[1].dashed).toBe(true);
    expect(series[1].points).toHaveLength(4);

    page.indicator.set('ema');
    await settle(fixture);
    series = chart(fixture)!.series();
    expect(series.map((s) => s.name)).toEqual(['Adjusted Close', 'EMA (20)']);

    page.indicator.set('none');
    await settle(fixture);
    expect(chart(fixture)!.series()).toHaveLength(1);
  });

  it('adds three dashed series for Bollinger bands', async () => {
    const fixture = await render();
    fixture.componentInstance.indicator.set('bollinger');
    await settle(fixture);
    const series = chart(fixture)!.series();
    expect(series.map((s) => s.name)).toEqual([
      'Adjusted Close',
      'Bollinger Mean',
      'Bollinger Upper',
      'Bollinger Lower',
    ]);
    expect(series.slice(1).every((s) => s.dashed)).toBe(true);
    expect(series[2].points[3]).toEqual({ date: '2026-08-19', value: 203.9 });
    expect(series[3].points[3]).toEqual({ date: '2026-08-19', value: 199.9 });
  });

  it('filters the series client-side by duration without refetching', async () => {
    const fixture = await render();
    const page = fixture.componentInstance;
    page.indicator.set('sma');

    page.duration.set('year'); // cutoff 2025-08-20
    await settle(fixture);
    expect(chart(fixture)!.series()[0].points.map((p) => p.date)).toEqual([
      '2026-05-20',
      '2026-07-25',
      '2026-08-19',
    ]);

    page.duration.set('quarter'); // cutoff 2026-05-20, inclusive
    await settle(fixture);
    expect(chart(fixture)!.series()[0].points.map((p) => p.date)).toEqual([
      '2026-05-20',
      '2026-07-25',
      '2026-08-19',
    ]);

    page.duration.set('month'); // cutoff 2026-07-20
    await settle(fixture);
    const series = chart(fixture)!.series();
    expect(series[0].points.map((p) => p.date)).toEqual(['2026-07-25', '2026-08-19']);
    // The indicator overlay is cut to the same window.
    expect(series[1].points.map((p) => p.date)).toEqual(['2026-07-25', '2026-08-19']);

    page.duration.set('all');
    await settle(fixture);
    expect(chart(fixture)!.series()[0].points).toHaveLength(4);
    expect(requests).toHaveLength(1); // the filter never touches the server
  });

  // BUG: the "1 Month" cutoff is `Date.setMonth(month - 1)`, which
  // overflows on long months — on 2026-03-31 it lands on 2026-03-03
  // (Feb 31), so the window is 28 days instead of one month.
  it('pins the month-overflow cutoff on the 31st', async () => {
    vi.setSystemTime(new Date(2026, 2, 31));
    respond = () =>
      detailsFor(vtiProfile(), [
        ['2026-02-28', '180.00'],
        ['2026-03-02', '181.00'],
        ['2026-03-04', '182.00'],
      ]);
    const fixture = await render();
    fixture.componentInstance.duration.set('month');
    await settle(fixture);
    expect(chart(fixture)!.series()[0].points.map((p) => p.date)).toEqual(['2026-03-04']);
  });

  it('refetches inflation-adjusted prices when the toggle flips', async () => {
    const fixture = await render();
    fixture.componentInstance.toggleInflation(true);
    await settle(fixture);
    expect(requests).toEqual([
      { securityId: 1n, inflationAdjusted: false },
      { securityId: 1n, inflationAdjusted: true },
    ]);
    fixture.componentInstance.toggleInflation(false);
    await settle(fixture);
    expect(requests).toHaveLength(3);
    expect(requests[2].inflationAdjusted).toBe(false);
  });

  it('explains an empty MARKET history as provider-sourced', async () => {
    respond = () => detailsFor(vtiProfile(), []);
    const fixture = await render();
    expect(chart(fixture)).toBeUndefined();
    const note = host(fixture).querySelector('p.empty-note')!;
    expect(note.textContent).toContain('No price history yet.');
    expect(note.textContent).toContain('Prices arrive from the market data provider on first use.');
  });

  it('points an empty MANUAL history at the price editor', async () => {
    respond = () => detailsFor(vtiProfile({ pricingLocus: PricingLocus.MANUAL }), []);
    const fixture = await render();
    const note = host(fixture).querySelector('p.empty-note')!;
    expect(note.textContent).toContain('Add dates and prices with the editor above.');
  });

  // BUG: the empty-history note keys off the *filtered* series, so a
  // duration filter that excludes every point claims the security has
  // no price history at all.
  it('shows the empty-history note when the duration filter empties the chart', async () => {
    respond = () => detailsFor(vtiProfile(), [['2025-06-01', '180.00']]);
    const fixture = await render();
    expect(chart(fixture)).toBeDefined();
    fixture.componentInstance.duration.set('month');
    await settle(fixture);
    expect(chart(fixture)).toBeUndefined();
    expect(host(fixture).querySelector('p.empty-note')!.textContent).toContain(
      'No price history yet.',
    );
  });

  it('shows the Mark to Market tab only for MARK_TO_MARKET securities', async () => {
    const fixture = await render();
    expect(tabLabels(fixture)).toEqual(['Price History', 'Asset Allocation']);

    respond = () =>
      detailsFor(
        vtiProfile({
          securityId: 4n,
          ticker: 'EUFUND',
          currencyCode: 'EUR',
          taxTreatment: TaxTreatment.MARK_TO_MARKET,
          pricingLocus: PricingLocus.MANUAL,
        }),
      );
    const mtm = await render({ id: '4' });
    expect(tabLabels(mtm)).toEqual(['Price History', 'Asset Allocation', 'Mark to Market']);
  });

  it('selects the tab named by the query param', async () => {
    const fixture = await render({ tab: '1' });
    expect(selectedTab(fixture)).toBe('Asset Allocation');
  });

  it('writes the picked tab back to the query param, replacing history', async () => {
    const fixture = await render();
    expect(selectedTab(fixture)).toBe('Price History');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.componentInstance.selectTab(1);
    expect(navigate).toHaveBeenCalledWith([], { queryParams: { tab: 1 }, replaceUrl: true });
  });

  it('opens the profile dialog with the loaded security and reloads on a change', async () => {
    const fixture = await render();
    // MatDialog is provided by MatDialogModule, which the standalone
    // page imports — so it lives in the component's injector, not the
    // TestBed root.
    const dialog = fixture.debugElement.injector.get(MatDialog);
    const open = vi
      .spyOn(dialog, 'open')
      .mockReturnValue({ afterClosed: () => of(true) } as never);

    const editButton = host(fixture).querySelector<HTMLButtonElement>(
      'button[aria-label="Edit profile"]',
    )!;
    editButton.click();
    await settle(fixture);

    expect(open).toHaveBeenCalledTimes(1);
    const [component, config] = open.mock.calls[0];
    expect(component).toBe(ProfileDialog);
    expect((config as { data: { security: SecurityProfile } }).data.security.ticker).toBe('VTI');
    expect(requests).toHaveLength(2); // dialog reported a change → reload
  });

  it('does not reload when the profile dialog is dismissed', async () => {
    const fixture = await render();
    const open = vi
      .spyOn(fixture.debugElement.injector.get(MatDialog), 'open')
      .mockReturnValue({ afterClosed: () => of(undefined) } as never);
    host(fixture).querySelector<HTMLButtonElement>('button[aria-label="Edit profile"]')!.click();
    await settle(fixture);
    expect(open).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it('routes a details failure to the error snackbar and renders nothing', async () => {
    const notify = TestBed.inject(Notify);
    const errorSpy = vi.spyOn(notify, 'error');
    respond = () => {
      throw new ConnectError('no security 99', Code.NotFound);
    };
    const fixture = await render({ id: '99' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0][0] as ConnectError).rawMessage).toBe('no security 99');
    expect(host(fixture).querySelector('mat-card-header')).toBeNull();
  });
});
