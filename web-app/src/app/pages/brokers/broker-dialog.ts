import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';

export interface BrokerDialogData {
  brokerId?: bigint;
  name?: string;
}

/** Add / edit broker (spec §9.2): one required name field. */
@Component({
  selector: 'app-broker-dialog',
  imports: [FormsModule, MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>{{ data.brokerId ? 'Edit Broker' : 'Add New Broker' }}</h2>
    <mat-dialog-content>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Brokerage Name</mat-label>
        <input matInput [(ngModel)]="name" required cdkFocusInitial>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close>Cancel</button>
      <button matButton="filled" [disabled]="busy() || !name.trim()" (click)="submit()">
        Submit
      </button>
    </mat-dialog-actions>
  `,
  styles: '.full-width { width: 100%; min-width: 320px; }',
})
export class BrokerDialog {
  readonly data = inject<BrokerDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<BrokerDialog>);
  private readonly notify = inject(Notify);

  name = this.data.name ?? '';
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      if (this.data.brokerId) {
        await api.brokers.renameBroker({ brokerId: this.data.brokerId, name: this.name.trim() });
        this.notify.success('Broker renamed');
      } else {
        await api.brokers.createBroker({ name: this.name.trim() });
        this.notify.success('Broker added');
      }
      this.ref.close(true);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
