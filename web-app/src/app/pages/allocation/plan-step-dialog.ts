import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import type { AccountSummary } from '../../../proto-gen/accounts_pb';
import type { SecurityListing } from '../../../proto-gen/securities_pb';
import {
  SellOrder,
  StepKind,
  type BuyCandidate,
  type PlanStepInput,
  type SellCandidate,
} from '../../../proto-gen/trading_plan_pb';
import { api } from '../../core/api';
import { isDecimalString } from '../../core/decimals';
import { Notify } from '../../core/notify';

/**
 * What the page hands the dialog. `className` opens the picker for a
 * class the human decided to sell from or buy into; `existing` edits a
 * step in place.
 */
export interface PlanStepDialogData {
  kind: StepKind;
  accounts: AccountSummary[];
  securities: SecurityListing[];
  className?: string;
  existing?: PlanStepInput;
}

/**
 * One plan step (docs/design/trading-plan.md). For a sell or buy
 * opened from a class row, the dialog first shows the candidate list -
 * every position that contributes to the class (Sell) or every
 * security carrying weight in it, in accounts with cash (Buy) - with
 * the computed consequences and the ordering stated in a caption.
 * Picking a row prefills account and security; the human types the
 * shares or dollars. The app orders facts; it does not choose.
 */
@Component({
  selector: 'app-plan-step-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTableModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ title() }}</h2>
    <mat-dialog-content class="step-form">
      @if (sellCandidates(); as rows) {
        <p class="caption">{{ sellCaption() }}</p>
        <mat-form-field appearance="outline" class="order">
          <mat-label>Order</mat-label>
          <mat-select [ngModel]="sellOrder()" (ngModelChange)="reorder($event)">
            <mat-option [value]="SellOrder.TAX_COST">Tax consequence</mat-option>
            <mat-option [value]="SellOrder.LARGEST_FIRST">Largest position first</mat-option>
            <mat-option [value]="SellOrder.BY_ACCOUNT">By account</mat-option>
            <mat-option [value]="SellOrder.NONE">None</mat-option>
          </mat-select>
        </mat-form-field>
        <table mat-table [dataSource]="rows" class="candidates">
          <ng-container matColumnDef="account">
            <th mat-header-cell *matHeaderCellDef>Account</th>
            <td mat-cell *matCellDef="let c">
              {{ c.accountName }}
              <span class="tag">{{ c.taxDeferred ? 'tax-deferred' : 'taxable' }}</span>
            </td>
          </ng-container>
          <ng-container matColumnDef="ticker">
            <th mat-header-cell *matHeaderCellDef>Security</th>
            <td mat-cell *matCellDef="let c">{{ c.ticker }} <span class="tag">{{ c.classWeight?.display }} in class</span></td>
          </ng-container>
          <ng-container matColumnDef="held">
            <th mat-header-cell *matHeaderCellDef class="num">Held</th>
            <td mat-cell *matCellDef="let c" class="num">{{ c.held?.display }}</td>
          </ng-container>
          <ng-container matColumnDef="value">
            <th mat-header-cell *matHeaderCellDef class="num">Value in class</th>
            <td mat-cell *matCellDef="let c" class="num">{{ c.valueInClass?.display }}</td>
          </ng-container>
          <ng-container matColumnDef="gain">
            <th mat-header-cell *matHeaderCellDef class="num">Est. gain if sold</th>
            <td mat-cell *matCellDef="let c" class="num">
              @if (c.taxDeferred) { no tax on sale }
              @else if (c.gainPerDollar) {
                {{ c.gainPerDollar.display }}
                <span class="tag">ST {{ c.estShortTermGain?.display }} / LT {{ c.estLongTermGain?.display }}</span>
                @if (c.nextLongTermDate) { <span class="tag">long-term from {{ c.nextLongTermDate.display }}</span> }
              } @else { - }
            </td>
          </ng-container>
          <ng-container matColumnDef="pick">
            <th mat-header-cell *matHeaderCellDef></th>
            <td mat-cell *matCellDef="let c">
              <button matButton (click)="pickSell(c)" [attr.aria-label]="'Sell ' + c.ticker + ' in ' + c.accountName">Sell...</button>
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="sellColumns"></tr>
          <tr mat-row *matRowDef="let row; columns: sellColumns"></tr>
        </table>
        @if (!rows.length) { <p class="empty-note">Nothing held contributes to {{ data.className }}.</p> }
      }
      @if (buyCandidates(); as rows) {
        <p class="caption">Ordered by available cash, grouped by account. Tax status is shown as a fact; where a purchase belongs is your call.</p>
        <table mat-table [dataSource]="rows" class="candidates">
          <ng-container matColumnDef="account">
            <th mat-header-cell *matHeaderCellDef>Account</th>
            <td mat-cell *matCellDef="let c">
              {{ c.accountName }}
              <span class="tag">{{ c.taxDeferred ? 'tax-deferred' : 'taxable' }}</span>
            </td>
          </ng-container>
          <ng-container matColumnDef="cash">
            <th mat-header-cell *matHeaderCellDef class="num">Available cash</th>
            <td mat-cell *matCellDef="let c" class="num">{{ c.availableSweep?.display }}</td>
          </ng-container>
          <ng-container matColumnDef="ticker">
            <th mat-header-cell *matHeaderCellDef>Security</th>
            <td mat-cell *matCellDef="let c">{{ c.ticker }} <span class="tag">{{ c.classWeight?.display }} in class</span></td>
          </ng-container>
          <ng-container matColumnDef="price">
            <th mat-header-cell *matHeaderCellDef class="num">Plan price</th>
            <td mat-cell *matCellDef="let c" class="num">{{ c.planPrice?.display }}</td>
          </ng-container>
          <ng-container matColumnDef="pick">
            <th mat-header-cell *matHeaderCellDef></th>
            <td mat-cell *matCellDef="let c">
              <button matButton (click)="pickBuy(c)" [attr.aria-label]="'Buy ' + c.ticker + ' in ' + c.accountName">Buy...</button>
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="buyColumns"></tr>
          <tr mat-row *matRowDef="let row; columns: buyColumns"></tr>
        </table>
        @if (!rows.length) { <p class="empty-note">No security carrying {{ data.className }} in an account with cash.</p> }
      }

      @if (showForm()) {
        <mat-form-field appearance="outline">
          <mat-label>{{ isTransfer() ? 'From account' : 'Account' }}</mat-label>
          <mat-select [(ngModel)]="accountId" required>
            @for (a of data.accounts; track a.accountId) {
              <mat-option [value]="a.accountId">{{ a.brokerName }} : {{ a.name }} ({{ a.currencyCode }}) - sweeps {{ a.sweepBalance?.display }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        @if (isTransfer()) {
          <mat-form-field appearance="outline">
            <mat-label>To account</mat-label>
            <mat-select [(ngModel)]="toAccountId" required>
              @for (a of data.accounts; track a.accountId) {
                <mat-option [value]="a.accountId">{{ a.brokerName }} : {{ a.name }} ({{ a.currencyCode }})</mat-option>
              }
            </mat-select>
          </mat-form-field>
        }
        @if (isTrade()) {
          <mat-form-field appearance="outline">
            <mat-label>Security</mat-label>
            <mat-select [(ngModel)]="securityId" required>
              @for (s of data.securities; track s.securityId) {
                <mat-option [value]="s.securityId">{{ s.ticker }}{{ s.description ? ' - ' + s.description : '' }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Enter by</mat-label>
            <mat-select [(ngModel)]="entry">
              <mat-option value="amount">Dollars</mat-option>
              <mat-option value="shares">Shares</mat-option>
            </mat-select>
          </mat-form-field>
        }
        @if (entry === 'shares' && isTrade()) {
          <mat-form-field appearance="outline">
            <mat-label>Shares</mat-label>
            <input matInput [(ngModel)]="shares" required>
            @if (!valid()) { <mat-error>Enter a positive decimal</mat-error> }
          </mat-form-field>
        } @else {
          <mat-form-field appearance="outline">
            <mat-label>Amount (account currency)</mat-label>
            <input matInput [(ngModel)]="amount" required>
            @if (!valid()) { <mat-error>Enter a positive decimal</mat-error> }
          </mat-form-field>
        }
        <mat-form-field appearance="outline">
          <mat-label>Note (optional)</mat-label>
          <input matInput [(ngModel)]="note" maxlength="255">
        </mat-form-field>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      @if (showForm()) {
        <button matButton="filled" [disabled]="!complete()" (click)="submit()">{{ data.existing ? 'Update step' : 'Add step' }}</button>
      }
    </mat-dialog-actions>
  `,
  styles: `
    .step-form { display: flex; flex-direction: column; min-width: 420px; max-width: 900px; }
    .caption { margin: 0 0 8px; font-size: 13px; opacity: 0.75; }
    .order { max-width: 260px; }
    .candidates { width: 100%; margin-bottom: 16px; }
    .num { text-align: right; }
    .tag { margin-left: 6px; font-size: 11px; opacity: 0.65; white-space: nowrap; }
    .empty-note { opacity: 0.7; }
  `,
})
export class PlanStepDialog {
  readonly data = inject<PlanStepDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<PlanStepDialog>);
  private readonly notify = inject(Notify);

  readonly SellOrder = SellOrder;
  readonly sellColumns = ['account', 'ticker', 'held', 'value', 'gain', 'pick'];
  readonly buyColumns = ['account', 'cash', 'ticker', 'price', 'pick'];

  readonly sellCandidates = signal<SellCandidate[] | undefined>(undefined);
  readonly sellCaption = signal('');
  readonly sellOrder = signal(SellOrder.TAX_COST);
  readonly buyCandidates = signal<BuyCandidate[] | undefined>(undefined);
  /** The form shows once a candidate is picked, or at once without a class. */
  readonly picked = signal(!this.data.className);

  accountId: bigint | undefined = this.data.existing?.accountId || undefined;
  toAccountId: bigint | undefined = this.data.existing?.toAccountId || undefined;
  securityId: bigint | undefined = this.data.existing?.securityId || undefined;
  entry: 'amount' | 'shares' = this.data.existing?.shares?.value ? 'shares' : 'amount';
  shares = this.data.existing?.shares?.value ?? '';
  amount = this.data.existing?.amount?.value ?? '';
  note = this.data.existing?.note ?? '';

  readonly isTrade = computed(() => this.data.kind === StepKind.STEP_BUY || this.data.kind === StepKind.STEP_SELL);
  readonly isTransfer = computed(() => this.data.kind === StepKind.STEP_TRANSFER);
  readonly showForm = computed(() => this.picked());

  readonly title = computed(() => {
    const what = {
      [StepKind.STEP_BUY]: 'Buy',
      [StepKind.STEP_SELL]: 'Sell',
      [StepKind.STEP_TRANSFER]: 'Transfer between accounts',
      [StepKind.STEP_ADD_EXTERNAL]: 'Add from outside',
      [StepKind.STEP_DRAW_EXTERNAL]: 'Draw to outside',
      [StepKind.STEP_KIND_UNSPECIFIED]: 'Step',
    }[this.data.kind];
    return this.data.className && !this.picked() ? `${what}: ${this.data.className}` : what;
  });

  constructor() {
    if (this.data.className && this.data.kind === StepKind.STEP_SELL) void this.loadSell();
    if (this.data.className && this.data.kind === StepKind.STEP_BUY) void this.loadBuy();
  }

  private async loadSell(): Promise<void> {
    try {
      const r = await api.plans.getSellCandidates({ className: this.data.className!, order: this.sellOrder() });
      this.sellCandidates.set(r.candidates);
      this.sellCaption.set(r.orderCaption);
    } catch (err) {
      this.notify.error(err);
    }
  }

  private async loadBuy(): Promise<void> {
    try {
      this.buyCandidates.set((await api.plans.getBuyCandidates({ className: this.data.className! })).candidates);
    } catch (err) {
      this.notify.error(err);
    }
  }

  async reorder(order: SellOrder): Promise<void> {
    this.sellOrder.set(order);
    await this.loadSell();
  }

  pickSell(c: SellCandidate): void {
    this.accountId = c.accountId;
    this.securityId = c.securityId;
    this.sellCandidates.set(undefined);
    this.picked.set(true);
  }

  pickBuy(c: BuyCandidate): void {
    this.accountId = c.accountId;
    this.securityId = c.securityId;
    this.entry = c.boughtInDollars ? 'amount' : 'shares';
    this.buyCandidates.set(undefined);
    this.picked.set(true);
  }

  /** The number field holds a positive decimal. */
  valid(): boolean {
    const raw = this.entry === 'shares' && this.isTrade() ? this.shares : this.amount;
    return isDecimalString(raw) && Number(raw) > 0;
  }

  complete(): boolean {
    if (!this.accountId || !this.valid()) return false;
    if (this.isTrade() && !this.securityId) return false;
    if (this.isTransfer() && (!this.toAccountId || this.toAccountId === this.accountId)) return false;
    return true;
  }

  submit(): void {
    const useShares = this.isTrade() && this.entry === 'shares';
    const step: PlanStepInput = {
      $typeName: 'finance.PlanStepInput',
      kind: this.data.kind,
      accountId: this.accountId!,
      toAccountId: this.isTransfer() ? this.toAccountId! : 0n,
      securityId: this.isTrade() ? this.securityId! : 0n,
      shares: useShares ? { $typeName: 'finance.Decimal', value: this.shares.trim() } : undefined,
      amount: useShares ? undefined : { $typeName: 'finance.Decimal', value: this.amount.trim() },
      note: this.note.trim(),
    };
    this.ref.close(step);
  }
}
