// Chart stand-ins for unit specs (docs/design/ui-testing.md).
//
// ECharts renders to canvas — nothing to assert in the DOM. Pages are
// tested on the DATA they hand the facade: override the real facade
// imports with these same-selector stubs and read `.slices` /
// `.series` off the stub instance, or call `emitSliceClick` to drive
// navigation. The sparkline facade is plain SVG and needs no stub.
//
//   TestBed.overrideComponent(BrokersPage, {
//     remove: { imports: [PieChart] },
//     add: { imports: [PieChartStub] },
//   });
import { Component, input, output } from '@angular/core';
import type { PieSlice } from '../app/shared/charts/pie-chart';
import type { TimeSeries } from '../app/shared/charts/time-series-chart';
import type { BarSeries } from '../app/shared/charts/grouped-bar-chart';

@Component({
  selector: 'app-pie-chart',
  template: '<div class="pie-chart-stub" [attr.data-title]="title()"></div>',
})
export class PieChartStub {
  readonly title = input('');
  readonly slices = input<PieSlice[]>([]);
  readonly sliceClick = output<PieSlice>();

  emitSliceClick(slice: PieSlice): void {
    this.sliceClick.emit(slice);
  }
}

@Component({
  selector: 'app-time-series-chart',
  template: '<div class="time-series-chart-stub"></div>',
})
export class TimeSeriesChartStub {
  readonly series = input<TimeSeries[]>([]);
}

@Component({
  selector: 'app-grouped-bar-chart',
  template: '<div class="grouped-bar-chart-stub" [attr.data-title]="title()"></div>',
})
export class GroupedBarChartStub {
  readonly title = input('');
  readonly categories = input<string[]>([]);
  readonly series = input<BarSeries[]>([]);
}
