// Unit spec for core/dates.ts (docs/design/ui-testing.md, inventory
// "Core seams" and the cross-cutting date table): pure functions over
// the wire's { year, month, day } shape. The clock is pinned with
// vi.setSystemTime for todayCivil, and every Date here is built with
// the local-time constructor so the spec is timezone-agnostic — the
// point of these helpers is that a civil date never drifts a day
// through UTC.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { civilFromJs, isoDate, jsFromCivil, todayCivil, type CivilDate } from './dates';

describe('isoDate', () => {
  it('renders YYYY-MM-DD', () => {
    expect(isoDate({ year: 2026, month: 8, day: 21 })).toBe('2026-08-21');
  });

  it('zero-pads single-digit months and days', () => {
    expect(isoDate({ year: 2026, month: 1, day: 5 })).toBe('2026-01-05');
    expect(isoDate({ year: 2026, month: 12, day: 31 })).toBe('2026-12-31');
    expect(isoDate({ year: 2024, month: 2, day: 29 })).toBe('2024-02-29');
  });

  it('sorts lexicographically in chronological order', () => {
    // security-details-page.ts compares isoDate(point) >= cutoff as
    // strings to filter the price history, so this has to hold.
    const dates: CivilDate[] = [
      { year: 2026, month: 1, day: 5 },
      { year: 2025, month: 12, day: 31 },
      { year: 2026, month: 10, day: 1 },
      { year: 2026, month: 2, day: 9 },
    ];
    expect(dates.map(isoDate).sort()).toEqual([
      '2025-12-31',
      '2026-01-05',
      '2026-02-09',
      '2026-10-01',
    ]);
  });
});

describe('civilFromJs', () => {
  it('reads the local calendar fields with a 1-based month', () => {
    expect(civilFromJs(new Date(2026, 7, 21, 13, 45, 30))).toEqual({
      year: 2026,
      month: 8,
      day: 21,
    });
    expect(civilFromJs(new Date(2026, 0, 1, 0, 0, 0))).toEqual({
      year: 2026,
      month: 1,
      day: 1,
    });
  });

  it('ignores the time of day', () => {
    const midnight = new Date(2026, 5, 30, 0, 0, 0, 0);
    const lastMoment = new Date(2026, 5, 30, 23, 59, 59, 999);
    expect(civilFromJs(midnight)).toEqual(civilFromJs(lastMoment));
  });

  it('does not roll into the next day the way a UTC render would', () => {
    // The classic toISOString().slice(0, 10) bug: a late-evening local
    // Date west of Greenwich renders as tomorrow in UTC. The tax page
    // sends civilFromJs(datepicker value) straight to the server.
    const newYearsEve = new Date(2025, 11, 31, 23, 30, 0);
    expect(isoDate(civilFromJs(newYearsEve))).toBe('2025-12-31');
  });
});

describe('jsFromCivil', () => {
  it('returns local midnight of that civil day', () => {
    const d = jsFromCivil({ year: 2026, month: 1, day: 15 });
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(15);
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('round-trips every civil date back through civilFromJs', () => {
    // Datepicker dialogs (buy, private price, MTM) go civil → Date →
    // civil on every edit; leap days, month ends and DST weekends all
    // have to survive.
    const dates: CivilDate[] = [
      { year: 2024, month: 2, day: 29 },
      { year: 2025, month: 1, day: 1 },
      { year: 2025, month: 12, day: 31 },
      { year: 2026, month: 3, day: 8 },
      { year: 2026, month: 6, day: 30 },
      { year: 2026, month: 11, day: 1 },
    ];
    for (const d of dates) {
      expect(civilFromJs(jsFromCivil(d)), isoDate(d)).toEqual(d);
    }
  });

  it('drops the time of day on the way back from a Date', () => {
    const withTime = new Date(2026, 7, 21, 16, 5, 0);
    expect(jsFromCivil(civilFromJs(withTime)).getTime()).toBe(
      new Date(2026, 7, 21, 0, 0, 0, 0).getTime(),
    );
  });
});

describe('todayCivil', () => {
  afterEach(() => vi.useRealTimers());

  function pin(date: Date): void {
    vi.useFakeTimers();
    vi.setSystemTime(date);
  }

  it('reports the pinned local day with a 1-based month', () => {
    pin(new Date(2026, 6, 4, 12, 30, 0));
    expect(todayCivil()).toEqual({ year: 2026, month: 7, day: 4 });
  });

  it('reports January as month 1', () => {
    pin(new Date(2026, 0, 1, 0, 0, 1));
    expect(todayCivil()).toEqual({ year: 2026, month: 1, day: 1 });
  });

  it('stays on the local day late on New Year’s Eve', () => {
    // classification-editor.ts stamps asOf: todayCivil() — a UTC-based
    // "today" would file the save under the wrong year here.
    pin(new Date(2026, 11, 31, 23, 59, 59));
    expect(isoDate(todayCivil())).toBe('2026-12-31');
  });

  it('agrees with civilFromJs on the same instant', () => {
    const now = new Date(2026, 8, 9, 8, 15, 0);
    pin(now);
    expect(todayCivil()).toEqual(civilFromJs(now));
  });
});
