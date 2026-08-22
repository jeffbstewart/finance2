import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTabsModule } from '@angular/material/tabs';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  PricingLocus,
  SecurityType,
  TaxTreatment,
  type GetSecurityDetailsResponse,
  type SecurityProfile,
} from '../../../proto-gen/securities_pb';
import { api } from '../../core/api';
import { isoDate } from '../../core/dates';
import { Notify } from '../../core/notify';
import { TimeSeriesChart, type TimeSeries } from '../../shared/charts/time-series-chart';
import { ClassificationEditor } from './classification-editor';
import { MtmMarks } from './mtm-marks';
import { ProfileDialog } from './profile-dialog';

type Indicator = 'none' | 'bollinger' | 'sma' | 'ema';
type Duration = 'all' | 'year' | 'quarter' | 'month';

const SECURITY_TYPE_LABELS: Record<SecurityType, string> = {
  [SecurityType.SECURITY_TYPE_UNSPECIFIED]: 'Unknown',
  [SecurityType.STOCK]: 'Stock',
  [SecurityType.ETF]: 'ETF',
  [SecurityType.MUTUAL_FUND]: 'Mutual Fund',
  [SecurityType.PRIVATE_INVESTMENT]: 'Private Investment',
  [SecurityType.COLLECTIVE_TRUST]: 'Collective Trust',
};

/**
 * Security details (spec sec. 9.10, launch scope build-scope sec. 4): header
 * with profile edit, a Price History tab (indicators, duration filter,
 * inflation toggle - the toggle legacy designed but never wired), and
 * an Asset Allocation tab with the date-stamped classification editor.
 * The selected tab rides the `tab` query param so the URL reloads to
 * the same view (sec. 8.2).
 */
@Component({
  selector: 'app-security-details-page',
  imports: [
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatTabsModule,
    RouterLink,
    TimeSeriesChart,
    ClassificationEditor,
    MtmMarks,
  ],
  templateUrl: './security-details-page.html',
  styleUrl: './securities-page.scss',
})
export class SecurityDetailsPage {
  /** Router param (withComponentInputBinding). */
  readonly id = input.required<string>();
  /** Selected tab index from the `tab` query param. */
  readonly tab = input('0');

  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);

  readonly details = signal<GetSecurityDetailsResponse | undefined>(undefined);
  readonly inflationAdjusted = signal(false);
  readonly indicator = signal<Indicator>('none');
  readonly duration = signal<Duration>('all');

  readonly security = computed<SecurityProfile | undefined>(() => this.details()?.security);
  readonly manualPricing = computed(
    () => this.security()?.pricingLocus === PricingLocus.MANUAL,
  );

  readonly markToMarket = computed(
    () => this.security()?.taxTreatment === TaxTreatment.MARK_TO_MARKET,
  );

  readonly typeLabel = computed(() => {
    const s = this.security();
    return s ? SECURITY_TYPE_LABELS[s.securityType] : '';
  });

  readonly tradedLabel = computed(() =>
    this.manualPricing() ? 'Privately Traded' : 'Publicly Traded',
  );

  /** Duration filter is client-side (spec sec. 9.10): cutoff in ISO form. */
  private readonly cutoff = computed<string>(() => {
    const duration = this.duration();
    if (duration === 'all') return '';
    const d = new Date();
    if (duration === 'year') d.setFullYear(d.getFullYear() - 1);
    if (duration === 'quarter') d.setMonth(d.getMonth() - 3);
    if (duration === 'month') d.setMonth(d.getMonth() - 1);
    return isoDate({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
  });

  readonly chartSeries = computed<TimeSeries[]>(() => {
    const details = this.details();
    if (!details) return [];
    const cutoff = this.cutoff();
    const inRange = (date?: { year: number; month: number; day: number }) =>
      !!date && (!cutoff || isoDate(date) >= cutoff);
    const mirrored = details.mirrorPriceHistory.length > 0;
    const series: TimeSeries[] = [
      {
        name: 'Adjusted Close',
        // Beside a mirror the sparse actuals are the point: mark them.
        markers: mirrored && this.manualPricing(),
        points: details.priceHistory
          .filter((p) => inRange(p.date))
          .map((p) => ({ date: isoDate(p.date!), value: Number(p.adjustedClose?.value) })),
      },
    ];
    if (mirrored) {
      series.push({
        name: `${details.security?.mirrorsTicker ?? 'Mirror'} (right axis)`,
        axis: 'right',
        points: details.mirrorPriceHistory
          .filter((p) => inRange(p.date))
          .map((p) => ({ date: isoDate(p.date!), value: Number(p.adjustedClose?.value) })),
      });
    }
    const indicators = details.indicators;
    const indicator = this.indicator();
    if (indicator === 'sma' && indicators) {
      series.push({
        name: 'SMA (20)',
        dashed: true,
        points: indicators.sma
          .filter((p) => inRange(p.date))
          .map((p) => ({ date: isoDate(p.date!), value: Number(p.value?.value) })),
      });
    }
    if (indicator === 'ema' && indicators) {
      series.push({
        name: 'EMA (20)',
        dashed: true,
        points: indicators.ema
          .filter((p) => inRange(p.date))
          .map((p) => ({ date: isoDate(p.date!), value: Number(p.value?.value) })),
      });
    }
    if (indicator === 'bollinger' && indicators) {
      const band = indicators.bollinger.filter((p) => inRange(p.date));
      series.push(
        {
          name: 'Bollinger Mean',
          dashed: true,
          points: band.map((p) => ({ date: isoDate(p.date!), value: Number(p.mean?.value) })),
        },
        {
          name: 'Bollinger Upper',
          dashed: true,
          points: band.map((p) => ({ date: isoDate(p.date!), value: Number(p.upper?.value) })),
        },
        {
          name: 'Bollinger Lower',
          dashed: true,
          points: band.map((p) => ({ date: isoDate(p.date!), value: Number(p.lower?.value) })),
        },
      );
    }
    return series;
  });

  // ngOnInit, not the constructor: required router inputs aren't
  // bound yet at construction (NG0950).
  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      this.details.set(
        await api.securities.getSecurityDetails({
          securityId: BigInt(this.id()),
          inflationAdjusted: this.inflationAdjusted(),
        }),
      );
    } catch (err) {
      this.notify.error(err);
    }
  }

  toggleInflation(on: boolean): void {
    this.inflationAdjusted.set(on);
    void this.reload();
  }

  selectTab(index: number): void {
    void this.router.navigate([], { queryParams: { tab: index }, replaceUrl: true });
  }

  async editProfile(): Promise<void> {
    const security = this.security();
    if (!security) return;
    // The mirror field offers every other security, hidden ones too.
    let mirrorCandidates;
    try {
      mirrorCandidates = (await api.securities.listSecurities({ includeHidden: true })).securities;
    } catch (err) {
      this.notify.error(err);
      return;
    }
    this.dialog
      .open(ProfileDialog, { data: { security, mirrorCandidates } })
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }
}
