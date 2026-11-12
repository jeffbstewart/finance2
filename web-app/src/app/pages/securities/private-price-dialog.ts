import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { provideNativeDateAdapter } from '@angular/material/core';
import type { PrivatePriceRow } from '../../../proto-gen/securities_pb';
import { api } from '../../core/api';
import { civilFromJs, jsFromCivil } from '../../core/dates';
import { isDecimalString } from '../../core/decimals';
import { Notify } from '../../core/notify';

export interface PrivatePriceDialogData {
  securityId: bigint;
  row?: PrivatePriceRow;
}

/** Add / edit one private price (spec sec. 9.12): date + price per share,
 *  both required - actually validated, unlike legacy. */
@Component({
  selector: 'app-private-price-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDatepickerModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  providers: [provideNativeDateAdapter()],
  template: `
    <h2 mat-dialog-title>{{ data.row ? 'Edit Price' : 'Add Price' }}</h2>
    <mat-dialog-content class="price-form">
      <mat-form-field appearance="outline">
        <mat-label>Date</mat-label>
        <input matInput [matDatepicker]="picker" [(ngModel)]="date" required>
        <mat-datepicker-toggle matIconSuffix [for]="picker" />
        <mat-datepicker #picker />
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Price Per Share</mat-label>
        <input matInput [(ngModel)]="price" required>
        @if (!priceValid()) {
          <mat-error>Enter a plain decimal like 123.45</mat-error>
        }
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="busy() || !valid()" (click)="submit()">
        Submit
      </button>
    </mat-dialog-actions>
  `,
  styles: '.price-form { display: flex; flex-direction: column; min-width: 320px; }',
})
export class PrivatePriceDialog {
  readonly data = inject<PrivatePriceDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<PrivatePriceDialog>);
  private readonly notify = inject(Notify);

  date: Date | null = this.data.row?.date?.exact ? jsFromCivil(this.data.row.date.exact) : null;
  price = this.data.row?.price?.exact?.amount?.value ?? '';
  readonly busy = signal(false);

  priceValid(): boolean {
    return this.price.trim() === '' || isDecimalString(this.price);
  }

  valid(): boolean {
    return this.date instanceof Date && isDecimalString(this.price);
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      const civil = civilFromJs(this.date!);
      if (this.data.row) {
        await api.securities.updatePrivatePrice({
          priceId: this.data.row.priceId,
          date: civil,
          price: { value: this.price.trim() },
        });
        this.notify.success('Price updated');
      } else {
        await api.securities.addPrivatePrice({
          securityId: this.data.securityId,
          date: civil,
          price: { value: this.price.trim() },
        });
        this.notify.success('Price added');
      }
      this.ref.close(true);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
