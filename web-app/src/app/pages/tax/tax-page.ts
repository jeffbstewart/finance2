import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import { provideNativeDateAdapter } from '@angular/material/core';
import type { FormattedMoney } from '../../../proto-gen/common_pb';
import type { GetTaxReportResponse } from '../../../proto-gen/positions_pb';
import { api } from '../../core/api';
import { civilFromJs } from '../../core/dates';
import { Notify } from '../../core/notify';

/**
 * Tax report (spec §9.16): defaults to the previous calendar year,
 * From ≤ To validated, zero money cells rendered blank, footer
 * totals. Portfolio-scoped and taxable-only server-side; the notes
 * line carries caveats like the non-USD exclusion (build-scope §5).
 */
@Component({
  selector: 'app-tax-page',
  imports: [
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatDatepickerModule,
    MatFormFieldModule,
    MatInputModule,
    MatTableModule,
  ],
  providers: [provideNativeDateAdapter()],
  templateUrl: './tax-page.html',
  styleUrl: './tax-page.scss',
})
export class TaxPage {
  private readonly notify = inject(Notify);

  from: Date = new Date(new Date().getFullYear() - 1, 0, 1);
  to: Date = new Date(new Date().getFullYear() - 1, 11, 31);

  readonly report = signal<GetTaxReportResponse | undefined>(undefined);
  readonly columns = [
    'broker', 'account', 'ticker', 'bought', 'sold', 'buyPrice', 'salePrice',
    'buyCosts', 'saleCosts', 'stGain', 'ltGain',
  ];
  readonly mtmColumns = ['mtmTicker', 'mtmYear', 'mtmDate', 'mtmFmv', 'mtmBasis', 'mtmIncome'];

  constructor() {
    void this.run();
  }

  rangeValid(): boolean {
    return (
      this.from instanceof Date && this.to instanceof Date && this.from.getTime() <= this.to.getTime()
    );
  }

  async run(): Promise<void> {
    if (!this.rangeValid()) return;
    try {
      this.report.set(
        await api.positions.getTaxReport({
          from: civilFromJs(this.from),
          to: civilFromJs(this.to),
        }),
      );
    } catch (err) {
      this.notify.error(err);
    }
  }

  /** Zero money renders blank (spec §9.16). */
  blankZero(money?: FormattedMoney): string {
    if (!money || money.sortKey === 0) return '';
    return money.display;
  }
}
