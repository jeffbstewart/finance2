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
  /** Plot against a second y axis on the right (a mirrored security
   *  whose price level differs from this one's). */
  axis?: 'left' | 'right';
  /** Draw a marker at every point - for a sparse hand-priced series
   *  whose actual observations matter more than the line between. */
  markers?: boolean;
}

/**
 * Two-axis alignment. The right axis is scaled so that a series which
 * tracks the left one proportionally (a trust fund and the public
 * fund it mirrors) draws on top of it: the ratio right/left is taken
 * at every date both have, and the median is the scale. Both axes
 * then share one range, expressed in each axis's own units, wide
 * enough for EVERY point of both series - the left series converted
 * into the right's units joins the right series' own extremes, so a
 * mirror that kept moving after the last left observation stays on
 * the chart instead of running off the top. Without an overlapping
 * date the axes scale independently.
 */
export function alignedAxes(
  left: TimeSeriesPoint[],
  right: TimeSeriesPoint[],
): { left: [number, number]; right: [number, number] } | null {
  const finite = (points: TimeSeriesPoint[]) =>
    points.map((p) => p.value).filter((v) => Number.isFinite(v));
  const leftValues = finite(left);
  const rightValues = finite(right);
  if (!leftValues.length) return null;
  const byDate = new Map(left.map((p) => [p.date, p.value]));
  const ratios = right
    .filter((p) => byDate.has(p.date) && byDate.get(p.date)! > 0 && p.value > 0)
    .map((p) => p.value / byDate.get(p.date)!)
    .sort((a, b) => a - b);
  if (!ratios.length) return null;
  const scale = ratios[Math.floor(ratios.length / 2)];
  // The union of both series in the right axis's units.
  const inRight = leftValues.map((v) => v * scale).concat(rightValues);
  const min = Math.min(...inRight);
  const max = Math.max(...inRight);
  const pad = (max - min || Math.abs(max) || 1) * 0.05;
  const right_: [number, number] = [min - pad, max + pad];
  return { left: [right_[0] / scale, right_[1] / scale], right: right_ };
}

/**
 * Chart facade (Decision 6 discussion): line chart over civil dates
 * with a timeline scrubber (spec sec. 9.10 tab 1), and an optional
 * right axis for a mirrored series. Library stays confined to this
 * file.
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
      const rightSeries = series.filter((s) => s.axis === 'right');
      const leftPrimary = series.find((s) => s.axis !== 'right' && !s.dashed) ?? series[0];
      const aligned =
        rightSeries.length && leftPrimary
          ? alignedAxes(leftPrimary.points, rightSeries[0].points)
          : null;
      const yAxis: object[] = [
        aligned
          ? { type: 'value', min: aligned.left[0], max: aligned.left[1] }
          : { type: 'value', scale: true },
      ];
      if (rightSeries.length) {
        yAxis.push(
          aligned
            ? { type: 'value', min: aligned.right[0], max: aligned.right[1], position: 'right' }
            : { type: 'value', scale: true, position: 'right' },
        );
      }
      chart.setOption(
        {
          tooltip: { trigger: 'axis' },
          legend: { show: series.length > 1, top: 0 },
          grid: { left: 64, right: rightSeries.length ? 64 : 16, top: 32, bottom: 72 },
          xAxis: { type: 'time' },
          yAxis,
          dataZoom: [
            { type: 'slider', xAxisIndex: 0, bottom: 8 },
            { type: 'inside', xAxisIndex: 0 },
          ],
          series: series.map((s) => ({
            name: s.name,
            type: 'line',
            yAxisIndex: s.axis === 'right' ? 1 : 0,
            showSymbol: !!s.markers,
            symbolSize: s.markers ? 7 : 4,
            connectNulls: true,
            lineStyle: s.dashed ? { width: 1, type: 'dashed' } : { width: 2 },
            data: s.points.map((p) => [p.date, p.value]),
          })),
        },
        // Series and axes change when indicators or a mirror toggle;
        // replace rather than merge so stale overlays disappear.
        { replaceMerge: ['series', 'legend', 'yAxis'] },
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
