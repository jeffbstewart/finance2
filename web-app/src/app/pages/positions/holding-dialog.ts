import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { AccountSummary } from '../../../proto-gen/accounts_pb';
import type { SecurityChoice } from '../../../proto-gen/positions_pb';
import { api } from '../../core/api';
import { isDecimalString } from '../../core/decimals';
import { Notify } from '../../core/notify';

export interface HoldingDialogData {
  account: AccountSummary;
  /** Editing an existing row preselects and locks the security. */
  securityId?: bigint;
  ticker?: string;
  quantity?: string;
}

/**
 * Position-level holdings entry for tax-deferred accounts
 * (build-scope §1): no lots, no basis — just the current share count.
 * Setting quantity 0 via delete removes the row.
 */
@Component({
  selector: 'app-holding-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <h2 mat-dialog-title>
      {{ data.securityId ? 'Edit Holding' : 'Set Holding' }} — {{ data.account.name }}
    </h2>
    <mat-dialog-content class="holding-form">
      @if (data.securityId) {
        <p>{{ data.ticker }}</p>
      } @else {
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
        <mat-label>Shares Held</mat-label>
        <input matInput [(ngModel)]="quantity" required cdkFocusInitial>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="busy() || !valid()" (click)="submit()">Submit</button>
    </mat-dialog-actions>
  `,
  styles: '.holding-form { display: flex; flex-direction: column; min-width: 360px; }',
})
export class HoldingDialog {
  readonly data = inject<HoldingDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<HoldingDialog>);
  private readonly notify = inject(Notify);

  readonly securities = signal<SecurityChoice[]>([]);
  readonly busy = signal(false);

  securityId: bigint | undefined = this.data.securityId;
  quantity = this.data.quantity ?? '';

  constructor() {
    if (!this.data.securityId) void this.loadChoices();
  }

  private async loadChoices(): Promise<void> {
    try {
      const info = await api.positions.getPurchaseFormInfo({});
      this.securities.set(info.securities);
    } catch (err) {
      this.notify.error(err);
    }
  }

  valid(): boolean {
    return this.securityId !== undefined && isDecimalString(this.quantity);
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      await api.positions.setHolding({
        accountId: this.data.account.accountId,
        securityId: this.securityId!,
        quantity: { value: this.quantity.trim() },
      });
      this.notify.success('Holding saved');
      this.ref.close(true);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
