import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { Router, RouterLink } from '@angular/router';
import type { BrokerSummary } from '../../../proto-gen/brokers_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';
import { PieChart, type PieSlice } from '../../shared/charts/pie-chart';
import { BrokerDialog } from './broker-dialog';

/** Brokerages (spec §9.1): broker table with totals, holdings pie,
 *  add FAB, and the hidden-broker reveal legacy never had. */
@Component({
  selector: 'app-brokers-page',
  imports: [
    MatButtonModule,
    MatCardModule,
    MatDialogModule,
    MatIconModule,
    MatSlideToggleModule,
    MatTableModule,
    PieChart,
    RouterLink,
  ],
  templateUrl: './brokers-page.html',
  styleUrl: './brokers-page.scss',
})
export class BrokersPage {
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);

  readonly showHidden = signal(false);
  readonly brokers = signal<BrokerSummary[]>([]);
  readonly totalHoldings = signal('');
  readonly totalSweeps = signal('');
  readonly columns = ['name', 'totalHoldings', 'sweeps', 'actions'];

  readonly slices = computed<PieSlice[]>(() =>
    this.brokers()
      .filter((b) => !b.hidden)
      .map((b) => ({
        id: String(b.brokerId),
        name: b.name,
        value: b.totalHoldings?.sortKey ?? 0,
        display: b.totalHoldings?.display ?? '',
      })),
  );

  constructor() {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      const response = await api.brokers.listBrokers({ includeHidden: this.showHidden() });
      this.brokers.set(response.brokers);
      this.totalHoldings.set(response.totalHoldings?.display ?? '');
      this.totalSweeps.set(response.totalSweeps?.display ?? '');
    } catch (err) {
      this.notify.error(err);
    }
  }

  toggleHidden(show: boolean): void {
    this.showHidden.set(show);
    void this.reload();
  }

  addBroker(): void {
    this.dialog
      .open(BrokerDialog, { data: {} })
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }

  async unhide(broker: BrokerSummary): Promise<void> {
    try {
      await api.brokers.setBrokerHidden({ brokerId: broker.brokerId, hidden: false });
      this.notify.success(`${broker.name} is visible again`);
      await this.reload();
    } catch (err) {
      this.notify.error(err);
    }
  }

  openBroker(slice: PieSlice): void {
    void this.router.navigate(['/brokers', slice.id]);
  }
}
