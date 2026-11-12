import { Component, computed, input } from '@angular/core';

/** One of the security's own observations, placed on a borrowed line. */
export interface SparklineDot {
  /** Index into `values` (the borrowed close on or before the date). */
  index: number;
  /** Presentation magnitude in the line's own scale. */
  value: number;
}

/**
 * Chart facade (Decision 6 discussion): the table-cell price trend
 * (spec sec. 9.17). Plain inline SVG - dozens of table rows don't warrant
 * a chart-library instance each; the facade contract still isolates
 * screens from the rendering choice.
 *
 * A borrowed trend (`proxy` set: the mirrored fund's closes standing in
 * for a trust's handful of statement prices) is drawn dashed and
 * lighter, captioned `via TICKER`, with the security's own
 * observations as dots on the line - so the shape is visibly on loan,
 * its source is named, and how well the real thing agrees is on
 * screen rather than hidden in a tooltip.
 */
@Component({
  selector: 'app-sparkline',
  template: `
    <svg [attr.viewBox]="'0 0 ' + width + ' ' + height" preserveAspectRatio="none"
         [attr.width]="width" [attr.height]="height" aria-hidden="true">
      @if (path(); as d) {
        <path
          [attr.d]="d"
          fill="none"
          stroke="currentColor"
          [attr.stroke-width]="proxy() ? 1.25 : 1.5"
          [attr.stroke-dasharray]="proxy() ? '4 3' : null"
          [attr.opacity]="proxy() ? 0.7 : 1"
        />
      }
      @for (dot of dotPoints(); track $index) {
        <circle [attr.cx]="dot.x" [attr.cy]="dot.y" r="2.2" fill="currentColor" />
      }
    </svg>
    @if (proxy(); as p) {
      <span class="via" [attr.title]="caption()">via {{ p }}</span>
    }
  `,
  styles: `
    :host { display: inline-flex; flex-direction: column; align-items: flex-start; color: #3f51b5; line-height: 0; }
    .via {
      margin-top: 2px;
      font-size: 10px;
      line-height: 12px;
      letter-spacing: 0.02em;
      opacity: 0.65;
      white-space: nowrap;
      /* "via " plus a five-glyph ticker sits well inside the line's width. */
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `,
})
export class Sparkline {
  /** Presentation magnitudes, oldest first - geometry only. */
  readonly values = input<number[]>([]);
  /** The ticker whose closes `values` are, when borrowed; empty otherwise. */
  readonly proxy = input('');
  /** The security's own observations, when the line is borrowed. */
  readonly dots = input<SparklineDot[]>([]);
  /** How many own points the window had - for the caption's tooltip. */
  readonly ownPoints = input(0);

  readonly width = 120;
  readonly height = 28;

  private readonly pad = 2;

  private readonly frame = computed(() => {
    const values = this.values();
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { min, span: max - min || 1, stepX: (this.width - 2 * this.pad) / (values.length - 1) };
  });

  private x(index: number): string {
    return (this.pad + index * this.frame()!.stepX).toFixed(1);
  }

  private y(value: number): string {
    const { min, span } = this.frame()!;
    return (this.pad + (this.height - 2 * this.pad) * (1 - (value - min) / span)).toFixed(1);
  }

  readonly path = computed<string>(() => {
    if (!this.frame()) return '';
    return this.values()
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${this.x(i)},${this.y(v)}`)
      .join(' ');
  });

  /** Dots clamped to the line's index range; outside values still plot
   *  (the frame is the line's), so a divergent actual shows as off-line. */
  readonly dotPoints = computed<{ x: string; y: string }[]>(() => {
    const frame = this.frame();
    if (!frame || !this.proxy()) return [];
    const last = this.values().length - 1;
    return this.dots()
      .filter((d) => Number.isFinite(d.value) && d.index >= 0 && d.index <= last)
      .map((d) => ({ x: this.x(d.index), y: this.y(d.value) }));
  });

  readonly caption = computed(() => {
    const own = this.ownPoints();
    return `Trend of ${this.proxy()}, the mirrored fund; dots are this security's own ` +
      `${own} price${own === 1 ? '' : 's'} in the window, scaled to the fund's level`;
  });
}
