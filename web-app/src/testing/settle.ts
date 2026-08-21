// Zoneless change detection does not track the bare promises our
// pages fire from constructors/ngOnInit (reload() through the fake
// transport), so fixture.whenStable() can resolve before the data
// lands. settle() lets the microtask/macrotask queue drain, then runs
// change detection — twice, because the first render often schedules
// a second async step (e.g. a dialog close triggering a reload).
import type { ComponentFixture } from '@angular/core/testing';

export async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
}
