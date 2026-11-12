package net.stewart.finance.api

import io.grpc.Status
import io.grpc.StatusException
import java.time.LocalDate
import net.stewart.finance.db.FxRepository
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Money

/**
 * Converts amounts into the reporting currency (USD) through dated FX
 * rates - the only sanctioned path between currencies (build-scope
 * sec. 5). A missing rate is a FAILED_PRECONDITION, never a silent 1:1.
 */
class ReportingCurrency(
    private val fx: FxRepository,
    val currency: CurrencyUnit = CurrencyUnit.USD,
) {
    fun toReporting(amount: Money, asOf: LocalDate): Money {
        if (amount.currency == currency) return amount
        // Zero needs no rate - it is zero in any currency.
        if (amount.isZero()) return zero()
        val rate = fx.latestRate(amount.currency, currency, asOf)
            ?: throw StatusException(
                Status.FAILED_PRECONDITION.withDescription(
                    "no FX rate for ${amount.currency}->$currency on or before $asOf"
                )
            )
        return Money.rounded(amount.amount.multiply(rate), currency)
    }

    fun zero(): Money = Money.zero(currency)
}
