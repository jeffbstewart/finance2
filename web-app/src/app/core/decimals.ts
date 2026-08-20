// Exact-decimal string helpers (house rule: no float arithmetic on
// wire values — docs/design/initial-build-scope.md §2). Percent ↔
// fraction conversion is a decimal-point shift on the string, never a
// division.

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/** True when `s` is a plain non-negative decimal like "33.33". */
export function isDecimalString(s: string): boolean {
  return DECIMAL_PATTERN.test(s.trim());
}

/** Shift the decimal point `places` to the left: "33.33" → "0.3333" for 2. */
export function shiftLeft(s: string, places: number): string {
  const trimmed = s.trim();
  if (!isDecimalString(trimmed)) throw new Error(`not a decimal: ${s}`);
  const [whole, frac = ''] = trimmed.split('.');
  const digits = whole + frac;
  const point = whole.length - places;
  const padded = point <= 0 ? '0'.repeat(1 - point) + digits : digits;
  const at = point <= 0 ? 1 : point;
  return trimZeros(`${padded.slice(0, at)}.${padded.slice(at)}`);
}

/** Shift the decimal point `places` to the right: "0.3333" → "33.33" for 2. */
export function shiftRight(s: string, places: number): string {
  const trimmed = s.trim();
  if (!isDecimalString(trimmed)) throw new Error(`not a decimal: ${s}`);
  const [whole, frac = ''] = trimmed.split('.');
  const padded = frac.padEnd(places, '0');
  return trimZeros(`${whole}${padded.slice(0, places)}.${padded.slice(places)}`);
}

/** Percent entered by the user ("33.33") as a wire fraction ("0.3333"). */
export function percentToFraction(percent: string): string {
  return shiftLeft(percent, 2);
}

/** Wire fraction ("0.3333") as a percent for form display ("33.33"). */
export function fractionToPercent(fraction: string): string {
  return shiftRight(fraction, 2);
}

/**
 * A decimal string as a BigInt scaled by 10^scale, for exact sums and
 * comparisons (quantities use scale 8 — build-scope §2). Throws when
 * the value has more fractional digits than the scale.
 */
export function toScaledBigInt(s: string, scale: number): bigint {
  const trimmed = s.trim();
  if (!isDecimalString(trimmed)) throw new Error(`not a decimal: ${s}`);
  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > scale) throw new Error(`more than ${scale} decimal places: ${s}`);
  return BigInt(whole + frac.padEnd(scale, '0'));
}

function trimZeros(s: string): string {
  let out = s;
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  out = out.replace(/^0+(?=\d)/, '');
  if (out === '') out = '0';
  if (out.startsWith('.')) out = '0' + out;
  return out;
}
