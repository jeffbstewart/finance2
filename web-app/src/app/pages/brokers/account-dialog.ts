import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { AccountSummary } from '../../../proto-gen/accounts_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';

export interface AccountDialogData {
  brokerId: bigint;
  account?: AccountSummary;
}

/**
 * Add / edit account (spec sec. 9.4). Currency is fixed at creation
 * (build-scope sec. 5); the edit form is where sweeps are maintained by
 * hand.
 */
@Component({
  selector: 'app-account-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ data.account ? 'Edit Account' : 'Add Account' }}</h2>
    <mat-dialog-content class="account-form">
      <mat-form-field appearance="outline">
        <mat-label>Account Name</mat-label>
        <input matInput [(ngModel)]="name" required cdkFocusInitial>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Account Number</mat-label>
        <input matInput [(ngModel)]="accountNumber" required>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Tax Status</mat-label>
        <mat-select [(ngModel)]="taxDeferred">
          <mat-option [value]="false">Taxable</mat-option>
          <mat-option [value]="true">Tax Deferred</mat-option>
        </mat-select>
      </mat-form-field>
      @if (!data.account) {
        <mat-form-field appearance="outline">
          <mat-label>Currency</mat-label>
          <mat-select [(ngModel)]="currencyCode">
            <mat-option value="USD">USD</mat-option>
            <mat-option value="EUR">EUR</mat-option>
          </mat-select>
        </mat-form-field>
      } @else {
        <mat-form-field appearance="outline">
          <mat-label>Sweeps Balance ({{ data.account.currencyCode }})</mat-label>
          <input matInput [(ngModel)]="sweepBalance" required>
        </mat-form-field>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="busy() || !valid()" (click)="submit()">Submit</button>
    </mat-dialog-actions>
  `,
  styles: '.account-form { display: flex; flex-direction: column; min-width: 360px; }',
})
export class AccountDialog {
  readonly data = inject<AccountDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<AccountDialog>);
  private readonly notify = inject(Notify);

  name = this.data.account?.name ?? '';
  accountNumber = this.data.account?.accountNumber ?? '';
  taxDeferred = this.data.account?.taxDeferred ?? false;
  currencyCode = 'USD';
  sweepBalance = this.data.account?.sweepBalance?.exact?.amount?.value ?? '0';
  readonly busy = signal(false);

  valid(): boolean {
    return this.name.trim().length > 0 && this.accountNumber.trim().length > 0;
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      if (this.data.account) {
        await api.accounts.updateAccount({
          accountId: this.data.account.accountId,
          name: this.name.trim(),
          accountNumber: this.accountNumber.trim(),
          taxDeferred: this.taxDeferred,
          sweepBalance: { value: this.sweepBalance.trim() },
        });
        this.notify.success('Account updated');
      } else {
        await api.accounts.createAccount({
          brokerId: this.data.brokerId,
          name: this.name.trim(),
          accountNumber: this.accountNumber.trim(),
          currencyCode: this.currencyCode,
          taxDeferred: this.taxDeferred,
        });
        this.notify.success('Account added');
      }
      this.ref.close(true);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
