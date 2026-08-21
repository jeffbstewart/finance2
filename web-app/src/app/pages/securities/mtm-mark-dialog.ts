import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { provideNativeDateAdapter } from '@angular/material/core';
import type { MtmMark, SecurityProfile } from '../../../proto-gen/securities_pb';
import { api } from '../../core/api';
import { civilFromJs, jsFromCivil } from '../../core/dates';
import { isDecimalString } from '../../core/decimals';
import { Notify, messageOf } from '../../core/notify';

export interface MtmMarkDialogData {
  security: SecurityProfile;
  taxYear: number;
  /** Edit mode: the mark being changed (tax year immutable — the
   *  server recomputes this mark and every later one). */
  mark?: MtmMark;
  /** Edit mode: whether later marks exist that will restate. */
  hasLaterMarks?: boolean;
}

/**
 * Record a year-end mark (build-scope §11). The server suggests
 * shares × last price on or before Dec 31 × ECB rate on or before
 * Dec 31; every field stays editable so the mark can record what was
 * actually filed (a past year's FX rate is often not in the store —
 * the ECB feed backfills only 90 days).
 */
@Component({
  selector: 'app-mtm-mark-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDatepickerModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  providers: [provideNativeDateAdapter()],
  template: `
    <h2 mat-dialog-title>
      {{ editing ? 'Edit' : 'Record' }} Year-End Mark — {{ data.security.ticker }}
    </h2>
    <mat-dialog-content class="mark-form">
      <mat-form-field appearance="outline">
        <mat-label>Tax Year</mat-label>
        <input
          matInput
          type="number"
          [ngModel]="taxYear()"
          (ngModelChange)="yearChanged($event)"
          [disabled]="editing"
        >
        @if (editing) {
          <mat-hint>The tax year is fixed — delete and re-record to move a mark</mat-hint>
        }
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Mark Date</mat-label>
        <input matInput [matDatepicker]="picker" [(ngModel)]="markDate" required>
        <mat-datepicker-toggle matIconSuffix [for]="picker" />
        <mat-datepicker #picker />
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Shares Held</mat-label>
        <input matInput [(ngModel)]="quantity" required>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Fair Market Value ({{ data.security.currencyCode }})</mat-label>
        <input matInput [(ngModel)]="fmvLocal" required>
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>FX Rate (USD per {{ data.security.currencyCode }})</mat-label>
        <input matInput [(ngModel)]="fxRate" required>
      </mat-form-field>
      @for (note of notes(); track note) {
        <p class="note">{{ note }}</p>
      }
      @if (previewIncome(); as income) {
        <p class="preview">Suggested ordinary income: {{ income }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="busy() || !valid()" (click)="submit()">
        {{ editing ? 'Save Mark' : 'Record Mark' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .mark-form { display: flex; flex-direction: column; min-width: 400px; }
    .note { opacity: 0.75; font-size: 13px; margin: 0 0 4px; }
    .preview { font-weight: 500; }
  `,
})
export class MtmMarkDialog {
  readonly data = inject<MtmMarkDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<MtmMarkDialog>);
  private readonly notify = inject(Notify);

  readonly editing = this.data.mark !== undefined;
  readonly taxYear = signal(this.data.taxYear);
  markDate: Date | null = null;
  quantity = '';
  fmvLocal = '';
  fxRate = '';
  readonly notes = signal<string[]>([]);
  readonly previewIncome = signal('');
  readonly busy = signal(false);

  constructor() {
    const mark = this.data.mark;
    if (mark) {
      // Edit mode prefills from the recorded mark; no suggestion.
      this.markDate = mark.markDate?.exact ? jsFromCivil(mark.markDate.exact) : null;
      this.quantity = mark.quantity?.exact?.value ?? '';
      this.fmvLocal = mark.fmvLocal?.exact?.amount?.value ?? '';
      this.fxRate = mark.fxRate?.exact?.value ?? '';
      if (this.data.hasLaterMarks) {
        this.notes.set(['later marks restate automatically against the edited basis']);
      }
    } else {
      void this.loadSuggestion();
    }
  }

  yearChanged(year: number): void {
    this.taxYear.set(year);
    if (Number.isInteger(year) && year >= 1900 && year <= 2200) {
      void this.loadSuggestion();
    }
  }

  private async loadSuggestion(): Promise<void> {
    try {
      const response = await api.securities.suggestMtmMark({
        securityId: this.data.security.securityId,
        taxYear: this.taxYear(),
      });
      const preview = response.preview;
      this.markDate = preview?.markDate?.exact
        ? jsFromCivil(preview.markDate.exact)
        : new Date(this.taxYear(), 11, 31);
      this.quantity = preview?.quantity?.exact?.value ?? '';
      this.fmvLocal = preview?.fmvLocal?.exact?.amount?.value ?? '';
      this.fxRate = preview?.fxRate?.exact?.value ?? '';
      this.previewIncome.set(preview?.ordinaryIncome?.display ?? '');
      this.notes.set(response.notes);
    } catch (err) {
      // A failed suggestion is not fatal — the fields stay editable.
      this.markDate = new Date(this.taxYear(), 11, 31);
      this.notes.set([messageOf(err)]);
      this.previewIncome.set('');
    }
  }

  valid(): boolean {
    return (
      this.markDate instanceof Date &&
      isDecimalString(this.quantity) &&
      isDecimalString(this.fmvLocal) &&
      isDecimalString(this.fxRate)
    );
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      const fields = {
        markDate: civilFromJs(this.markDate!),
        quantity: { value: this.quantity.trim() },
        fmvLocal: { value: this.fmvLocal.trim() },
        fxRate: { value: this.fxRate.trim() },
      };
      const mark = this.data.mark
        ? (await api.securities.updateMtmMark({ markId: this.data.mark.markId, ...fields })).mark
        : (
            await api.securities.recordMtmMark({
              securityId: this.data.security.securityId,
              taxYear: this.taxYear(),
              ...fields,
            })
          ).mark;
      this.notify.success(
        `${this.taxYear()} mark ${this.data.mark ? 'updated' : 'recorded'} — ` +
          `ordinary income ${mark?.ordinaryIncome?.display}`,
      );
      this.ref.close(true);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
