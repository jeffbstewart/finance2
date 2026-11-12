import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import type { AccountSummary } from '../../../proto-gen/accounts_pb';
import {
  ReportSeverity,
  SecurityMatch,
  SnapshotStatus,
  type PlaidAccountView,
  type PlaidSecurityView,
  type SnapshotRow,
} from '../../../proto-gen/imports_pb';
import { SecurityType, type SecurityListing } from '../../../proto-gen/securities_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';
import { AddSecurityDialog, type AddSecurityDialogData } from '../securities/add-security-dialog';

/**
 * bankferry snapshot imports (pipeline design, amended 2026-08-20):
 * upload through the session, archive, link Plaid accounts, and run
 * the freely repeatable processor. Everything here is revisitable - 
 * fix lots or create the missing account, then process again.
 * Securities Plaid reports without a ticker (401(k) trust funds) are
 * linked to a finance2 security here the same way accounts are.
 */
@Component({
  selector: 'app-imports-page',
  imports: [MatButtonModule, MatCardModule, MatDialogModule, MatIconModule, MatSelectModule, MatTableModule],
  templateUrl: './imports-page.html',
  styleUrl: './imports-page.scss',
})
export class ImportsPage {
  private readonly notify = inject(Notify);
  private readonly dialog = inject(MatDialog);

  readonly snapshots = signal<SnapshotRow[]>([]);
  readonly selected = signal<SnapshotRow | undefined>(undefined);
  readonly plaidAccounts = signal<PlaidAccountView[]>([]);
  readonly localAccounts = signal<AccountSummary[]>([]);
  readonly plaidSecurities = signal<PlaidSecurityView[]>([]);
  readonly localSecurities = signal<SecurityListing[]>([]);
  readonly busy = signal(false);
  readonly columns = ['filename', 'asOf', 'uploaded', 'status', 'processed', 'actions'];
  readonly accountColumns = ['institution', 'plaidName', 'kind', 'holdings', 'link'];
  readonly securityColumns = ['securityName', 'identifiers', 'securityType', 'accounts', 'securityLink'];

  readonly SnapshotStatus = SnapshotStatus;
  readonly ReportSeverity = ReportSeverity;
  readonly SecurityMatch = SecurityMatch;
  /** Template-safe bigint zero - Angular templates can't write 0n. */
  readonly UNLINKED = BigInt(0);

  readonly reportLines = computed(() => this.selected()?.report?.lines ?? []);

  constructor() {
    void this.reload();
  }

  async reload(selectId?: bigint): Promise<void> {
    try {
      const [snapshots, accounts, securities] = await Promise.all([
        api.imports.listSnapshots({}),
        api.accounts.listAccounts({ includeHidden: true }),
        api.securities.listSecurities({ includeHidden: true }),
      ]);
      this.snapshots.set(snapshots.snapshots);
      this.localAccounts.set(accounts.accounts);
      this.localSecurities.set(securities.securities);
      const keep = selectId ?? this.selected()?.snapshotId;
      const selected = snapshots.snapshots.find((s) => s.snapshotId === keep);
      this.selected.set(selected);
      if (selected) await this.loadPanels(selected);
      else {
        this.plaidAccounts.set([]);
        this.plaidSecurities.set([]);
      }
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
      this.notify.success(`${file.name} archived - link accounts, then process`);
      await this.reload(response.snapshot?.snapshotId);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async select(row: SnapshotRow): Promise<void> {
    this.selected.set(row);
    await this.loadPanels(row);
  }

  private async loadPanels(row: SnapshotRow): Promise<void> {
    await Promise.all([this.loadAccounts(row), this.loadSecurities(row)]);
  }

  private async loadAccounts(row: SnapshotRow): Promise<void> {
    try {
      const response = await api.imports.getSnapshotAccounts({ snapshotId: row.snapshotId });
      this.plaidAccounts.set(response.accounts);
    } catch (err) {
      this.notify.error(err);
    }
  }

  private async loadSecurities(row: SnapshotRow): Promise<void> {
    try {
      const response = await api.imports.getSnapshotSecurities({ snapshotId: row.snapshotId });
      this.plaidSecurities.set(response.securities);
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
        `Processed - ${report?.holdingsUpdated ?? 0} holding(s), ${report?.sweepsUpdated ?? 0} sweep(s) updated` +
          (report?.pricesRecorded ? `, ${report.pricesRecorded} price(s) recorded` : ''),
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
      this.notify.success(accountId ? 'Account linked - process to import' : 'Link removed');
      const selected = this.selected();
      if (selected) await this.loadAccounts(selected);
    } catch (err) {
      this.notify.error(err);
    }
  }

  async securityLinkChanged(plaidSecurity: PlaidSecurityView, securityId: bigint): Promise<void> {
    try {
      await api.imports.linkPlaidSecurity({
        plaidSecurityId: plaidSecurity.plaidSecurityId,
        securityId,
      });
      this.notify.success(securityId ? 'Security linked - process to import' : 'Link removed');
      const selected = this.selected();
      if (selected) await this.loadSecurities(selected);
    } catch (err) {
      this.notify.error(err);
    }
  }

  /** Opens the add dialog prefilled from the Plaid row (sec. 6.3: still
   *  human-created); on save the dialog links the new security to the
   *  row, so only the securities panel needs re-reading. */
  addSecurityFor(plaidSecurity: PlaidSecurityView): void {
    const data: AddSecurityDialogData = {
      ticker: plaidSecurity.ticker ? plaidSecurity.ticker : '',
      description: plaidSecurity.name,
      currencyCode: plaidSecurity.currencyCode || 'USD',
      cusip: plaidSecurity.cusip,
      hasPublicTicker: !!plaidSecurity.ticker,
      securityType: plaidSecurity.ticker ? SecurityType.SECURITY_TYPE_UNSPECIFIED : SecurityType.COLLECTIVE_TRUST,
      plaidSecurityId: plaidSecurity.plaidSecurityId,
    };
    this.dialog
      .open(AddSecurityDialog, { data })
      .afterClosed()
      .subscribe((created) => {
        if (!created) return;
        void this.reload(this.selected()?.snapshotId);
      });
  }

  /** Ticker / CUSIP as Plaid reported them; "no ticker" is the whole
   *  reason the securities panel exists. */
  identifiers(security: PlaidSecurityView): string {
    const parts = [security.ticker, security.cusip ? `CUSIP ${security.cusip}` : ''].filter(Boolean);
    return parts.length ? parts.join(' | ') : 'no ticker';
  }

  securityLabel(security: SecurityListing): string {
    return security.description ? `${security.ticker} - ${security.description}` : security.ticker;
  }

  accountLabel(account: AccountSummary): string {
    return `${account.brokerName} : ${account.name} (${account.currencyCode})`;
  }

  severityIcon(severity: ReportSeverity): string {
    return severity === ReportSeverity.WARNING ? 'warning' : 'info';
  }
}
