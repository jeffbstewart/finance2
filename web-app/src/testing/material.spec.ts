// Proves the unit-lane drivers against a tiny host component, so the
// helpers themselves are regression-tested — not just the pages that
// use them.
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeDialog, provideFakeDialog } from './fake-dialog';
import { cleanupOverlays, clickButton, clickToggle, pickOption, readRows, textOf, typeInto } from './material';
import { settle } from './settle';

@Component({
  selector: 'app-driver-host',
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
    <mat-form-field appearance="outline">
      <mat-label>Ticker</mat-label>
      <input matInput [(ngModel)]="ticker" required>
    </mat-form-field>
    <mat-form-field appearance="outline">
      <mat-label>Currency</mat-label>
      <mat-select [(ngModel)]="currency">
        <mat-option value="USD">US Dollar</mat-option>
        <mat-option value="EUR">Euro</mat-option>
      </mat-select>
    </mat-form-field>
    <mat-slide-toggle [checked]="hidden()" (change)="hidden.set($event.checked)">Show hidden</mat-slide-toggle>
    <button matButton (click)="openDialog()">Open dialog</button>
    <button matIconButton aria-label="Save" (click)="saved = saved + 1"></button>
    <table>
      <tr mat-row><td>{{ ticker }}</td><td>{{ currency }}</td></tr>
    </table>
    <p>dialog-opens: {{ opens }}</p>
  `,
})
class DriverHost {
  ticker = '';
  currency = 'USD';
  saved = 0;
  opens = 0;
  readonly hidden = signal(false);
  constructor(private readonly dialog: MatDialog) {}
  openDialog(): void {
    this.dialog.open(DriverHost, { data: { hello: 'world' } }).afterClosed().subscribe(() => this.opens++);
  }
}

describe('unit-lane material drivers', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });
  afterEach(() => cleanupOverlays());

  it('typeInto drives ngModel through the DOM', async () => {
    const fixture = TestBed.createComponent(DriverHost);
    fixture.detectChanges();
    await typeInto(fixture, 'Ticker', 'VTI');
    expect(fixture.componentInstance.ticker).toBe('VTI');
    expect(readRows(fixture)).toEqual([['VTI', 'USD']]);
  });

  it('pickOption opens the select and picks by visible text', async () => {
    const fixture = TestBed.createComponent(DriverHost);
    fixture.detectChanges();
    await pickOption(fixture, 'Currency', 'Euro');
    expect(fixture.componentInstance.currency).toBe('EUR');
    expect(readRows(fixture)[0][1]).toBe('EUR');
  });

  it('clickToggle flips the slide toggle; clickButton finds by aria-label', async () => {
    const fixture = TestBed.createComponent(DriverHost);
    fixture.detectChanges();
    await clickToggle(fixture, 'Show hidden');
    expect(fixture.componentInstance.hidden()).toBe(true);
    await clickButton(fixture, 'Save');
    expect(fixture.componentInstance.saved).toBe(1);
  });

  it('provideFakeDialog intercepts the component-injected MatDialog', async () => {
    const dialog = fakeDialog();
    dialog.results.push('closed-with-this');
    provideFakeDialog(DriverHost, dialog);
    const fixture = TestBed.createComponent(DriverHost);
    fixture.detectChanges();
    await clickButton(fixture, 'Open dialog');
    await settle(fixture);
    expect(dialog.opens).toHaveLength(1);
    expect(dialog.lastData).toEqual({ hello: 'world' });
    expect(textOf(fixture)).toContain('dialog-opens: 1');
  });
});
