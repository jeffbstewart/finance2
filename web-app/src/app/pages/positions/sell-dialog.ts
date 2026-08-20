import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatStepperModule } from '@angular/material/stepper';
import { provideNativeDateAdapter } from '@angular/material/core';
import type { LotRow } from '../../../proto-gen/positions_pb';
import { api } from '../../core/api';
import { civilFromJs } from '../../core/dates';
import { isDecimalString, toScaledBigInt } from '../../core/decimals';
import { Notify } from '../../core/notify';

export interface SellDialogData {
  securityId: bigint;
  accountId: bigint;
  ticker: string;
  accountName: string;
  brokerName: string;
  /** The lots checked on the lot-details page. */
  lots: LotRow[];
}

interface LotAllocation {
  lot: LotRow;
  sellShares: string;
}

/** Quantities carry scale 8 (build-scope §2). */
const SHARE_SCALE = 8;

/**
 * Sell dialog (spec §9.9): 3-step linear stepper — sale summary, per-
 * lot share picks that must sum to the step-1 total (validated here
 * exactly, and again server-side per guard rail §5.9), confirm.
 */
@Component({
  selector: 'app-sell-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDatepickerModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatStepperModule,
  ],
  providers: [provideNativeDateAdapter()],
  template: `
    <h2 mat-dialog-title>Sell {{ data.ticker }}</h2>
    <mat-dialog-content>
      <mat-stepper linear #stepper>
        <mat-step [completed]="step1Valid()">
          <ng-template matStepLabel>Sale Summary</ng-template>
          <p class="context">
            {{ data.brokerName }} {{ data.brokerName ? ':' : '' }} {{ data.accountName }}
            — {{ data.ticker }}
          </p>
          <div class="sell-form">
            <mat-form-field appearance="outline">
              <mat-label>Sale Date</mat-label>
              <input matInput [matDatepicker]="picker" [(ngModel)]="date" required>
              <mat-datepicker-toggle matIconSuffix [for]="picker" />
              <mat-datepicker #picker />
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Shares to Sell</mat-label>
              <input matInput [(ngModel)]="shares" required>
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Price Per Share</mat-label>
              <input matInput [(ngModel)]="pricePerShare" required>
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Commission</mat-label>
              <input matInput [(ngModel)]="saleCosts" required>
              <mat-hint>If you paid no commission, enter 0 here.</mat-hint>
            </mat-form-field>
          </div>
          <div class="step-actions">
            <button matButton="filled" matStepperNext [disabled]="!step1Valid()">Next</button>
          </div>
        </mat-step>
        <mat-step [completed]="step2Valid()">
          <ng-template matStepLabel>Pick Lots</ng-template>
          <p class="context">Please pick {{ shares }} shares from these lots:</p>
          @for (allocation of allocations(); track allocation.lot.lotId) {
            <div class="lot-pick">
              <span class="lot-label">
                Bought {{ allocation.lot.bought?.display }} —
                {{ allocation.lot.sharesStillHeld?.display }} held at
                {{ allocation.lot.buyPricePerShare?.display }}
              </span>
              <mat-form-field appearance="outline" class="lot-shares">
                <mat-label>Sell Shares</mat-label>
                <input matInput [(ngModel)]="allocation.sellShares">
              </mat-form-field>
            </div>
          }
          @if (step2Error(); as message) {
            <p class="validation-error">{{ message }}</p>
          }
          <div class="step-actions">
            <button matButton matStepperPrevious>Back</button>
            <button matButton="filled" matStepperNext [disabled]="!step2Valid()">Next</button>
          </div>
        </mat-step>
        <mat-step>
          <ng-template matStepLabel>Submit</ng-template>
          <p class="context">
            Sell {{ shares }} shares of {{ data.ticker }} at {{ pricePerShare }} per share
            on {{ date?.toLocaleDateString() }} from {{ pickedCount() }}
            lot{{ pickedCount() === 1 ? '' : 's' }}.
          </p>
          <div class="step-actions">
            <button matButton matStepperPrevious>Back</button>
            <button matButton="filled" [disabled]="busy()" (click)="submit()">Sell Lots</button>
          </div>
        </mat-step>
      </mat-stepper>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
    </mat-dialog-actions>
  `,
  styles: `
    .sell-form { display: flex; flex-direction: column; max-width: 380px; }
    .context { opacity: 0.8; }
    .lot-pick { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .lot-label { flex: 1 1 280px; }
    .lot-shares { width: 160px; }
    .validation-error { color: #b3261e; font-size: 13px; }
    .step-actions { display: flex; gap: 8px; margin-top: 8px; }
  `,
})
export class SellDialog {
  readonly data = inject<SellDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<SellDialog>);
  private readonly notify = inject(Notify);

  date: Date | null = null;
  shares = '';
  pricePerShare = '';
  saleCosts = '';
  readonly busy = signal(false);

  readonly allocations = signal<LotAllocation[]>(
    this.data.lots.map((lot) => ({ lot, sellShares: '' })),
  );

  step1Valid(): boolean {
    return (
      this.date instanceof Date &&
      isDecimalString(this.shares) &&
      isDecimalString(this.pricePerShare) &&
      isDecimalString(this.saleCosts)
    );
  }

  /** Cross-validation (spec §9.9 step 2): capped per lot, sums to the
   *  step-1 total — exact scaled integers, no float arithmetic. */
  step2Error(): string | null {
    if (!isDecimalString(this.shares)) return null;
    let total: bigint;
    try {
      total = toScaledBigInt(this.shares, SHARE_SCALE);
    } catch {
      return 'Shares to sell has too many decimal places';
    }
    let sum = 0n;
    for (const allocation of this.allocations()) {
      const entered = allocation.sellShares.trim();
      if (entered === '' || entered === '0') continue;
      if (!isDecimalString(entered)) {
        return `Lot bought ${allocation.lot.bought?.display}: enter a share count`;
      }
      let picked: bigint;
      try {
        picked = toScaledBigInt(entered, SHARE_SCALE);
      } catch {
        return `Lot bought ${allocation.lot.bought?.display}: too many decimal places`;
      }
      const held = toScaledBigInt(
        allocation.lot.sharesStillHeld?.exact?.value ?? '0',
        SHARE_SCALE,
      );
      if (picked > held) {
        return `Lot bought ${allocation.lot.bought?.display}: only ${allocation.lot.sharesStillHeld?.display} still held`;
      }
      sum += picked;
    }
    if (sum !== total) {
      return `Per-lot shares must sum to ${this.shares}`;
    }
    return null;
  }

  step2Valid(): boolean {
    return this.step2Error() === null;
  }

  pickedCount(): number {
    return this.allocations().filter(
      (a) => a.sellShares.trim() !== '' && a.sellShares.trim() !== '0',
    ).length;
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      await api.positions.recordSale({
        accountId: this.data.accountId,
        securityId: this.data.securityId,
        sold: civilFromJs(this.date!),
        shares: { value: this.shares.trim() },
        pricePerShare: { value: this.pricePerShare.trim() },
        saleCosts: { value: this.saleCosts.trim() },
        allocations: this.allocations()
          .filter((a) => a.sellShares.trim() !== '' && a.sellShares.trim() !== '0')
          .map((a) => ({ lotId: a.lot.lotId, shares: { value: a.sellShares.trim() } })),
      });
      this.notify.success('Sale recorded');
      this.ref.close(true);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
