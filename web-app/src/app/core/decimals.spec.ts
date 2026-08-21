// Unit spec for core/decimals.ts (docs/design/ui-testing.md, inventory
// "Core seams"): pure functions, no TestBed, no fake backend. These are
// the house no-float rule in code — every case here is chosen so that a
// float implementation would visibly disagree, and the expectations pin
// truncation (never rounding) and the trailing-zero trimming that the
// callers rely on.
import { describe, expect, it } from 'vitest';
import {
  divDecimal,
  fractionToPercent,
  fromScaledBigInt,
  isDecimalString,
  mulDecimal,
  percentToFraction,
  shiftLeft,
  shiftRight,
  toScaledBigInt,
} from './decimals';

describe('isDecimalString', () => {
  it('accepts plain non-negative decimals', () => {
    for (const value of ['0', '5', '33.33', '0.00000001', '007', '100.00']) {
      expect(isDecimalString(value), value).toBe(true);
    }
  });

  it('accepts a value with more digits than a double can hold', () => {
    expect(isDecimalString('12345678901234567890.12345678')).toBe(true);
  });

  it('ignores surrounding whitespace', () => {
    expect(isDecimalString('  33.33  ')).toBe(true);
    expect(isDecimalString('\t42\n')).toBe(true);
  });

  it('rejects negatives, exponents and other non-plain forms', () => {
    for (const value of [
      '',
      '   ',
      '-1',
      '-0.5',
      '+1',
      '1e3',
      '1E3',
      '1.5e-3',
      '.5',
      '5.',
      '1.2.3',
      '1,000',
      '1 2',
      'abc',
      'NaN',
      'Infinity',
      '0x10',
    ]) {
      expect(isDecimalString(value), value).toBe(false);
    }
  });
});

describe('shiftLeft', () => {
  it('moves the point left, borrowing zeros when the whole part runs out', () => {
    expect(shiftLeft('33.33', 2)).toBe('0.3333');
    expect(shiftLeft('5', 2)).toBe('0.05');
    expect(shiftLeft('5', 4)).toBe('0.0005');
    expect(shiftLeft('12.3', 5)).toBe('0.000123');
  });

  it('trims the zeros the shift exposes', () => {
    expect(shiftLeft('100', 2)).toBe('1');
    expect(shiftLeft('10.50', 2)).toBe('0.105');
    expect(shiftLeft('0', 2)).toBe('0');
    expect(shiftLeft('0.00', 2)).toBe('0');
  });

  it('normalizes a leading-zero input', () => {
    expect(shiftLeft('007.50', 2)).toBe('0.075');
  });

  it('is the identity for zero places', () => {
    expect(shiftLeft('33.33', 0)).toBe('33.33');
  });

  it('stays exact past double precision', () => {
    expect(shiftLeft('12345678901234567890.5', 2)).toBe('123456789012345678.905');
  });

  it('throws on anything that is not a plain decimal', () => {
    expect(() => shiftLeft('-1', 2)).toThrow(/not a decimal: -1/);
    expect(() => shiftLeft('1e3', 2)).toThrow(/not a decimal/);
  });
});

describe('shiftRight', () => {
  it('moves the point right, padding zeros when the fraction runs out', () => {
    expect(shiftRight('0.3333', 2)).toBe('33.33');
    expect(shiftRight('1', 2)).toBe('100');
    expect(shiftRight('12.3', 5)).toBe('1230000');
  });

  it('drops the leading zeros the shift exposes', () => {
    expect(shiftRight('0.05', 2)).toBe('5');
    expect(shiftRight('0.005', 2)).toBe('0.5');
    expect(shiftRight('0', 2)).toBe('0');
  });

  it('is the identity for zero places', () => {
    expect(shiftRight('0.3333', 0)).toBe('0.3333');
  });

  it('stays exact past double precision', () => {
    expect(shiftRight('0.12345678901234567890', 8)).toBe('12345678.90123456789');
  });

  it('throws on anything that is not a plain decimal', () => {
    expect(() => shiftRight('-0.5', 2)).toThrow(/not a decimal: -0.5/);
  });
});

