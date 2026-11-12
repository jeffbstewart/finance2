import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { Router, RouterLink } from '@angular/router';
import { PlanStatus, type PlanSummary } from '../../../proto-gen/trading_plan_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';

/**
 * The plans (docs/design/trading-plan.md): newest first, a name box
 * to start a new one, and a toggle to reveal archived plans. Opening
 * a plan goes to its page; nothing here executes anything.
 */
@Component({
  selector: 'app-plans-page',
  imports: [
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSlideToggleModule,
    MatTableModule,
    RouterLink,
  ],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Trading Plans</mat-card-title>
        <mat-card-subtitle>
          Propose buys, sells, transfers, and cash in or out; see the allocation afterwards; print the plan to execute by hand.
        </mat-card-subtitle>
        <span class="header-spacer"></span>
        <mat-slide-toggle [checked]="showArchived()" (change)="toggleArchived($event.checked)">Show archived</mat-slide-toggle>
      </mat-card-header>
      <mat-card-content>
        <div class="controls-row">
          <mat-form-field appearance="outline" class="name">
            <mat-label>New plan</mat-label>
            <input matInput [(ngModel)]="newName" placeholder="e.g. Autumn 2026 rebalance" (keydown.enter)="create()">
          </mat-form-field>
          <button matButton="filled" [disabled]="busy() || !newName.trim()" (click)="create()">
            <mat-icon>add</mat-icon>
            Create
          </button>
        </div>
        <table mat-table [dataSource]="plans()">
          <ng-container matColumnDef="name">
            <th mat-header-cell *matHeaderCellDef>Plan</th>
            <td mat-cell *matCellDef="let p">
              <a [routerLink]="['/allocation/plans', p.planId]">{{ p.name }}</a>
              @if (p.status === PlanStatus.PLAN_ARCHIVED) { <span class="hidden-tag">(archived)</span> }
            </td>
          </ng-container>
          <ng-container matColumnDef="steps">
            <th mat-header-cell *matHeaderCellDef class="num">Steps</th>
            <td mat-cell *matCellDef="let p" class="num">{{ p.stepCount }}</td>
          </ng-container>
          <ng-container matColumnDef="updated">
            <th mat-header-cell *matHeaderCellDef>Updated</th>
            <td mat-cell *matCellDef="let p">{{ timestamp(p.updatedAt) }}</td>
          </ng-container>
          <ng-container matColumnDef="printed">
            <th mat-header-cell *matHeaderCellDef>Last printed</th>
            <td mat-cell *matCellDef="let p">{{ timestamp(p.lastPrintedAt) }}</td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="columns"></tr>
          <tr mat-row *matRowDef="let row; columns: columns"></tr>
        </table>
        @if (!plans().length) {
          <p class="empty-note">No plans yet. Name one above to start.</p>
        }
      </mat-card-content>
    </mat-card>
  `,
  styleUrl: './allocation-page.scss',
})
export class PlansPage {
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);

  readonly PlanStatus = PlanStatus;
  readonly plans = signal<PlanSummary[]>([]);
  readonly showArchived = signal(false);
  readonly busy = signal(false);
  readonly columns = ['name', 'steps', 'updated', 'printed'];
  newName = '';

  constructor() {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      this.plans.set((await api.plans.listPlans({ includeArchived: this.showArchived() })).plans);
    } catch (err) {
      this.notify.error(err);
    }
  }

  toggleArchived(show: boolean): void {
    this.showArchived.set(show);
    void this.reload();
  }

  async create(): Promise<void> {
    const name = this.newName.trim();
    if (!name) return;
    this.busy.set(true);
    try {
      const response = await api.plans.createPlan({ name });
      this.notify.success(`${name} created`);
      this.newName = '';
      await this.router.navigate(['/allocation/plans', response.plan?.summary?.planId]);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  timestamp(iso: string): string {
    return iso ? iso.replace('T', ' ').replace(/\.\d+/, '').replace(/([+-]\d\d:\d\d|Z)$/, '') : '';
  }
}
