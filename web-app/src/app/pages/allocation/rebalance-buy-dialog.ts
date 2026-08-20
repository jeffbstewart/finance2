import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { CandidateFund, RebalanceClass } from '../../../proto-gen/allocation_pb';
import { divDecimal, isDecimalString, mulDecimal } from '../../core/decimals';

export interface RebalanceBuyDialogData {
  rebalanceClass: RebalanceClass;
}

/** What the dialog hands back to the planner's cart. */
export interface ProposedTrade {
  securityId: bigint;
  ticker: string;
  shares: string;
  cost: string;
}

/**
 * Rebalance-Buy (spec §9.14): pick from the class's candidate funds
 * (weight ≥ 0.9); the suggestion auto-fills, then Shares and Net Cost
 * mutually update through the read-only price — exact decimal
 * arithmetic, no floats. Nothing is persisted; the trade goes to the
 * cart.
 */
@Component({
  selector: 'app-rebalance-buy-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <h2 mat-dialog-title>Propose Security Purchase for Rebalance</h2>
    <mat-dialog-content class="rebalance-buy-form">
      <mat-form-field appearance="outline">
        <mat-label>Security</mat-label>
        <mat-select [ngModel]="candidate()" (ngModelChange)="pick($event)">
          @for (c of data.rebalanceClass.candidates; track c.securityId) {
            <mat-option [value]="c">
              {{ c.ticker }} — {{ c.classWeight?.display }} in {{ data.rebalanceClass.name }}
            </mat-option>
          }
        </mat-select>
      </mat-form-field>
      @if (candidate(); as c) {
        <mat-form-field appearance="outline">
          <mat-label>Price Per Share</mat-label>
          <input matInput [value]="c.pricePerShare?.display ?? ''" readonly>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Shares</mat-label>
          <input matInput [ngModel]="shares()" (ngModelChange)="sharesEdited($event)">
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Net Cost</mat-label>
          <input matInput [ngModel]="cost()" (ngModelChange)="costEdited($event)">
        </mat-form-field>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="!valid()" (click)="submit()">Add to Plan</button>
    </mat-dialog-actions>
  `,
  styles: '.rebalance-buy-form { display: flex; flex-direction: column; min-width: 380px; }',
})
export class RebalanceBuyDialog {
  readonly data = inject<RebalanceBuyDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<RebalanceBuyDialog>);

  readonly candidate = signal<CandidateFund | undefined>(undefined);
  readonly shares = signal('');
  readonly cost = signal('');

  private price(): string {
    return this.candidate()?.pricePerShare?.exact?.amount?.value ?? '0';
  }

  pick(candidate: CandidateFund): void {
    this.candidate.set(candidate);
    this.shares.set(candidate.suggestedShares?.value ?? '');
    this.cost.set(candidate.cost?.exact?.amount?.value ?? '');
  }

  sharesEdited(value: string): void {
    this.shares.set(value);
    if (isDecimalString(value) && this.price() !== '0') {
      this.cost.set(mulDecimal(value.trim(), this.price(), 4));
    }
  }

  costEdited(value: string): void {
    this.cost.set(value);
    if (isDecimalString(value) && this.price() !== '0') {
      this.shares.set(divDecimal(value.trim(), this.price(), 8));
    }
  }

  valid(): boolean {
    return (
      this.candidate() !== undefined &&
      isDecimalString(this.shares()) &&
      isDecimalString(this.cost())
    );
  }

  submit(): void {
    const candidate = this.candidate()!;
    const trade: ProposedTrade = {
      securityId: candidate.securityId,
      ticker: candidate.ticker,
      shares: this.shares().trim(),
      cost: this.cost().trim(),
    };
    this.ref.close(trade);
  }
}
