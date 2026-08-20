import { Component, effect, inject, input, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import type { MtmMark, SecurityProfile } from '../../../proto-gen/securities_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';
import { MtmMarkDialog } from './mtm-mark-dialog';

/**
 * The PFIC §1296 ledger (build-scope §11): year-ascending marks with
 * the acquisition-cost floor, a record flow prefilled from the
 * server's suggestion, and latest-only delete (the basis chain feeds
 * forward).
 */
@Component({
  selector: 'app-mtm-marks',
  imports: [MatButtonModule, MatDialogModule, MatIconModule, MatTableModule],
  template: `
    <div class="mtm-header">
      <p class="floor-line">
        Acquisition cost (basis floor): {{ acquisitionCost() || '—' }}
      </p>
      <button matButton="filled" (click)="recordMark()">
        <mat-icon>event_available</mat-icon>
        Record year-end mark
      </button>
    </div>

    @if (marks().length) {
      <table mat-table [dataSource]="marks()">
        <ng-container matColumnDef="year">
          <th mat-header-cell *matHeaderCellDef>Tax Year</th>
          <td mat-cell *matCellDef="let m">{{ m.taxYear }}</td>
        </ng-container>
        <ng-container matColumnDef="date">
          <th mat-header-cell *matHeaderCellDef>Marked</th>
          <td mat-cell *matCellDef="let m">{{ m.markDate?.display }}</td>
        </ng-container>
        <ng-container matColumnDef="shares">
          <th mat-header-cell *matHeaderCellDef class="num">Shares</th>
          <td mat-cell *matCellDef="let m" class="num">{{ m.quantity?.display }}</td>
        </ng-container>
        <ng-container matColumnDef="fmvLocal">
          <th mat-header-cell *matHeaderCellDef class="num">FMV ({{ currency() }})</th>
          <td mat-cell *matCellDef="let m" class="num">{{ m.fmvLocal?.display }}</td>
        </ng-container>
        <ng-container matColumnDef="fx">
          <th mat-header-cell *matHeaderCellDef class="num">FX Rate</th>
          <td mat-cell *matCellDef="let m" class="num">{{ m.fxRate?.display }}</td>
        </ng-container>
        <ng-container matColumnDef="fmvUsd">
          <th mat-header-cell *matHeaderCellDef class="num">FMV (USD)</th>
          <td mat-cell *matCellDef="let m" class="num">{{ m.fmvUsd?.display }}</td>
        </ng-container>
        <ng-container matColumnDef="basisAfter">
          <th mat-header-cell *matHeaderCellDef class="num">Basis After</th>
          <td mat-cell *matCellDef="let m" class="num">{{ m.basisAfter?.display }}</td>
        </ng-container>
        <ng-container matColumnDef="income">
          <th mat-header-cell *matHeaderCellDef class="num">Ordinary Income</th>
          <td mat-cell *matCellDef="let m" class="num">{{ m.ordinaryIncome?.display }}</td>
        </ng-container>
        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef></th>
          <td mat-cell *matCellDef="let m" class="row-actions">
            @if (m === latest()) {
              <button matIconButton (click)="deleteMark(m)" aria-label="Delete latest mark">
                <mat-icon>delete</mat-icon>
              </button>
            }
          </td>
        </ng-container>
        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let row; columns: columns"></tr>
      </table>
    } @else {
      <p class="empty-note">
        No marks recorded yet — record the first year-end mark to start the ledger.
      </p>
    }
  `,
  styles: `
    .mtm-header {
      display: flex; align-items: center; justify-content: space-between;
      flex-wrap: wrap; gap: 16px; padding: 16px 0 8px;
    }
    .floor-line { margin: 0; opacity: 0.8; }
    table { width: 100%; margin-bottom: 16px; }
    .num { text-align: right; }
    .row-actions { white-space: nowrap; }
    .empty-note { opacity: 0.7; }
  `,
})
export class MtmMarks {
  readonly security = input.required<SecurityProfile>();
  readonly changed = output<void>();

  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);

  readonly marks = signal<MtmMark[]>([]);
  readonly acquisitionCost = signal('');
  readonly columns = [
    'year', 'date', 'shares', 'fmvLocal', 'fx', 'fmvUsd', 'basisAfter', 'income', 'actions',
  ];

  currency(): string {
    return this.security().currencyCode;
  }

  latest(): MtmMark | undefined {
    const marks = this.marks();
    return marks[marks.length - 1];
  }

  constructor() {
    effect(() => {
      this.security();
      void this.reload();
    });
  }

  async reload(): Promise<void> {
    try {
      const response = await api.securities.listMtmMarks({
        securityId: this.security().securityId,
      });
      this.marks.set(response.marks);
      this.acquisitionCost.set(response.acquisitionCostUsd?.display ?? '');
    } catch (err) {
      this.notify.error(err);
    }
  }

  recordMark(): void {
    const latest = this.latest();
    // Marks file for past years: default to the year after the last
    // mark, else the previous calendar year.
    const defaultYear = latest ? latest.taxYear + 1 : new Date().getFullYear() - 1;
    this.dialog
      .open(MtmMarkDialog, {
        data: { security: this.security(), taxYear: defaultYear },
      })
      .afterClosed()
      .subscribe((recorded) => {
        if (recorded) {
          void this.reload();
          this.changed.emit();
        }
      });
  }

  async deleteMark(mark: MtmMark): Promise<void> {
    if (!confirm(`Delete the ${mark.taxYear} mark (${mark.ordinaryIncome?.display} ordinary income)?`)) {
      return;
    }
    try {
      await api.securities.deleteMtmMark({ markId: mark.markId });
      this.notify.success(`${mark.taxYear} mark deleted`);
      await this.reload();
      this.changed.emit();
    } catch (err) {
      this.notify.error(err);
    }
  }
}
