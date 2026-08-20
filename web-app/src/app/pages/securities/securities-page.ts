import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import type { SecurityListing } from '../../../proto-gen/securities_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';
import { Sparkline } from '../../shared/charts/sparkline';
import { AddSecurityDialog } from './add-security-dialog';

/** Securities list (spec §9.17): ticker/sparkline/description table,
 *  add FAB, and the hidden-security reveal legacy never had. */
@Component({
  selector: 'app-securities-page',
  imports: [
    MatButtonModule,
    MatCardModule,
    MatDialogModule,
    MatIconModule,
    MatSlideToggleModule,
    MatTableModule,
    RouterLink,
    Sparkline,
  ],
  templateUrl: './securities-page.html',
  styleUrl: './securities-page.scss',
})
export class SecuritiesPage {
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);

  readonly showHidden = signal(false);
  readonly securities = signal<SecurityListing[]>([]);
  readonly columns = ['ticker', 'sparkline', 'description', 'actions'];

  constructor() {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      const response = await api.securities.listSecurities({
        includeHidden: this.showHidden(),
      });
      this.securities.set(response.securities);
    } catch (err) {
      this.notify.error(err);
    }
  }

  toggleHidden(show: boolean): void {
    this.showHidden.set(show);
    void this.reload();
  }

  /** Six-month adjusted closes as chart geometry (presentation only). */
  trend(security: SecurityListing): number[] {
    return (security.sparkline?.adjustedCloses ?? []).map((d) => Number(d.value));
  }

  addSecurity(): void {
    this.dialog
      .open(AddSecurityDialog)
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }

  async unhide(security: SecurityListing): Promise<void> {
    try {
      await api.securities.setSecurityHidden({
        securityId: security.securityId,
        hidden: false,
      });
      this.notify.success(`${security.ticker} is visible again`);
      await this.reload();
    } catch (err) {
      this.notify.error(err);
    }
  }
}
