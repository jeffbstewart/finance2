import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import type { AccountSummary } from '../../../proto-gen/accounts_pb';
import type { ImportWarning } from '../../../proto-gen/imports_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';
import { PieChart, type PieSlice } from '../../shared/charts/pie-chart';
import { ImportWarnings } from '../../shared/imports/import-warnings';
import { AccountDialog } from './account-dialog';
import { BrokerDialog } from './broker-dialog';

/** Accounts at one broker (spec sec. 9.3): accounts table with totals,
 *  holdings pie, add/edit, hide-empty-brokerage, and the broker's
 *  unresolved import warnings (pipeline design sec. E). */
@Component({
  selector: 'app-broker-accounts-page',
  imports: [
    MatButtonModule,
    MatCardModule,
    MatDialogModule,
    MatIconModule,
    MatTableModule,
    MatTooltipModule,
    ImportWarnings,
    PieChart,
    RouterLink,
  ],
  templateUrl: './broker-accounts-page.html',
  styleUrl: './brokers-page.scss',
})
export class BrokerAccountsPage {
  /** Router param (withComponentInputBinding). */
  readonly id = input.required<string>();

  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);

  readonly accounts = signal<AccountSummary[]>([]);
  readonly brokerName = signal('');
  readonly totalInvestment = signal('');
  readonly totalSweeps = signal('');
  readonly warnings = signal<ImportWarning[]>([]);
  readonly columns = ['name', 'accountNumber', 'taxDeferred', 'sweep', 'investmentValue', 'actions'];

  private get brokerId(): bigint {
    return BigInt(this.id());
  }

  readonly slices = computed<PieSlice[]>(() =>
    this.accounts().map((a) => ({
      id: String(a.accountId),
      name: a.name,
      value: (a.investmentValue?.sortKey ?? 0) + (a.sweepBalance?.sortKey ?? 0),
      display: `${a.investmentValue?.display} + ${a.sweepBalance?.display} sweeps`,
    })),
  );

  readonly warningCounts = computed(() => {
    const counts = new Map<bigint, number>();
    for (const w of this.warnings()) counts.set(w.accountId, (counts.get(w.accountId) ?? 0) + 1);
    return counts;
  });

  warningCount(account: AccountSummary): number {
    return this.warningCounts().get(account.accountId) ?? 0;
  }

  // ngOnInit, not the constructor: required router inputs aren't
  // bound yet at construction (NG0950).
  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      const [response, warnings] = await Promise.all([
        api.accounts.listAccounts({ brokerId: this.brokerId }),
        api.imports.listImportWarnings({ brokerId: this.brokerId }),
      ]);
      this.accounts.set(response.accounts);
      this.warnings.set(warnings.warnings);
      this.brokerName.set(response.accounts[0]?.brokerName ?? '');
      this.totalInvestment.set(response.totalInvestmentValue?.display ?? '');
      this.totalSweeps.set(response.totalSweeps?.display ?? '');
      if (!response.accounts.length) {
        const brokers = await api.brokers.listBrokers({ includeHidden: true });
        this.brokerName.set(
          brokers.brokers.find((b) => b.brokerId === this.brokerId)?.name ?? '',
        );
      }
    } catch (err) {
      this.notify.error(err);
    }
  }

  addAccount(): void {
    this.dialog
      .open(AccountDialog, { data: { brokerId: this.brokerId } })
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }

  editAccount(account: AccountSummary): void {
    this.dialog
      .open(AccountDialog, { data: { brokerId: this.brokerId, account } })
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }

  editBroker(): void {
    this.dialog
      .open(BrokerDialog, { data: { brokerId: this.brokerId, name: this.brokerName() } })
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }

  async hideBroker(): Promise<void> {
    try {
      await api.brokers.setBrokerHidden({ brokerId: this.brokerId, hidden: true });
      this.notify.success('Brokerage hidden');
      await this.router.navigateByUrl('/brokers');
    } catch (err) {
      this.notify.error(err);
    }
  }

  openAccount(slice: PieSlice): void {
    void this.router.navigate(['/positions'], { queryParams: { account: slice.id } });
  }
}
