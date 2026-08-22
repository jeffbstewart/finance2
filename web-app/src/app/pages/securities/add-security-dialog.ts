import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router } from '@angular/router';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';

/**
 * Add security (spec sec. 9.18): ticker plus currency; every other profile
 * field is edited manually afterwards on the details page (sec. 6.3 - no
 * auto-population), so the dialog navigates straight there.
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
  ],
  template: `
    <h2 mat-dialog-title>Add New Security</h2>
    <mat-dialog-content class="add-form">
      <mat-form-field appearance="outline">
        <mat-label>Ticker</mat-label>
        <input matInput [(ngModel)]="ticker" required cdkFocusInitial>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Currency</mat-label>
        <mat-select [(ngModel)]="currencyCode">
          <mat-option value="USD">USD</mat-option>
          <mat-option value="EUR">EUR</mat-option>
        </mat-select>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="busy() || !ticker.trim()" (click)="submit()">
        Submit
      </button>
    </mat-dialog-actions>
  `,
  styles: '.add-form { display: flex; flex-direction: column; min-width: 320px; }',
})
export class AddSecurityDialog {
  private readonly ref = inject(MatDialogRef<AddSecurityDialog>);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);

  ticker = '';
  currencyCode = 'USD';
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      const response = await api.securities.addSecurity({
        ticker: this.ticker.trim().toUpperCase(),
        currencyCode: this.currencyCode,
      });
      this.notify.success(`${response.security?.ticker} added - fill in its profile`);
      this.ref.close(true);
      await this.router.navigate(['/securities', response.security?.securityId]);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
