package net.stewart.finance.api

import java.time.LocalDate
import net.stewart.finance.domain.EntrySource
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PricingLocus
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityType
import net.stewart.finance.proto.Date as DateProto
import net.stewart.finance.proto.Decimal as DecimalProto
import net.stewart.finance.proto.FormattedDate
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

/** Share/unit counts display with trailing zeros trimmed ("12.5", "3"). */
fun Quantity.toFormatted(): FormattedDecimal = FormattedDecimal.newBuilder()
    .setExact(DecimalProto.newBuilder().setValue(toWire()))
    .setDisplay(amount.stripTrailingZeros().toPlainString())
    .setSortKey(amount.toDouble())
    .build()

fun LocalDate.toProto(): DateProto = DateProto.newBuilder()
    .setYear(year)
    .setMonth(monthValue)
    .setDay(dayOfMonth)
    .build()

/** ISO display; sort key is yyyymmdd. */
fun LocalDate.toFormattedDate(): FormattedDate = FormattedDate.newBuilder()
    .setExact(toProto())
    .setDisplay(toString())
    .setSortKey((year * 10000 + monthValue * 100 + dayOfMonth).toDouble())
    .build()

/** Throws java.time.DateTimeException on an impossible date. */
fun DateProto.toLocalDate(): LocalDate = LocalDate.of(year, month, day)

fun SecurityType.toProto(): net.stewart.finance.proto.SecurityType = when (this) {
    SecurityType.STOCK -> net.stewart.finance.proto.SecurityType.STOCK
    SecurityType.ETF -> net.stewart.finance.proto.SecurityType.ETF
    SecurityType.MUTUAL_FUND -> net.stewart.finance.proto.SecurityType.MUTUAL_FUND
    SecurityType.PRIVATE -> net.stewart.finance.proto.SecurityType.PRIVATE_INVESTMENT
    SecurityType.UNKNOWN -> net.stewart.finance.proto.SecurityType.SECURITY_TYPE_UNSPECIFIED
}

fun PricingLocus.toProto(): net.stewart.finance.proto.PricingLocus = when (this) {
    PricingLocus.MARKET -> net.stewart.finance.proto.PricingLocus.MARKET
    PricingLocus.MANUAL -> net.stewart.finance.proto.PricingLocus.MANUAL
}

fun provenanceOf(source: EntrySource, asOf: LocalDate?): Provenance {
    val builder = Provenance.newBuilder().setSource(source.dbValue)
    asOf?.let { builder.setAsOf(it.toProto()) }
    return builder.build()
}
