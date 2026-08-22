import {
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  viewChild,
} from '@angular/core';
import * as echarts from 'echarts/core';
import { LineChart as EchartsLine } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  EchartsLine,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export interface TimeSeriesPoint {
  /** ISO civil date, `YYYY-MM-DD`. */
  date: string;
  /** Presentation magnitude - chart geometry only, never arithmetic. */
  value: number;
}

export interface TimeSeries {
  name: string;
  points: TimeSeriesPoint[];
  /** Render as a thin dashed overlay (indicator styling). */
  dashed?: boolean;
}

/**
 * Chart facade (Decision 6 discussion): line chart over civil dates
 * with a timeline scrubber (spec sec. 9.10 tab 1). Library stays confined
 * to this file.
 */
@Component({
  selector: 'app-time-series-chart',
  template: '<div #host class="chart-host"></div>',
  styles: ':host { display: block; } .chart-host { width: 100%; height: 420px; }',
})
export class TimeSeriesChart implements OnDestroy {
  readonly series = input<TimeSeries[]>([]);

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private chart?: echarts.ECharts;
  private resizeObserver?: ResizeObserver;

  constructor() {
    effect(() => {
      const series = this.series();
      const chart = this.ensureChart();
      chart.setOption(
        {
          tooltip: { trigger: 'axis' },
          legend: { show: series.length > 1, top: 0 },
          grid: { left: 64, right: 16, top: 32, bottom: 72 },
          xAxis: { type: 'time' },
          yAxis: { type: 'value', scale: true },
          dataZoom: [
            { type: 'slider', xAxisIndex: 0, bottom: 8 },
            { type: 'inside', xAxisIndex: 0 },
          ],
          series: series.map((s) => ({
            name: s.name,
            type: 'line',
            showSymbol: false,
            lineStyle: s.dashed ? { width: 1, type: 'dashed' } : { width: 2 },
            data: s.points.map((p) => [p.date, p.value]),
          })),
        },
        // Series count changes when indicators toggle; replace rather
        // than merge so stale overlays disappear.
        { replaceMerge: ['series', 'legend'] },
      );
    });
  }

  private ensureChart(): echarts.ECharts {
    if (!this.chart) {
      const el = this.host().nativeElement;
      this.chart = echarts.init(el);
      this.resizeObserver = new ResizeObserver(() => this.chart?.resize());
      this.resizeObserver.observe(el);
    }
    return this.chart;
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.chart?.dispose();
  }
}
