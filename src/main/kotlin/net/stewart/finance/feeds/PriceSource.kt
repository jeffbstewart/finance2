package net.stewart.finance.feeds

import java.math.BigDecimal
import java.time.LocalDate
import net.stewart.finance.domain.MarketSource

/**
 * One provider daily bar (spec sec. 6.1's field list). Amounts are exact
 * decimals parsed from the provider's raw JSON literals - the SDKs'
 * float fields are the known trap (house rules). Providers that omit
 * corporate actions report dividend 0 / split 1.
 */
data class DailyBar(
    val date: LocalDate,
    val open: BigDecimal,
    val high: BigDecimal,
    val low: BigDecimal,
    val close: BigDecimal,
    val adjustedClose: BigDecimal,
    val dividend: BigDecimal,
    val splitCoefficient: BigDecimal,
    val volume: Long,
)

/** Typed quota detection (spec sec. 6.1): triggers provider failover. */
class QuotaExceededException(source: MarketSource, message: String) :
    Exception("$source quota exceeded: $message")

/** Any other provider failure (network, auth, bad payload). */
class PriceSourceException(message: String, cause: Throwable? = null) :
    Exception(message, cause)

/** A pluggable market-data provider (Decision 4). */
interface PriceSource {
    val id: MarketSource

    /**
     * Daily bars for [ticker] from [startDate] (null = full history),
     * date-ascending. Throws [QuotaExceededException] on quota and
     * [PriceSourceException] on anything else; an unknown ticker is an
     * empty list.
     */
    fun dailyBars(ticker: String, startDate: LocalDate?): List<DailyBar>
}
