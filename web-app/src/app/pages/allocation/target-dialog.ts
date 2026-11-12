import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { ClassAllocation } from '../../../proto-gen/allocation_pb';
import { api } from '../../core/api';
import {
  fractionToPercent,
  isDecimalString,
  percentToFraction,
  shiftLeft,
  shiftRight,
} from '../../core/decimals';
import { Notify } from '../../core/notify';

export interface TargetDialogData {
  classes: ClassAllocation[];
}

interface TargetRow {
  name: string;
  percent: string;
}

/** Edit Target Asset Allocation (spec sec. 9.13): one percent field per
 *  class, each 0-100, must sum to 100 - exact string decimals. */
@Component({
  selector: 'app-target-dialog',
  imports: [FormsModule, MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>Edit Target Asset Allocation</h2>
    <mat-dialog-content class="target-form">
      @for (row of rows(); track row.name) {
        <mat-form-field appearance="outline">
          <mat-label>{{ row.name }} %</mat-label>
          <input matInput [(ngModel)]="row.percent" (ngModelChange)="revalidate()">
        </mat-form-field>
      }
      @if (validationError(); as message) {
        <p class="validation-error">{{ message }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="busy() || !!validationError()" (click)="submit()">
        Submit
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .target-form { display: flex; flex-direction: column; min-width: 320px; }
    .validation-error { color: #b3261e; font-size: 13px; }
  `,
})
export class TargetDialog {
  readonly data = inject<TargetDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<TargetDialog>);
  private readonly notify = inject(Notify);

  readonly busy = signal(false);
  readonly validationError = signal<string | null>(null);
  readonly rows = signal<TargetRow[]>(
    this.data.classes.map((c) => ({
      name: c.name,
      percent: c.targetFraction?.exact?.value
        ? fractionToPercent(c.targetFraction.exact.value)
        : '0',
    })),
  );

  revalidate(): void {
    this.validationError.set(this.validate());
  }

  /** Mirror of the server rule: each 0-100, sum 100 (+/-0.01). */
  private validate(): string | null {
    let totalTenThousandths = 0;
    for (const row of this.rows()) {
      const percent = row.percent.trim();
      if (!isDecimalString(percent)) {
        return `${row.name}: enter a number between 0 and 100`;
      }
      const scaled = Number(shiftRight(percentToFraction(percent), 4));
      if (!Number.isInteger(scaled)) return `${row.name}: at most two decimal places`;
      if (scaled < 0 || scaled > 10_000) return `${row.name}: must be between 0 and 100`;
      totalTenThousandths += scaled;
    }
    if (Math.abs(totalTenThousandths - 10_000) > 1) {
      return `Percents must sum to 100 (currently ${shiftLeft(String(totalTenThousandths), 2)})`;
    }
    return null;
  }

  async submit(): Promise<void> {
    const error = this.validate();
    if (error) {
      this.validationError.set(error);
      return;
    }
    this.busy.set(true);
    try {
      await api.allocation.setTargetAllocation({
        entries: this.rows().map((row) => ({
          assetClass: row.name,
          fraction: { value: percentToFraction(row.percent.trim()) },
        })),
      });
      this.notify.success('Target allocation saved');
      this.ref.close(true);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