describe('percentToFraction / fractionToPercent', () => {
  it('converts the way the wire expects', () => {
    expect(percentToFraction('33.33')).toBe('0.3333');
    expect(percentToFraction('100')).toBe('1');
    expect(percentToFraction('0')).toBe('0');
    expect(percentToFraction('7.5')).toBe('0.075');
    expect(fractionToPercent('0.3333')).toBe('33.33');
    expect(fractionToPercent('1')).toBe('100');
    expect(fractionToPercent('0')).toBe('0');
    expect(fractionToPercent('0.075')).toBe('7.5');
  });

  it('round-trips normalized percents', () => {
    for (const percent of ['0', '0.01', '7.5', '33.33', '40', '99.99', '100']) {
      expect(fractionToPercent(percentToFraction(percent)), percent).toBe(percent);
    }
  });

  it('round-trips fractions the server sends back', () => {
    for (const fraction of ['0', '0.0001', '0.1', '0.2', '0.4', '0.3333', '1']) {
      expect(percentToFraction(fractionToPercent(fraction)), fraction).toBe(fraction);
    }
  });

  it('feeds the sum-to-100 validators exactly', () => {
    // target-dialog.ts / classification-editor.ts: percents become
    // ten-thousandths, and the "currently X" message shifts them back.
    const percents = ['10', '40', '20', '20', '9.99'];
    const total = percents.reduce(
      (sum, p) => sum + Number(shiftRight(percentToFraction(p), 4)),
      0,
    );
    expect(total).toBe(9999);
    expect(shiftLeft(String(total), 2)).toBe('99.99');
    expect(shiftLeft(String(10000), 2)).toBe('100');
  });
});

describe('toScaledBigInt', () => {
  it('scales a decimal string to an integer', () => {
    expect(toScaledBigInt('1.5', 8)).toBe(150000000n);
    expect(toScaledBigInt('0', 8)).toBe(0n);
    expect(toScaledBigInt('0.00000001', 8)).toBe(1n);
    expect(toScaledBigInt('12', 2)).toBe(1200n);
    expect(toScaledBigInt('1234', 0)).toBe(1234n);
  });

  it('accepts exactly `scale` fractional digits and rejects one more', () => {
    expect(toScaledBigInt('1.12345678', 8)).toBe(112345678n);
    expect(() => toScaledBigInt('1.123456789', 8)).toThrow(
      /more than 8 decimal places/,
    );
  });

  it('rejects a fractional part at scale 0 even when it is only zeros', () => {
    // The sell dialog leans on this: "too many decimal places" is about
    // the written form, not the value.
    expect(() => toScaledBigInt('5.0', 0)).toThrow(/more than 0 decimal places/);
  });

  it('ignores surrounding whitespace', () => {
    expect(toScaledBigInt('  2.25  ', 8)).toBe(225000000n);
  });

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    expect(toScaledBigInt('12345678901234567890.12345678', 8)).toBe(
      1234567890123456789012345678n,
    );
  });

  it('throws on anything that is not a plain decimal', () => {
    expect(() => toScaledBigInt('-1', 8)).toThrow(/not a decimal: -1/);
    expect(() => toScaledBigInt('', 8)).toThrow(/not a decimal/);
  });
});

describe('fromScaledBigInt', () => {
  it('renders a scaled integer back to a decimal string', () => {
    expect(fromScaledBigInt(150000000n, 8)).toBe('1.5');
    expect(fromScaledBigInt(0n, 8)).toBe('0');
    expect(fromScaledBigInt(1n, 8)).toBe('0.00000001');
    expect(fromScaledBigInt(54075n, 2)).toBe('540.75');
    expect(fromScaledBigInt(1234n, 0)).toBe('1234');
  });

  it('keeps the sign on negative values', () => {
    expect(fromScaledBigInt(-150000000n, 8)).toBe('-1.5');
    expect(fromScaledBigInt(-1n, 8)).toBe('-0.00000001');
    expect(fromScaledBigInt(-1234n, 0)).toBe('-1234');
  });

  it('round-trips through toScaledBigInt', () => {
    for (const value of [
      '0',
      '0.00000001',
      '1.5',
      '540.75',
      '12345678901234567890.12345678',
    ]) {
      expect(fromScaledBigInt(toScaledBigInt(value, 8), 8), value).toBe(value);
    }
  });
});

