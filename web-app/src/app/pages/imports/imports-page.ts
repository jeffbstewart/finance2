import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import type { AccountSummary } from '../../../proto-gen/accounts_pb';
import {
  ReportSeverity,
  SnapshotStatus,
  type PlaidAccountView,
  type SnapshotRow,
} from '../../../proto-gen/imports_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';

/**
 * bankferry snapshot imports (pipeline design, amended 2026-08-20):
 * upload through the session, archive, link Plaid accounts, and run
 * the freely repeatable processor. Everything here is revisitable —
 * fix lots or create the missing account, then process again.
 */
@Component({
  selector: 'app-imports-page',
  imports: [MatButtonModule, MatCardModule, MatIconModule, MatSelectModule, MatTableModule],
  templateUrl: './imports-page.html',
  styleUrl: './imports-page.scss',
})
export class ImportsPage {
  private readonly notify = inject(Notify);

  readonly snapshots = signal<SnapshotRow[]>([]);
  readonly selected = signal<SnapshotRow | undefined>(undefined);
  readonly plaidAccounts = signal<PlaidAccountView[]>([]);
  readonly localAccounts = signal<AccountSummary[]>([]);
  readonly busy = signal(false);
  readonly columns = ['filename', 'asOf', 'uploaded', 'status', 'processed', 'actions'];
  readonly accountColumns = ['institution', 'plaidName', 'kind', 'holdings', 'link'];

  readonly SnapshotStatus = SnapshotStatus;
  readonly ReportSeverity = ReportSeverity;
  /** Template-safe bigint zero — Angular templates can't write 0n. */
  readonly UNLINKED = BigInt(0);

  readonly reportLines = computed(() => this.selected()?.report?.lines ?? []);

  constructor() {
    void this.reload();
  }

  async reload(selectId?: bigint): Promise<void> {
    try {
      const [snapshots, accounts] = await Promise.all([
        api.imports.listSnapshots({}),
        api.accounts.listAccounts({ includeHidden: true }),
      ]);
      this.snapshots.set(snapshots.snapshots);
      this.localAccounts.set(accounts.accounts);
      const keep = selectId ?? this.selected()?.snapshotId;
      const selected = snapshots.snapshots.find((s) => s.snapshotId === keep);
      this.selected.set(selected);
      if (selected) await this.loadAccounts(selected);
      else this.plaidAccounts.set([]);
    } catch (err) {
      this.notify.error(err);
    }
  }

  statusLabel(row: SnapshotRow): string {
    switch (row.status) {
      case SnapshotStatus.UPLOADED: return 'Uploaded';
      case SnapshotStatus.PROCESSED: return 'Processed';
      case SnapshotStatus.FAILED: return 'Failed';
      default: return '';
    }
  }

  timestamp(iso: string): string {
    return iso ? iso.replace('T', ' ').replace(/\.\d+/, '').replace(/([+-]\d\d:\d\d|Z)$/, '') : '';
  }

  async fileChosen(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.busy.set(true);
    try {
      const content = new Uint8Array(await file.arrayBuffer());
      const response = await api.imports.uploadSnapshot({ content, filename: file.name });
      this.notify.success(`${file.name} archived — link accounts, then process`);
      await this.reload(response.snapshot?.snapshotId);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async select(row: SnapshotRow): Promise<void> {
    this.selected.set(row);
    await this.loadAccounts(row);
  }

  private async loadAccounts(row: SnapshotRow): Promise<void> {
    try {
      const response = await api.imports.getSnapshotAccounts({ snapshotId: row.snapshotId });
      this.plaidAccounts.set(response.accounts);
    } catch (err) {
      this.notify.error(err);
    }
  }

  async process(row: SnapshotRow): Promise<void> {
    this.busy.set(true);
    try {
      const response = await api.imports.processSnapshot({ snapshotId: row.snapshotId });
      const report = response.snapshot?.report;
      this.notify.success(
        `Processed — ${report?.holdingsUpdated ?? 0} holding(s), ${report?.sweepsUpdated ?? 0} sweep(s) updated`,
      );
      await this.reload(row.snapshotId);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async deleteSnapshot(row: SnapshotRow): Promise<void> {
    if (!confirm(`Delete ${row.filename} (uploaded ${this.timestamp(row.uploadedAt)})?`)) return;
    try {
      await api.imports.deleteSnapshot({ snapshotId: row.snapshotId });
      this.notify.success('Snapshot deleted');
      if (this.selected()?.snapshotId === row.snapshotId) this.selected.set(undefined);
      await this.reload();
    } catch (err) {
      this.notify.error(err);
    }
  }

  async linkChanged(plaidAccount: PlaidAccountView, accountId: bigint): Promise<void> {
    try {
      await api.imports.linkPlaidAccount({ accountRef: plaidAccount.accountRef, accountId });
      this.notify.success(accountId ? 'Account linked — process to import' : 'Link removed');
      const selected = this.selected();
      if (selected) await this.loadAccounts(selected);
    } catch (err) {
      this.notify.error(err);
    }
  }

  accountLabel(account: AccountSummary): string {
    return `${account.brokerName} : ${account.name} (${account.currencyCode})`;
  }

  severityIcon(severity: ReportSeverity): string {
    return severity === ReportSeverity.WARNING ? 'warning' : 'info';
  }
}
