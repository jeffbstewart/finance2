// Civil-date helpers for the wire's { year, month, day } shape
// (FUNCTIONAL_SPEC sec. 4.3: no time of day, no timezone).

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** `YYYY-MM-DD`, the chart axis / sort friendly form. */
export function isoDate(d: CivilDate): string {
  const mm = String(d.month).padStart(2, '0');
  const dd = String(d.day).padStart(2, '0');
  return `${d.year}-${mm}-${dd}`;
}

/** Today as a civil date in the browser's locale. */
export function todayCivil(): CivilDate {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** A JS Date (datepicker value) as a civil date. */
export function civilFromJs(date: Date): CivilDate {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

/** A civil date as a local-midnight JS Date for datepicker initial values. */
export function jsFromCivil(d: CivilDate): Date {
  return new Date(d.year, d.month - 1, d.day);
}
