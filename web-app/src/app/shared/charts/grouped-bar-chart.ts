import {
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  viewChild,
} from '@angular/core';
import * as echarts from 'echarts/core';
import { BarChart as EchartsBar } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([EchartsBar, GridComponent, LegendComponent, TitleComponent, TooltipComponent, CanvasRenderer]);

export interface BarSeries {
  name: string;
  /** One presentation magnitude per category - geometry only. */
  values: number[];
  /** Preformatted tooltip strings, aligned with `values`. */
  displays: string[];
}

/**
 * Chart facade (Decision 6 discussion): grouped bars per category
 * (spec sec. 9.13's current-vs-target and delta charts). Library stays
 * confined to this file.
 */
@Component({
  selector: 'app-grouped-bar-chart',
  template: '<div #host class="chart-host"></div>',
  styles: ':host { display: block; } .chart-host { width: 100%; height: 320px; }',
})
export class GroupedBarChart implements OnDestroy {
  readonly title = input('');
  readonly categories = input<string[]>([]);
  readonly series = input<BarSeries[]>([]);

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private chart?: echarts.ECharts;
  private resizeObserver?: ResizeObserver;

  constructor() {
    effect(() => {
      const categories = this.categories();
      const series = this.series();
      const chart = this.ensureChart();
      chart.setOption(
        {
          title: { text: this.title(), left: 'center', textStyle: { fontSize: 14 } },
          tooltip: {
            trigger: 'item',
            formatter: (params: { seriesIndex: number; dataIndex: number; name: string }) => {
              const s = series[params.seriesIndex];
              return `${params.name} - ${s?.name}: ${s?.displays[params.dataIndex] ?? ''}`;
            },
          },
          legend: { show: series.length > 1, bottom: 0 },
          grid: { left: 64, right: 16, top: 40, bottom: 48 },
          xAxis: { type: 'category', data: categories, axisLabel: { interval: 0, rotate: 20 } },
          yAxis: { type: 'value' },
          series: series.map((s) => ({ name: s.name, type: 'bar', data: s.values })),
        },
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
