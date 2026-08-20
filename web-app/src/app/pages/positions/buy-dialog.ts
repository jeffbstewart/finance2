import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { provideNativeDateAdapter } from '@angular/material/core';
import type { AccountChoice, LotRow, SecurityChoice } from '../../../proto-gen/positions_pb';
import { api } from '../../core/api';
import { civilFromJs, jsFromCivil } from '../../core/dates';
import { isDecimalString } from '../../core/decimals';
import { Notify } from '../../core/notify';

export interface BuyDialogData {
  /** Preselects the account (spec §9.5's FAB). */
  accountId?: bigint;
  /** Preselects the security (lot-details buy). */
  securityId?: bigint;
  /** Edit mode: the lot being changed — account/security are fixed
   *  (guard rail §5.9: moving a lot would corrupt its sales). */
  lot?: LotRow;
}

/** Buy dialog (spec §9.8): date, account, security, shares, price,
 *  commission. Edit mode reuses the form minus account/security. */
@Component({
  selector: 'app-buy-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDatepickerModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  providers: [provideNativeDateAdapter()],
  template: `
    <h2 mat-dialog-title>{{ data.lot ? 'Edit Position' : 'Purchase Security' }}</h2>
    <mat-dialog-content class="buy-form">
      <mat-form-field appearance="outline">
        <mat-label>Date</mat-label>
        <input matInput [matDatepicker]="picker" [(ngModel)]="date" required>
        <mat-datepicker-toggle matIconSuffix [for]="picker" />
        <mat-datepicker #picker />
      </mat-form-field>
      @if (!data.lot) {
        <mat-form-field appearance="outline">
          <mat-label>Account</mat-label>
          <mat-select [(ngModel)]="accountId" required>
            @for (a of accounts(); track a.accountId) {
              <mat-option [value]="a.accountId">
                {{ a.brokerName }} : {{ a.name }} ({{ a.currencyCode }})
              </mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Security</mat-label>
          <mat-select [(ngModel)]="securityId" required>
            @for (s of securities(); track s.securityId) {
              <mat-option [value]="s.securityId">{{ s.ticker }}: {{ s.description }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      }
      <mat-form-field appearance="outline">
        <mat-label>Shares</mat-label>
        <input matInput [(ngModel)]="shares" required>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Price Per Share</mat-label>
        <input matInput [(ngModel)]="pricePerShare" required>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Commission</mat-label>
        <input matInput [(ngModel)]="commission" required>
        <mat-hint>If you paid no commission, enter 0 here.</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="busy() || !valid()" (click)="submit()">Submit</button>
    </mat-dialog-actions>
  `,
  styles: '.buy-form { display: flex; flex-direction: column; min-width: 380px; }',
})
export class BuyDialog {
  readonly data = inject<BuyDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<BuyDialog>);
  private readonly notify = inject(Notify);

  readonly accounts = signal<AccountChoice[]>([]);
  readonly securities = signal<SecurityChoice[]>([]);
  readonly busy = signal(false);

  date: Date | null = this.data.lot?.bought?.exact
    ? jsFromCivil(this.data.lot.bought.exact)
    : null;
  accountId: bigint | undefined = this.data.accountId;
  securityId: bigint | undefined = this.data.securityId;
  shares = this.data.lot?.shares?.exact?.value ?? '';
  pricePerShare = this.data.lot?.buyPricePerShare?.exact?.amount?.value ?? '';
  commission = this.data.lot?.commission?.exact?.amount?.value ?? '';

  constructor() {
    if (!this.data.lot) void this.loadChoices();
  }

  private async loadChoices(): Promise<void> {
    try {
      const info = await api.positions.getPurchaseFormInfo({});
      // Tax-deferred accounts don't take lot purchases (build-scope §1).
      this.accounts.set(info.accounts.filter((a) => !a.taxDeferred));
      this.securities.set(info.securities);
    } catch (err) {
      this.notify.error(err);
    }
  }

  valid(): boolean {
    return (
      this.date instanceof Date &&
      (this.data.lot ? true : this.accountId !== undefined && this.securityId !== undefined) &&
      isDecimalString(this.shares) &&
      isDecimalString(this.pricePerShare) &&
      isDecimalString(this.commission)
    );
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      const bought = civilFromJs(this.date!);
      if (this.data.lot) {
        await api.positions.updatePurchase({
          lotId: this.data.lot.lotId,
          bought,
          shares: { value: this.shares.trim() },
          pricePerShare: { value: this.pricePerShare.trim() },
          commission: { value: this.commission.trim() },
        });
        this.notify.success('Position updated');
      } else {
        await api.positions.addPurchase({
          accountId: this.accountId!,
          securityId: this.securityId!,
          bought,
          shares: { value: this.shares.trim() },
          pricePerShare: { value: this.pricePerShare.trim() },
          commission: { value: this.commission.trim() },
        });
        this.notify.success('Purchase recorded');
      }
      this.ref.close(true);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
