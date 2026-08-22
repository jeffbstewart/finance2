import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { Router, RouterLink } from '@angular/router';
import type { AccountSummary } from '../../../proto-gen/accounts_pb';
import type { GetLotDetailsResponse, LotRow, SaleRow } from '../../../proto-gen/positions_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';
import { BuyDialog } from './buy-dialog';
import { SellDialog } from './sell-dialog';

/**
 * Lot details (spec sec. 9.7; sec. 9.11 when unscoped): the ticker's lots with
 * a select column feeding the Sell stepper, per-lot edit/delete, the
 * sale history legacy fetched but never rendered, and the
 * inflation-adjusted cost toggle (*-footnoted columns). Unscoped adds
 * the Account column and the hide-security affordance when no
 * positions remain.
 */
@Component({
  selector: 'app-lot-details-page',
  imports: [
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatDialogModule,
    MatIconModule,
    MatSlideToggleModule,
    MatTableModule,
    RouterLink,
  ],
  templateUrl: './lot-details-page.html',
  styleUrl: './positions-page.scss',
})
export class LotDetailsPage {
  /** Router param: the security (withComponentInputBinding). */
  readonly id = input.required<string>();
  /** Optional `account` query param; absent = all accounts (sec. 9.11). */
  readonly account = input('');

  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);

  readonly details = signal<GetLotDetailsResponse | undefined>(undefined);
  readonly ticker = signal('');
  readonly scopedAccount = signal<AccountSummary | undefined>(undefined);
  readonly inflationAdjusted = signal(false);
  readonly selected = signal<ReadonlySet<bigint>>(new Set());

  readonly securityId = computed<bigint>(() => BigInt(this.id()));
  readonly accountId = computed<bigint>(() => (this.account() ? BigInt(this.account()) : 0n));

  readonly lots = computed<LotRow[]>(() => this.details()?.lots ?? []);
  readonly sales = computed<SaleRow[]>(() => this.details()?.sales ?? []);
  readonly openLots = computed(() =>
    this.lots().filter((lot) => (lot.sharesStillHeld?.sortKey ?? 0) > 0),
  );

  readonly title = computed(() => {
    const account = this.scopedAccount();
    return account
      ? `Positions for ${this.ticker()} in ${account.brokerName} : ${account.name}`
      : `Positions for ${this.ticker()} in All Accounts`;
  });

  readonly columns = computed<string[]>(() => {
    const base = [
      'select', 'bought', 'shares', 'buyPrice', 'nowPrice', 'commission',
      'stillHeld', 'basis', 'value', 'stGain', 'ltGain', 'actions',
    ];
    return this.account() ? base : ['select', 'account', ...base.slice(1)];
  });

  readonly saleColumns = ['sold', 'saleShares', 'salePrice', 'saleCosts', 'saleStGain', 'saleLtGain', 'saleActions'];

  /** * marks cost columns restated in today's dollars (spec sec. 9.11). */
  readonly dagger = computed(() => (this.details()?.inflationAdjusted ? ' *' : ''));

  // ngOnInit, not the constructor: router inputs aren't bound yet at
  // construction (NG0950).
  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      const accountId = this.accountId();
      const [details, security, account] = await Promise.all([
        api.positions.getLotDetails({
          securityId: this.securityId(),
          accountId,
          inflationAdjusted: this.inflationAdjusted(),
        }),
        api.securities.getSecurityDetails({ securityId: this.securityId() }),
        accountId ? api.accounts.getAccount({ accountId }) : Promise.resolve(undefined),
      ]);
      this.details.set(details);
      this.ticker.set(security.security?.ticker ?? '');
      this.scopedAccount.set(account?.account);
      this.selected.set(new Set());
    } catch (err) {
      this.notify.error(err);
    }
  }

  toggleInflation(on: boolean): void {
    this.inflationAdjusted.set(on);
    void this.reload();
  }

  isSelected(lot: LotRow): boolean {
    return this.selected().has(lot.lotId);
  }

  toggleLot(lot: LotRow, checked: boolean): void {
    const next = new Set(this.selected());
    if (checked) next.add(lot.lotId);
    else next.delete(lot.lotId);
    this.selected.set(next);
  }

  sell(): void {
    const lots = this.lots().filter((lot) => this.selected().has(lot.lotId));
    if (!lots.length) return;
    // Selling happens within one account; the unscoped view can pick
    // lots from one account only.
    const accountIds = new Set(lots.map((lot) => lot.accountId));
    if (accountIds.size > 1) {
      this.notify.info('Pick lots from a single account to sell');
      return;
    }
    this.dialog
      .open(SellDialog, {
        data: {
          securityId: this.securityId(),
          accountId: lots[0].accountId,
          ticker: this.ticker(),
          accountName: this.scopedAccount()?.name ?? lots[0].accountName,
          brokerName: this.scopedAccount()?.brokerName ?? '',
          lots,
        },
      })
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }

  buy(): void {
    this.dialog
      .open(BuyDialog, {
        data: {
          accountId: this.accountId() || undefined,
          securityId: this.securityId(),
        },
      })
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }

  editLot(lot: LotRow): void {
    this.dialog
      .open(BuyDialog, { data: { lot } })
      .afterClosed()
      .subscribe((changed) => changed && void this.reload());
  }

  async deleteLot(lot: LotRow): Promise<void> {
    if (!confirm(`Delete the ${lot.bought?.display} lot of ${lot.shares?.display} shares?`)) {
      return;
    }
    try {
      await api.positions.deletePurchase({ lotId: lot.lotId });
      this.notify.success('Lot deleted');
      await this.reload();
    } catch (err) {
      this.notify.error(err);
    }
  }

  async deleteSale(sale: SaleRow): Promise<void> {
    if (!confirm(`Delete the ${sale.sold?.display} sale of ${sale.shares?.display} shares?`)) {
      return;
    }
    try {
      await api.positions.deleteSale({ saleId: sale.saleId });
      this.notify.success('Sale deleted');
      await this.reload();
    } catch (err) {
      this.notify.error(err);
    }
  }

  async hideSecurity(): Promise<void> {
    try {
      await api.securities.setSecurityHidden({ securityId: this.securityId(), hidden: true });
      this.notify.success(`${this.ticker()} hidden`);
      await this.router.navigate(['/securities']);
    } catch (err) {
      this.notify.error(err);
    }
  }
}