describe('mulDecimal', () => {
  it('multiplies shares by price the way the rebalance dialog does', () => {
    expect(mulDecimal('3', '180.25', 2)).toBe('540.75');
    expect(mulDecimal('2.5', '4', 2)).toBe('10');
    expect(mulDecimal('12.5', '201.90', 4)).toBe('2523.75');
  });

  it('is exact where floats are not', () => {
    // 0.1 * 0.2 is 0.020000000000000004 in float arithmetic.
    expect(mulDecimal('0.1', '0.2', 8)).toBe('0.02');
    expect(mulDecimal('1.005', '100', 2)).toBe('100.5');
  });

  it('truncates to the output scale instead of rounding', () => {
    expect(mulDecimal('0.333', '3', 2)).toBe('0.99');
    expect(mulDecimal('0.999', '1', 2)).toBe('0.99');
    expect(mulDecimal('0.999', '1', 0)).toBe('0');
    expect(mulDecimal('1.5', '1.5', 1)).toBe('2.2');
  });

  it('multiplies by zero to zero', () => {
    expect(mulDecimal('0', '180.25', 2)).toBe('0');
    expect(mulDecimal('180.25', '0', 4)).toBe('0');
  });

  it('rejects operands finer than scale 8', () => {
    expect(() => mulDecimal('0.123456789', '2', 2)).toThrow(
      /more than 8 decimal places/,
    );
    expect(() => mulDecimal('2', '-1', 2)).toThrow(/not a decimal/);
  });
});

describe('divDecimal', () => {
  it('divides cost by price the way the rebalance dialog does', () => {
    expect(divDecimal('540.75', '180.25', 8)).toBe('3');
    expect(divDecimal('100', '8', 8)).toBe('12.5');
  });

  it('is exact where floats are not', () => {
    // 0.3 / 0.1 is 2.9999999999999996 in float arithmetic.
    expect(divDecimal('0.3', '0.1', 8)).toBe('3');
  });

  it('truncates to the output scale instead of rounding', () => {
    expect(divDecimal('10', '3', 2)).toBe('3.33');
    expect(divDecimal('10', '3', 0)).toBe('3');
    expect(divDecimal('2', '3', 8)).toBe('0.66666666');
    expect(divDecimal('1', '8', 2)).toBe('0.12');
  });

  it('divides zero by anything to zero', () => {
    expect(divDecimal('0', '180.25', 8)).toBe('0');
  });

  it('throws on division by zero, however the zero is written', () => {
    expect(() => divDecimal('100', '0', 8)).toThrow('division by zero');
    expect(() => divDecimal('100', '0.00000000', 8)).toThrow('division by zero');
  });

  it('rejects operands finer than scale 8', () => {
    expect(() => divDecimal('1', '0.123456789', 8)).toThrow(
      /more than 8 decimal places/,
    );
    expect(() => divDecimal('-1', '2', 8)).toThrow(/not a decimal/);
  });

  it('round-trips the dialog’s shares ↔ net cost recompute', () => {
    // rebalance-buy-dialog.ts: shares → cost at scale 4, cost → shares
    // at scale 8. Prices that divide evenly must survive the round trip.
    for (const [shares, price] of [
      ['3', '180.25'],
      ['12.5', '201.9'],
      ['0.25', '10'],
    ]) {
      const cost = mulDecimal(shares, price, 4);
      expect(divDecimal(cost, price, 8), `${shares} @ ${price}`).toBe(shares);
    }
  });
});
