package net.stewart.finance.api

import java.time.LocalDate
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.Money
import net.stewart.finance.proto.Date as DateProto
import net.stewart.finance.proto.Decimal as DecimalProto
import net.stewart.finance.proto.FormattedDecimal
import net.stewart.finance.proto.FormattedMoney
import net.stewart.finance.proto.Money as MoneyProto
import net.stewart.finance.proto.Provenance

// Domain → wire mapping. The exact value crosses as a decimal string
// (proto common.proto's no-float rule); sort_key is the one deliberate
// double in the contract, a presentation sort key only.

fun Money.toProto(): MoneyProto = MoneyProto.newBuilder()
    .setAmount(DecimalProto.newBuilder().setValue(toWire()))
    .setCurrencyCode(currency.code)
    .build()

fun Money.toFormatted(): FormattedMoney = FormattedMoney.newBuilder()
    .setExact(toProto())
    .setDisplay(display())
    .setSortKey(amount.toDouble())
    .build()

fun Fraction.toProto(): DecimalProto = DecimalProto.newBuilder().setValue(toWire()).build()

/** Fractions display as percentages (e.g. 0.2534 → "25.34%"). */
fun Fraction.toFormattedPercent(): FormattedDecimal = FormattedDecimal.newBuilder()
    .setExact(toProto())
    .setDisplay(value.movePointRight(2).stripTrailingZeros().toPlainString() + "%")
    .setSortKey(value.toDouble())
    .build()

fun LocalDate.toProto(): DateProto = DateProto.newBuilder()
    .setYear(year)
    .setMonth(monthValue)
    .setDay(dayOfMonth)
    .build()

/** Throws java.time.DateTimeException on an impossible date. */
fun DateProto.toLocalDate(): LocalDate = LocalDate.of(year, month, day)

fun provenanceOf(source: String, asOf: LocalDate?): Provenance {
    val builder = Provenance.newBuilder().setSource(source)
    asOf?.let { builder.setAsOf(it.toProto()) }
    return builder.build()
}
