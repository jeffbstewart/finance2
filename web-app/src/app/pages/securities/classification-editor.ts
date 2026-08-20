import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import type { SecurityProfile } from '../../../proto-gen/securities_pb';
import { api } from '../../core/api';
import { todayCivil } from '../../core/dates';
import {
  fractionToPercent,
  isDecimalString,
  percentToFraction,
  shiftLeft,
  shiftRight,
} from '../../core/decimals';
import { Notify } from '../../core/notify';
import { PieChart, type PieSlice } from '../../shared/charts/pie-chart';

const KIND = 'ASSET_CLASS';

interface WeightRow {
  name: string;
  percent: string;
}

/**
 * The asset-class mix (spec §9.10 tab 2; launch scope build-scope §4):
 * pie of the current weights plus the percent-per-class edit form with
 * a must-sum-to-100 cross validator. Saving date-stamps the mix
 * (as_of = today) so staleness can prompt a refresh later.
 */
@Component({
  selector: 'app-classification-editor',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    PieChart,
  ],
  template: `
    <div class="classification">
      <div class="pie-pane">
        @if (slices().length) {
          <app-pie-chart title="Asset Class Mix" [slices]="slices()" />
          <p class="as-of">
            As of {{ asOf() }}
            @if (refreshSuggested()) {
              <span class="refresh-chip">refresh suggested</span>
            }
          </p>
        } @else {
          <p class="empty-note">No asset class mix yet — enter the weights to the right.</p>
        }
      </div>
      <div class="form-pane">
        @if (editing()) {
          @for (row of rows(); track row.name) {
            <mat-form-field appearance="outline" class="weight-field">
              <mat-label>{{ row.name }} %</mat-label>
              <input matInput [(ngModel)]="row.percent" (ngModelChange)="revalidate()">
            </mat-form-field>
          }
          @if (validationError(); as message) {
            <p class="validation-error">{{ message }}</p>
          }
          <div class="form-actions">
            <button matButton (click)="cancel()">Cancel</button>
            <button matButton="filled" [disabled]="busy() || !!validationError()" (click)="save()">
              Save
            </button>
          </div>
        } @else {
          <button matButton (click)="beginEdit()">
            <mat-icon>edit</mat-icon>
            Edit Asset Class Weights
          </button>
        }
      </div>
    </div>
  `,
  styles: `
    .classification { display: flex; flex-wrap: wrap; gap: 24px; padding-top: 16px; }
    .pie-pane { flex: 1 1 360px; }
    .form-pane { flex: 1 1 280px; display: flex; flex-direction: column; }
    .weight-field { max-width: 280px; }
    .as-of { opacity: 0.7; font-size: 13px; }
    .refresh-chip {
      margin-left: 8px; padding: 2px 8px; border-radius: 12px;
      background: #fde293; color: #5f4b00; font-size: 12px;
    }
    .validation-error { color: #b3261e; font-size: 13px; }
    .form-actions { display: flex; gap: 8px; justify-content: flex-end; max-width: 280px; }
    .empty-note { opacity: 0.7; }
  `,
})
export class ClassificationEditor {
  readonly security = input.required<SecurityProfile>();
  readonly saved = output<void>();

  private readonly notify = inject(Notify);

  readonly editing = signal(false);
  readonly busy = signal(false);
  readonly rows = signal<WeightRow[]>([]);
  readonly validationError = signal<string | null>(null);

  private readonly classification = computed(() =>
    this.security().classifications.find((c) => c.kind === KIND),
  );

  readonly slices = computed<PieSlice[]>(() => {
    const weights = this.classification()?.weights ?? {};
    return Object.entries(weights)
      .filter(([, w]) => (w.sortKey ?? 0) > 0)
      .map(([name, w]) => ({
        id: name,
        name,
        value: w.sortKey ?? 0,
        display: w.display ?? '',
      }));
  });

  readonly asOf = computed(() => {
    const asOf = this.classification()?.asOf;
    return asOf ? `${asOf.year}-${String(asOf.month).padStart(2, '0')}-${String(asOf.day).padStart(2, '0')}` : '';
  });

  readonly refreshSuggested = computed(() => this.classification()?.refreshSuggested ?? false);

  constructor() {
    // Leaving edit mode when the input security changes (post-save
    // reload) keeps stale form rows from surviving a refresh.
    effect(() => {
      this.security();
      this.editing.set(false);
    });
  }

  async beginEdit(): Promise<void> {
    try {
      // Class names come from the portfolio's seeded classes; numeric
      // ids never cross the wire (decision on asset-class identity).
      const allocation = await api.allocation.getAllocation({});
      const names = allocation.classes.map((c) => c.name);
      const current = this.classification()?.weights ?? {};
      for (const name of Object.keys(current)) {
        if (!names.includes(name)) names.push(name);
      }
      this.rows.set(
        names.map((name) => ({
          name,
          percent: current[name]?.exact?.value
            ? fractionToPercent(current[name].exact!.value)
            : '0',
        })),
      );
      this.validationError.set(null);
      this.editing.set(true);
    } catch (err) {
      this.notify.error(err);
    }
  }

  cancel(): void {
    this.editing.set(false);
  }

  revalidate(): void {
    this.validationError.set(this.validate());
  }

  /** Mirror of the server rule: each 0–100, sum 100 (±0.01). */
  private validate(): string | null {
    let totalTenThousandths = 0;
    for (const row of this.rows()) {
      const percent = row.percent.trim();
      if (!isDecimalString(percent)) {
        return `${row.name}: enter a number between 0 and 100`;
      }
      // percent → fraction → integer ten-thousandths, all as exact
      // string shifts; no float arithmetic on entered values.
      const fraction = percentToFraction(percent);
      const scaled = Number(shiftRight(fraction, 4));
      if (!Number.isInteger(scaled)) {
        return `${row.name}: at most two decimal places`;
      }
      if (scaled < 0 || scaled > 10_000) {
        return `${row.name}: must be between 0 and 100`;
      }
      totalTenThousandths += scaled;
    }
    if (Math.abs(totalTenThousandths - 10_000) > 1) {
      return `Weights must sum to 100 (currently ${shiftLeft(String(totalTenThousandths), 2)})`;
    }
    return null;
  }

  async save(): Promise<void> {
    const error = this.validate();
    if (error) {
      this.validationError.set(error);
      return;
    }
    this.busy.set(true);
    try {
      const weights: Record<string, { value: string }> = {};
      for (const row of this.rows()) {
        const fraction = percentToFraction(row.percent.trim());
        if (fraction !== '0') weights[row.name] = { value: fraction };
      }
      await api.securities.setClassification({
        securityId: this.security().securityId,
        kind: KIND,
        weights,
        asOf: todayCivil(),
      });
      this.notify.success('Asset class mix saved');
      this.editing.set(false);
      this.saved.emit();
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
