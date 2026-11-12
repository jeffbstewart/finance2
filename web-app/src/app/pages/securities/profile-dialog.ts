import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import {
  PricingLocus,
  SecurityType,
  TaxTreatment,
  type SecurityListing,
  type SecurityProfile,
} from '../../../proto-gen/securities_pb';
import { api } from '../../core/api';
import { isDecimalString } from '../../core/decimals';
import { Notify } from '../../core/notify';

export interface ProfileDialogData {
  security: SecurityProfile;
  /** Other securities of the portfolio, offered as the mirror target.
   *  Absent (older callers) hides the mirror field. */
  mirrorCandidates?: SecurityListing[];
}

/**
 * Edit the security profile (spec sec. 9.10 header affordances; sec. 6.3 - all
 * fields hand-maintained, no auto-population). The type drives
 * dollar-vs-share purchases in the rebalance planner, and the pricing
 * locus decides market vs private pricing, so both live here. Under
 * MARKET pricing the provider symbol can differ from the local one;
 * a trust fund can name the public fund it mirrors.
 */
@Component({
  selector: 'app-profile-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <h2 mat-dialog-title>Edit {{ data.security.ticker }}</h2>
    <mat-dialog-content class="profile-form">
      <mat-form-field appearance="outline">
        <mat-label>Symbol</mat-label>
        <input matInput [(ngModel)]="ticker" required>
        <mat-hint>Renaming is safe: lots, holdings, prices, and links follow the security, not the symbol</mat-hint>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Description</mat-label>
        <input matInput [(ngModel)]="description" cdkFocusInitial>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Security Type</mat-label>
        <mat-select [(ngModel)]="securityType">
          <mat-option [value]="SecurityType.STOCK">Stock</mat-option>
          <mat-option [value]="SecurityType.ETF">ETF</mat-option>
          <mat-option [value]="SecurityType.MUTUAL_FUND">Mutual Fund</mat-option>
          <mat-option [value]="SecurityType.COLLECTIVE_TRUST">Collective Trust</mat-option>
          <mat-option [value]="SecurityType.PRIVATE_INVESTMENT">Private Investment</mat-option>
        </mat-select>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Pricing</mat-label>
        <mat-select [(ngModel)]="pricingLocus">
          <mat-option [value]="PricingLocus.MARKET">Market (provider quotes)</mat-option>
          <mat-option [value]="PricingLocus.MANUAL">Manual (private price history)</mat-option>
        </mat-select>
      </mat-form-field>
      @if (pricingLocus === PricingLocus.MARKET) {
        <mat-form-field appearance="outline">
          <mat-label>Provider symbol (blank: same as {{ data.security.ticker }})</mat-label>
          <input matInput [(ngModel)]="marketTicker">
        </mat-form-field>
      }
      <mat-form-field appearance="outline">
        <mat-label>Tax Treatment</mat-label>
        <mat-select [(ngModel)]="taxTreatment">
          <mat-option [value]="TaxTreatment.LOTS">Purchase lots (capital gains)</mat-option>
          <mat-option [value]="TaxTreatment.MARK_TO_MARKET">
            Mark-to-market (PFIC sec. 1296, ordinary income)
          </mat-option>
        </mat-select>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Net Expense Ratio (fraction, e.g. 0.0004)</mat-label>
        <input matInput [(ngModel)]="netExpenseRatio">
        @if (!ratioValid()) {
          <mat-error>Enter a plain decimal like 0.0004</mat-error>
        }
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>CUSIP</mat-label>
        <input matInput [(ngModel)]="cusip">
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>ISIN</mat-label>
        <input matInput [(ngModel)]="isin">
      </mat-form-field>
      @if (data.mirrorCandidates) {
        <mat-form-field appearance="outline">
          <mat-label>Mirrors</mat-label>
          <mat-select [(ngModel)]="mirrorsSecurityId">
            <mat-option [value]="NONE">None</mat-option>
            @for (c of candidates(); track c.securityId) {
              <mat-option [value]="c.securityId">{{ c.ticker }}{{ c.description ? ' - ' + c.description : '' }}</mat-option>
            }
          </mat-select>
          <mat-hint>Charted beside this security's own prices on the details page</mat-hint>
        </mat-form-field>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="busy() || !ratioValid() || !ticker.trim()" (click)="submit()">
        Submit
      </button>
    </mat-dialog-actions>
  `,
  styles: '.profile-form { display: flex; flex-direction: column; min-width: 380px; }',
})
export class ProfileDialog {
  readonly data = inject<ProfileDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<ProfileDialog>);
  private readonly notify = inject(Notify);

  readonly SecurityType = SecurityType;
  readonly PricingLocus = PricingLocus;
  readonly TaxTreatment = TaxTreatment;
  /** Template-safe bigint zero - Angular templates can't write 0n. */
  readonly NONE = BigInt(0);

  ticker = this.data.security.ticker;
  description = this.data.security.description;
  securityType =
    this.data.security.securityType === SecurityType.SECURITY_TYPE_UNSPECIFIED
      ? SecurityType.STOCK
      : this.data.security.securityType;
  pricingLocus =
    this.data.security.pricingLocus === PricingLocus.PRICING_LOCUS_UNSPECIFIED
      ? PricingLocus.MARKET
      : this.data.security.pricingLocus;
  taxTreatment =
    this.data.security.taxTreatment === TaxTreatment.TAX_TREATMENT_UNSPECIFIED
      ? TaxTreatment.LOTS
      : this.data.security.taxTreatment;
  netExpenseRatio = this.data.security.netExpenseRatio?.exact?.value ?? '0';
  marketTicker = this.data.security.marketTicker;
  cusip = this.data.security.cusip;
  isin = this.data.security.isin;
  mirrorsSecurityId = this.data.security.mirrorsSecurityId;
  readonly busy = signal(false);

  /** Every candidate but this security itself. */
  candidates(): SecurityListing[] {
    return (this.data.mirrorCandidates ?? []).filter(
      (c) => c.securityId !== this.data.security.securityId,
    );
  }

  ratioValid(): boolean {
    return isDecimalString(this.netExpenseRatio);
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      await api.securities.updateSecurityProfile({
        securityId: this.data.security.securityId,
        ticker: this.ticker.trim().toUpperCase(),
        description: this.description.trim(),
        securityType: this.securityType,
        pricingLocus: this.pricingLocus,
        taxTreatment: this.taxTreatment,
        netExpenseRatio: { value: this.netExpenseRatio.trim() },
        marketTicker: this.marketTicker.trim(),
        cusip: this.cusip.trim(),
        isin: this.isin.trim(),
        ...(this.data.mirrorCandidates ? { mirrorsSecurityId: this.mirrorsSecurityId } : {}),
      });
      this.notify.success('Profile updated');
      this.ref.close(true);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
