import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { Router, RouterLink } from '@angular/router';
import type { AccountSummary } from '../../../proto-gen/accounts_pb';
import type { ImportWarning } from '../../../proto-gen/imports_pb';
import type { PositionRow } from '../../../proto-gen/positions_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';
import { PieChart, type PieSlice } from '../../shared/charts/pie-chart';
import { Sparkline } from '../../shared/charts/sparkline';
import { ImportWarnings } from '../../shared/imports/import-warnings';
import { AccountDialog } from '../brokers/account-dialog';
import { BuyDialog } from './buy-dialog';
import { HoldingDialog } from './holding-dialog';

/**
 * Positions (spec sec. 9.5-sec. 9.6): one page for both scopes. With the
 * `account` query param it is "Positions at {broker} : {account}";
 * without, the portfolio-wide list (server sorts by current value
 * descending). Tax-deferred accounts enter position-level holdings
 * instead of purchases (build-scope sec. 1). The account scope also shows
 * the account's unresolved import warnings (pipeline design sec. E).
 */
@Component({
  selector: 'app-positions-page',
  imports: [
    MatButtonModule,
    MatCardModule,
    MatDialogModule,
    MatIconModule,
    MatTableModule,
    ImportWarnings,
    PieChart,
    RouterLink,
    Sparkline,
  ],
  templateUrl: './positions-page.html',
  styleUrl: './positions-page.scss',
})
export class PositionsPage {
  /** Optional `account` query param (withComponentInputBinding). */
  readonly account = input('');

  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);

  readonly positions = signal<PositionRow[]>([]);
  readonly scopedAccount = signal<AccountSummary | undefined>(undefined);
  readonly warnings = signal<ImportWarning[]>([]);
  readonly totalBasis = signal('');
  readonly totalValue = signal('');
  readonly totalStGain = signal('');
  readonly totalLtGain = signal('');
  readonly columns = ['ticker', 'sparkline', 'shares', 'basis', 'value', 'stGain', 'ltGain', 'actions'];

  readonly accountId = computed<bigint>(() => (this.account() ? BigInt(this.account()) : 0n));

  readonly title = computed(() => {
    const account = this.scopedAccount();
    return account
      ? `Positions at ${account.brokerName} : ${account.name}`
      : 'Positions in All Accounts';
  });

  readonly slices = computed<PieSlice[]>(() =>
    this.positions().map((p) => ({
      id: String(p.securityId),
      name: p.ticker,
      value: p.currentValue?.sortKey ?? 0,
      display: p.currentValue?.display ?? '',
    })),
  );

  // ngOnInit, not the constructor: router inputs aren't bound yet at
  // construction (NG0950).
  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      const accountId = this.accountId();
      const [positions, account, warnings] = await Promise.all([
        api.positions.listPositions({ accountId }),
        accountId ? api.accounts.getAccount({ accountId }) : Promise.resolve(undefined),
        accountId ? api.imports.listImportWarnings({ accountId }) : Promise.resolve(undefined),
      ]);
      this.positions.set(positions.positions);
      this.totalBasis.set(positions.totalBasis?.display ?? '');
      this.totalValue.set(positions.totalValue?.display ?? '');
      this.totalStGain.set(positions.totalShortTermGain?.display ?? '');
      this.totalLtGain.set(positions.totalLongTermGain?.display ?? '');
      this.scopedAccount.set(account?.account);
      this.warnings.set(warnings?.warnings ?? []);
    } catch (err) {
      this.notify.error(err);
    }
  }

  /** Six-month adjusted closes as chart geometry (presentation only). */
  trend(position: PositionRow): number[] {
    return (position.sparkline?.adjustedCloses ?? []).map((d) => Number(d.value));
  }

  lotLink(position: PositionRow): unknown[] {
    return ['/positions', String(position.securityId)];
  }

  lotQuery(): Record<string, string> {
    return this.account() ? { account: this.account() } : {};
  }

  add(): void {
    const account = this.scopedAccount();
    if (account?.taxDeferred) {
      this.dialog
        .open(HoldingDialog, { data: { account } })
        .afterClosed()
        .subscribe((changed) => changed && void this.reload());
    } else {
      this.dialog
        .open(BuyDialog, { data: { accountId: this.accountId() || undefined } })
        .afterClosed()
        .subscribe((changed) => changed && void this.reload());
    }
  }

  editAccount(): void {
    const account = this.scopedAccount();
    if (!account) return;
    this.dialog
      .open(AccountDialog, { data: { brokerId: account.brokerId, account } })
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }

  async hideAccount(): Promise<void> {
    const account = this.scopedAccount();
    if (!account) return;
    try {
      await api.accounts.setAccountHidden({ accountId: account.accountId, hidden: true });
      this.notify.success('Account hidden');
      await this.router.navigate(['/brokers', String(account.brokerId)]);
    } catch (err) {
      this.notify.error(err);
    }
  }

  async deleteAccount(): Promise<void> {
    const account = this.scopedAccount();
    if (!account) return;
    if (!confirm(`Delete account ${account.name}? This cannot be undone.`)) return;
    try {
      await api.accounts.deleteAccount({ accountId: account.accountId });
      this.notify.success('Account deleted');
      await this.router.navigate(['/brokers', String(account.brokerId)]);
    } catch (err) {
      this.notify.error(err);
    }
  }

  openSecurity(slice: PieSlice): void {
    void this.router.navigate(['/positions', slice.id], { queryParams: this.lotQuery() });
  }
}
