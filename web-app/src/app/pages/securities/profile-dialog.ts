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
  type SecurityProfile,
} from '../../../proto-gen/securities_pb';
import { api } from '../../core/api';
import { isDecimalString } from '../../core/decimals';
import { Notify } from '../../core/notify';

export interface ProfileDialogData {
  security: SecurityProfile;
}

/**
 * Edit the security profile (spec sec. 9.10 header affordances; sec. 6.3 - all
 * fields hand-maintained, no auto-population). The MUTUAL_FUND type
 * drives dollar-vs-share purchases in the rebalance planner, and the
 * pricing locus decides market vs private pricing, so both live here.
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
        <mat-label>Description</mat-label>
        <input matInput [(ngModel)]="description" cdkFocusInitial>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Security Type</mat-label>
        <mat-select [(ngModel)]="securityType">
          <mat-option [value]="SecurityType.STOCK">Stock</mat-option>
          <mat-option [value]="SecurityType.ETF">ETF</mat-option>
          <mat-option [value]="SecurityType.MUTUAL_FUND">Mutual Fund</mat-option>
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
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="busy() || !ratioValid()" (click)="submit()">
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
  readonly busy = signal(false);

  ratioValid(): boolean {
    return isDecimalString(this.netExpenseRatio);
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      await api.securities.updateSecurityProfile({
        securityId: this.data.security.securityId,
        description: this.description.trim(),
        securityType: this.securityType,
        pricingLocus: this.pricingLocus,
        taxTreatment: this.taxTreatment,
        netExpenseRatio: { value: this.netExpenseRatio.trim() },
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
