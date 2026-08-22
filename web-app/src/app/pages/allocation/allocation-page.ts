import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { Router, RouterLink } from '@angular/router';
import type { ClassAllocation } from '../../../proto-gen/allocation_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';
import { GroupedBarChart, type BarSeries } from '../../shared/charts/grouped-bar-chart';
import { PieChart, type PieSlice } from '../../shared/charts/pie-chart';
import { TargetDialog } from './target-dialog';

/**
 * Allocation dashboard (spec sec. 9.13): current and target pies, the
 * current-vs-target percent bars, the delta-dollar bars ("Asset
 * Changes Required Without Investing"), the class table, and the door
 * into the rebalance planner. When no target is stored the server
 * says so and the UI prompts - it never invents one (sec. 5.4).
 */
@Component({
  selector: 'app-allocation-page',
  imports: [
    GroupedBarChart,
    MatButtonModule,
    MatCardModule,
    MatDialogModule,
    MatIconModule,
    MatTableModule,
    PieChart,
    RouterLink,
  ],
  templateUrl: './allocation-page.html',
  styleUrl: './allocation-page.scss',
})
export class AllocationPage {
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);

  readonly classes = signal<ClassAllocation[]>([]);
  readonly portfolioTotal = signal('');
  readonly targetSet = signal(true);
  readonly columns = ['name', 'current', 'target', 'delta', 'percent', 'targetPercent'];

  readonly currentSlices = computed<PieSlice[]>(() =>
    this.classes()
      .filter((c) => (c.current?.sortKey ?? 0) > 0)
      .map((c) => ({
        id: c.name,
        name: c.name,
        value: c.current?.sortKey ?? 0,
        display: c.current?.display ?? '',
      })),
  );

  readonly targetSlices = computed<PieSlice[]>(() =>
    this.classes()
      .filter((c) => (c.target?.sortKey ?? 0) > 0)
      .map((c) => ({
        id: c.name,
        name: c.name,
        value: c.target?.sortKey ?? 0,
        display: c.target?.display ?? '',
      })),
  );

  readonly categories = computed(() => this.classes().map((c) => c.name));

  readonly percentSeries = computed<BarSeries[]>(() => [
    {
      name: 'Current %',
      values: this.classes().map((c) => (c.currentFraction?.sortKey ?? 0) * 100),
      displays: this.classes().map((c) => c.currentFraction?.display ?? ''),
    },
    {
      name: 'Target %',
      values: this.classes().map((c) => (c.targetFraction?.sortKey ?? 0) * 100),
      displays: this.classes().map((c) => c.targetFraction?.display ?? ''),
    },
  ]);

  readonly deltaSeries = computed<BarSeries[]>(() => [
    {
      name: 'Delta $',
      values: this.classes().map((c) => c.delta?.sortKey ?? 0),
      displays: this.classes().map((c) => c.delta?.display ?? ''),
    },
  ]);

  constructor() {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      const response = await api.allocation.getAllocation({});
      this.classes.set(response.classes);
      this.portfolioTotal.set(response.portfolioTotal?.display ?? '');
      this.targetSet.set(response.targetSet);
    } catch (err) {
      this.notify.error(err);
    }
  }

  editTarget(): void {
    this.dialog
      .open(TargetDialog, { data: { classes: this.classes() } })
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }

  openClass(slice: PieSlice): void {
    void this.router.navigate(['/allocation/class', slice.id]);
  }
}
