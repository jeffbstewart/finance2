import { Component, computed, inject, input, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { Router, RouterLink } from '@angular/router';
import type { ClassAllocation, ClassContributor } from '../../../proto-gen/allocation_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';
import { PieChart, type PieSlice } from '../../shared/charts/pie-chart';

/** Allocation class details (spec §9.15): the positions contributing
 *  to one asset class, with a pie of contributions. */
@Component({
  selector: 'app-class-details-page',
  imports: [MatCardModule, MatTableModule, PieChart, RouterLink],
  templateUrl: './class-details-page.html',
  styleUrl: './allocation-page.scss',
})
export class ClassDetailsPage {
  /** Router param: the class name (class identity on the wire). */
  readonly name = input.required<string>();

  private readonly notify = inject(Notify);
  private readonly router = inject(Router);

  readonly allocation = signal<ClassAllocation | undefined>(undefined);
  readonly columns = ['ticker', 'shares', 'classWeight', 'contribution'];

  readonly contributors = computed<ClassContributor[]>(
    () => this.allocation()?.contributors ?? [],
  );

  readonly slices = computed<PieSlice[]>(() =>
    this.contributors().map((c) => ({
      id: String(c.securityId),
      name: c.ticker,
      value: c.contribution?.sortKey ?? 0,
      display: c.contribution?.display ?? '',
    })),
  );

  // ngOnInit, not the constructor: required router inputs aren't
  // bound yet at construction (NG0950).
  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      const response = await api.allocation.getAllocation({});
      this.allocation.set(response.classes.find((c) => c.name === this.name()));
    } catch (err) {
      this.notify.error(err);
    }
  }

  openSecurity(slice: PieSlice): void {
    void this.router.navigate(['/securities', slice.id]);
  }
}
