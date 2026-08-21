// Builders for the wire's Formatted* wrappers (docs/design/
// ui-testing.md). Hand-writing exact/display/sortKey triples in every
// spec invites inconsistency; these keep the three views coherent the
// way the server does.
import { create } from '@bufbuild/protobuf';
import {
  DateSchema,
  DecimalSchema,
  FormattedDateSchema,
  FormattedDecimalSchema,
  FormattedMoneySchema,
  MoneySchema,
  type Date as CivilDateMsg,
  type Decimal,
  type FormattedDate,
  type FormattedDecimal,
  type FormattedMoney,
} from '../proto-gen/common_pb';

export function decimal(value: string): Decimal {
  return create(DecimalSchema, { value });
}

/** "1234.5" → display "$1,234.50" style is NOT reproduced — pass the
 *  display you want asserted; it defaults to a plain "$<value>". */
export function money(
  value: string,
  options: { currency?: string; display?: string } = {},
): FormattedMoney {
  const currency = options.currency ?? 'USD';
  return create(FormattedMoneySchema, {
    exact: create(MoneySchema, { amount: decimal(value), currencyCode: currency }),
    display: options.display ?? `$${value}`,
    sortKey: Number(value),
  });
}

export function fraction(value: string, display?: string): FormattedDecimal {
  return create(FormattedDecimalSchema, {
    exact: decimal(value),
    display: display ?? `${Number(value) * 100}%`,
    sortKey: Number(value),
  });
}

/** A plain decimal such as an FX rate: display is the number itself. */
export function rate(value: string): FormattedDecimal {
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return quantity(value, trimmed);
}

export function quantity(value: string, display?: string): FormattedDecimal {
  return create(FormattedDecimalSchema, {
    exact: decimal(value),
    display: display ?? value,
    sortKey: Number(value),
  });
}

/** iso "2026-08-15" → civil Date message. */
export function civil(iso: string): CivilDateMsg {
  const [year, month, day] = iso.split('-').map(Number);
  return create(DateSchema, { year, month, day });
}

export function date(iso: string): FormattedDate {
  const [year, month, day] = iso.split('-').map(Number);
  return create(FormattedDateSchema, {
    exact: civil(iso),
    display: iso,
    sortKey: year * 10000 + month * 100 + day,
  });
}
