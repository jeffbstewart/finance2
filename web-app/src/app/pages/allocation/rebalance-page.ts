import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { TradeSide, type RebalanceClass, type ScoreRebalanceResponse } from '../../../proto-gen/allocation_pb';
import type { AccountChoice } from '../../../proto-gen/positions_pb';
import { api } from '../../core/api';
import { isDecimalString } from '../../core/decimals';
import { Notify } from '../../core/notify';
import { RebalanceBuyDialog, type ProposedTrade } from './rebalance-buy-dialog';

/**
 * Rebalance planner (spec §9.14, §5.5): pick the destination account
 * (its sweeps fund the plan), optionally add hypothetical funds, and
 * build a buy-side cart. Every change re-scores on the server —
 * nothing here persists anything. Zero added funds = buy-only mode:
 * the server sizes the plan so the most overweight class reaches
 * target without selling.
 */
@Component({
  selector: 'app-rebalance-page',
  imports: [
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTableModule,
  ],
  templateUrl: './rebalance-page.html',
  styleUrl: './allocation-page.scss',
})
export class RebalancePage {
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);

  readonly accounts = signal<AccountChoice[]>([]);
  readonly accountId = signal<bigint | undefined>(undefined);
  readonly addedFunds = signal('0');
  readonly cart = signal<ProposedTrade[]>([]);
  readonly score = signal<ScoreRebalanceResponse | undefined>(undefined);
  readonly cartColumns = ['ticker', 'shares', 'cost', 'actions'];
  readonly classColumns = ['name', 'before', 'after', 'target', 'residual', 'actions'];

  constructor() {
    void this.loadAccounts();
  }

  private async loadAccounts(): Promise<void> {
    try {
      const info = await api.positions.getPurchaseFormInfo({});
      this.accounts.set(info.accounts);
      if (info.accounts.length === 1) {
        this.accountId.set(info.accounts[0].accountId);
        await this.rescore();
      }
    } catch (err) {
      this.notify.error(err);
    }
  }

  async accountPicked(accountId: bigint): Promise<void> {
    this.accountId.set(accountId);
    await this.rescore();
  }

  fundsValid(): boolean {
    return isDecimalString(this.addedFunds());
  }

  async rescore(): Promise<void> {
    const accountId = this.accountId();
    if (accountId === undefined || !this.fundsValid()) return;
    try {
      this.score.set(
        await api.allocation.scoreRebalance({
          accountId,
          addedFunds: { value: this.addedFunds().trim() },
          trades: this.cart().map((t) => ({
            side: TradeSide.BUY,
            securityId: t.securityId,
            shares: { value: t.shares },
            cost: { value: t.cost },
          })),
        }),
      );
    } catch (err) {
      this.notify.error(err);
    }
  }

  buy(rebalanceClass: RebalanceClass): void {
    this.dialog
      .open(RebalanceBuyDialog, { data: { rebalanceClass } })
      .afterClosed()
      .subscribe((trade: ProposedTrade | undefined) => {
        if (!trade) return;
        this.cart.set([...this.cart(), trade]);
        void this.rescore();
      });
  }

  remove(trade: ProposedTrade): void {
    this.cart.set(this.cart().filter((t) => t !== trade));
    void this.rescore();
  }
}
