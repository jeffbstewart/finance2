import { Component, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import type { PrivatePriceRow } from '../../../proto-gen/securities_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';
import { PrivatePriceDialog } from './private-price-dialog';

/**
 * Private price history editor (spec sec. 9.12), MANUAL-locus securities
 * only - the server rejects it elsewhere (sec. 5.6). Add/edit via dialog,
 * delete confirms.
 */
@Component({
  selector: 'app-private-prices-page',
  imports: [
    MatButtonModule,
    MatCardModule,
    MatDialogModule,
    MatIconModule,
    MatTableModule,
    RouterLink,
  ],
  templateUrl: './private-prices-page.html',
  styleUrl: './securities-page.scss',
})
export class PrivatePricesPage {
  /** Router param (withComponentInputBinding). */
  readonly id = input.required<string>();

  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);

  readonly prices = signal<PrivatePriceRow[]>([]);
  readonly ticker = signal('');
  readonly columns = ['date', 'price', 'actions'];

  private get securityId(): bigint {
    return BigInt(this.id());
  }

  // ngOnInit, not the constructor: required router inputs aren't
  // bound yet at construction (NG0950).
  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      const [prices, details] = await Promise.all([
        api.securities.listPrivatePrices({ securityId: this.securityId }),
        api.securities.getSecurityDetails({ securityId: this.securityId }),
      ]);
      this.prices.set(prices.prices);
      this.ticker.set(details.security?.ticker ?? '');
    } catch (err) {
      this.notify.error(err);
    }
  }

  addPrice(): void {
    this.dialog
      .open(PrivatePriceDialog, { data: { securityId: this.securityId } })
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }

  editPrice(row: PrivatePriceRow): void {
    this.dialog
      .open(PrivatePriceDialog, { data: { securityId: this.securityId, row } })
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }

  async deletePrice(row: PrivatePriceRow): Promise<void> {
    if (!confirm(`Delete the ${row.date?.display} price ${row.price?.display}?`)) return;
    try {
      await api.securities.deletePrivatePrice({ priceId: row.priceId });
      this.notify.success('Price deleted');
      await this.reload();
    } catch (err) {
      this.notify.error(err);
    }
  }
}
