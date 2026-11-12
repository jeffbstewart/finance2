import {
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import * as echarts from 'echarts/core';
import { PieChart as EchartsPie } from 'echarts/charts';
import { LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([EchartsPie, LegendComponent, TitleComponent, TooltipComponent, CanvasRenderer]);

export interface PieSlice {
  id: string;
  name: string;
  /** Presentation magnitude (the wire's sort_key - never arithmetic). */
  value: number;
  /** Preformatted display value for the tooltip. */
  display: string;
}

/**
 * Chart facade (Decision 6 discussion): every chart hides its library
 * behind one of these thin typed components, so swapping ECharts out
 * later means rewriting facades, not screens.
 */
@Component({
  selector: 'app-pie-chart',
  template: '<div #host class="chart-host"></div>',
  styles: ':host { display: block; } .chart-host { width: 100%; height: 320px; }',
})
export class PieChart implements OnDestroy {
  readonly title = input('');
  readonly slices = input<PieSlice[]>([]);
  readonly sliceClick = output<PieSlice>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private chart?: echarts.ECharts;
  private resizeObserver?: ResizeObserver;

  constructor() {
    effect(() => {
      const slices = this.slices();
      const chart = this.ensureChart();
      chart.setOption({
        title: { text: this.title(), left: 'center', textStyle: { fontSize: 14 } },
        tooltip: {
          trigger: 'item',
          formatter: (params: { dataIndex: number }) =>
            `${slices[params.dataIndex]?.name}: ${slices[params.dataIndex]?.display}`,
        },
        series: [
          {
            type: 'pie',
            radius: ['35%', '65%'],
            data: slices.map((s) => ({ name: s.name, value: s.value })),
            label: { formatter: '{b}' },
          },
        ],
      });
    });
  }

  private ensureChart(): echarts.ECharts {
    if (!this.chart) {
      const el = this.host().nativeElement;
      this.chart = echarts.init(el);
      this.chart.on('click', (params) => {
        const slice = this.slices()[params.dataIndex as number];
        if (slice) this.sliceClick.emit(slice);
      });
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
