// Unit spec for the two-axis alignment behind the mirrored chart. The
// chart itself is an echarts facade (stubbed in page specs); the
// alignment is plain arithmetic and is pinned here.
import { describe, expect, it } from 'vitest';
import { alignedAxes, type TimeSeriesPoint } from './time-series-chart';

const pt = (date: string, value: number): TimeSeriesPoint => ({ date, value });

describe('alignedAxes', () => {
  // Gold coins, priced twice; GLD daily, at one tenth of the coin price
  // on the shared dates, and then rising well past the last coin price.
  const coins = [pt('2025-06-30', 3000), pt('2025-12-31', 3200)];
  const gld = [
    pt('2025-06-30', 300),
    pt('2025-12-31', 320),
    pt('2026-04-01', 380),
    pt('2026-08-01', 420),
  ];

  it('scales the right axis by the median ratio over shared dates', () => {
    const axes = alignedAxes(coins, gld)!;
    // ratio 0.1 on both shared dates; the left range is the right range / 0.1.
    expect(axes.left[0]).toBeCloseTo(axes.right[0] / 0.1, 6);
    expect(axes.left[1]).toBeCloseTo(axes.right[1] / 0.1, 6);
  });

  it('keeps every point of both series on the chart, mirror included', () => {
    const axes = alignedAxes(coins, gld)!;
    // The mirror kept climbing after the last coin price; the right axis
    // must reach its top (420) and the left axis must still hold 3200.
    expect(axes.right[1]).toBeGreaterThanOrEqual(420);
    expect(axes.right[0]).toBeLessThanOrEqual(300);
    expect(axes.left[1]).toBeGreaterThanOrEqual(3200);
    expect(axes.left[0]).toBeLessThanOrEqual(3000);
    // Padding, not a hard edge: the extremes sit a little inside.
    expect(axes.right[1]).toBeGreaterThan(420);
    expect(axes.right[0]).toBeLessThan(300);
  });

  it('widens for a left point that is off the mirror, too', () => {
    // A coin price far above what the ratio predicts still fits.
    const axes = alignedAxes([...coins, pt('2026-02-01', 5000)], gld)!;
    expect(axes.left[1]).toBeGreaterThanOrEqual(5000);
    expect(axes.right[1]).toBeGreaterThanOrEqual(500); // 5000 * 0.1
  });

  it('returns null without an overlapping date or without left data', () => {
    expect(alignedAxes(coins, [pt('2026-01-15', 350)])).toBeNull();
    expect(alignedAxes([], gld)).toBeNull();
  });
});
