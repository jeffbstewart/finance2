import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { Router } from '@angular/router';
import { PricingLocus, SecurityType } from '../../../proto-gen/securities_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';

/**
 * Optional prefill, the way the Import screen hands over what the
 * institution reported about a security it could not match. Still
 * human-created (sec. 6.3 - no auto-population); the human just stops
 * retyping. With `plaidSecurityId` the new security is linked to that
 * Plaid row on save and the dialog closes with the new id instead of
 * navigating away.
 */
export interface AddSecurityDialogData {
  ticker?: string;
  description?: string;
  currencyCode?: string;
  cusip?: string;
  isin?: string;
  /** False when the institution reports no ticker (a 401(k) trust). */
  hasPublicTicker?: boolean;
  securityType?: SecurityType;
  plaidSecurityId?: string;
}

/**
 * Add security (spec sec. 9.18). A security with a public ticker needs
 * only that and a currency - it is market-priced under that symbol and
 * the rest of the profile is edited on the details page. One without
 * (a 401(k) collective investment trust) gets a symbol of the human's
 * choosing, a name, and manual pricing; its institution price then
 * arrives with each import.
 */
@Component({
  selector: 'app-add-security-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
  ],
  template: `
    <h2 mat-dialog-title>Add New Security</h2>
    <mat-dialog-content class="add-form">
      <mat-slide-toggle [(ngModel)]="hasPublicTicker" class="toggle">
        Has a public ticker
      </mat-slide-toggle>
      <mat-form-field appearance="outline">
        <mat-label>{{ hasPublicTicker ? 'Ticker' : 'Symbol' }}</mat-label>
        <input matInput [(ngModel)]="ticker" required cdkFocusInitial>
        @if (!hasPublicTicker) {
          <mat-hint>Your own short code, e.g. the public class's ticker plus -TR (VBTIX-TR)</mat-hint>
        }
      </mat-form-field>
      @if (!hasPublicTicker) {
        <mat-form-field appearance="outline">
          <mat-label>Name</mat-label>
          <input matInput [(ngModel)]="description" required>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Security Type</mat-label>
          <mat-select [(ngModel)]="securityType">
            <mat-option [value]="SecurityType.COLLECTIVE_TRUST">Collective Trust (401(k) class of a public fund)</mat-option>
            <mat-option [value]="SecurityType.MUTUAL_FUND">Mutual Fund</mat-option>
            <mat-option [value]="SecurityType.PRIVATE_INVESTMENT">Private Investment</mat-option>
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>CUSIP (optional)</mat-label>
          <input matInput [(ngModel)]="cusip">
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>ISIN (optional)</mat-label>
          <input matInput [(ngModel)]="isin">
        </mat-form-field>
      }
      <mat-form-field appearance="outline">
        <mat-label>Currency</mat-label>
        <mat-select [(ngModel)]="currencyCode">
          <mat-option value="USD">USD</mat-option>
          <mat-option value="EUR">EUR</mat-option>
        </mat-select>
      </mat-form-field>
      @if (!hasPublicTicker) {
        <p class="note">Priced by hand (and by each import's institution price); no provider is asked.</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="busy() || !valid()" (click)="submit()">
        Submit
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .add-form { display: flex; flex-direction: column; min-width: 360px; }
    .toggle { margin-bottom: 16px; }
    .note { margin: 0 0 8px; font-size: 12px; opacity: 0.7; }
  `,
})
export class AddSecurityDialog {
  readonly data = inject<AddSecurityDialogData | null>(MAT_DIALOG_DATA, { optional: true });
  private readonly ref = inject(MatDialogRef<AddSecurityDialog>);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);

  readonly SecurityType = SecurityType;

  ticker = this.data?.ticker ?? '';
  description = this.data?.description ?? '';
  currencyCode = this.data?.currencyCode || 'USD';
  cusip = this.data?.cusip ?? '';
  isin = this.data?.isin ?? '';
  hasPublicTicker = this.data?.hasPublicTicker ?? true;
  securityType = this.data?.securityType ?? SecurityType.COLLECTIVE_TRUST;
  readonly busy = signal(false);

  /** Bound through a method so the template re-evaluates on each check. */
  valid(): boolean {
    return !!this.ticker.trim() && (this.hasPublicTicker || !!this.description.trim());
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      const ticker = this.ticker.trim().toUpperCase();
      const response = this.hasPublicTicker
        ? await api.securities.addSecurity({
            ticker,
            currencyCode: this.currencyCode,
            pricingLocus: PricingLocus.MARKET,
          })
        : await api.securities.addSecurity({
            ticker,
            currencyCode: this.currencyCode,
            description: this.description.trim(),
            securityType: this.securityType,
            pricingLocus: PricingLocus.MANUAL,
            cusip: this.cusip.trim(),
            isin: this.isin.trim(),
          });
      const created = response.security;
      const plaidSecurityId = this.data?.plaidSecurityId;
      if (plaidSecurityId && created) {
        await api.imports.linkPlaidSecurity({ plaidSecurityId, securityId: created.securityId });
        this.notify.success(`${created.ticker} added and linked - process to import`);
        this.ref.close(created.securityId);
        return;
      }
      this.notify.success(`${created?.ticker} added - fill in its profile`);
      this.ref.close(true);
      await this.router.navigate(['/securities', created?.securityId]);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
