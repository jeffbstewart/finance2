import { Component, computed, input } from '@angular/core';

/**
 * Chart facade (Decision 6 discussion): the table-cell price trend
 * (spec sec. 9.17). Plain inline SVG - dozens of table rows don't warrant
 * a chart-library instance each; the facade contract still isolates
 * screens from the rendering choice.
 */
@Component({
  selector: 'app-sparkline',
  template: `
    <svg [attr.viewBox]="'0 0 ' + width + ' ' + height" preserveAspectRatio="none"
         [attr.width]="width" [attr.height]="height" aria-hidden="true">
      @if (path(); as d) {
        <path [attr.d]="d" fill="none" stroke="currentColor" stroke-width="1.5" />
      }
    </svg>
  `,
  styles: ':host { display: inline-block; color: #3f51b5; line-height: 0; }',
})
export class Sparkline {
  /** Presentation magnitudes, oldest first - geometry only. */
  readonly values = input<number[]>([]);

  readonly width = 120;
  readonly height = 28;

  readonly path = computed<string>(() => {
    const values = this.values();
    if (values.length < 2) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pad = 2;
    const stepX = (this.width - 2 * pad) / (values.length - 1);
    return values
      .map((v, i) => {
        const x = pad + i * stepX;
        const y = pad + (this.height - 2 * pad) * (1 - (v - min) / span);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  });
}
