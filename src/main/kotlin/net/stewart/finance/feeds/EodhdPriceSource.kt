package net.stewart.finance.feeds

import java.math.BigDecimal
import java.time.LocalDate
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.stewart.finance.domain.MarketSource

/**
 * EODHD end-of-day client (Decision 4 fallback). The bar endpoint
 * carries OHLCV plus a split+dividend adjusted close, but not the
 * per-day corporate actions themselves — those are separate endpoints
 * we deliberately skip to preserve the 20-calls/day fallback budget,
 * so bars report dividend 0 / split 1 (the adjusted close is still
 * correct, which is what valuation and charts consume).
 */
class EodhdPriceSource(
    private val token: String,
    /** EODHD tickers carry an exchange suffix; the portfolio is US. */
    private val exchangeSuffix: String = "US",
    private val get: (String) -> HttpResult = { httpGetRaw(it) },
) : PriceSource {

    override val id: MarketSource = MarketSource.EODHD

    override fun dailyBars(ticker: String, startDate: LocalDate?): List<DailyBar> {
        val url = buildString {
            append("https://eodhd.com/api/eod/")
            append(java.net.URLEncoder.encode("$ticker.$exchangeSuffix", Charsets.UTF_8))
            append("?api_token=").append(token).append("&fmt=json")
            if (startDate != null) append("&from=").append(startDate)
        }
        val result = try {
            get(url)
        } catch (e: Exception) {
            throw PriceSourceException("eodhd request failed for $ticker", e)
        }
        when {
            result.status == 402 || result.status == 429 ->
                throw QuotaExceededException(id, "HTTP ${result.status}")
            result.status == 404 -> return emptyList()
            result.status != 200 -> throw PriceSourceException(
                "eodhd returned ${result.status} for $ticker"
            )
        }
        return try {
            Json.parseToJsonElement(result.body).jsonArray.map { element ->
                val bar = element.jsonObject
                DailyBar(
                    date = LocalDate.parse(bar.raw("date")),
                    open = BigDecimal(bar.raw("open")),
                    high = BigDecimal(bar.raw("high")),
                    low = BigDecimal(bar.raw("low")),
                    close = BigDecimal(bar.raw("close")),
                    adjustedClose = BigDecimal(bar.raw("adjusted_close")),
                    dividend = BigDecimal.ZERO,
                    splitCoefficient = BigDecimal.ONE,
                    volume = BigDecimal(bar.raw("volume")).toLong(),
                )
            }.sortedBy { it.date }
        } catch (e: Exception) {
            throw PriceSourceException("eodhd payload for $ticker did not parse", e)
        }
    }

    private fun kotlinx.serialization.json.JsonObject.raw(key: String): String =
        checkNotNull(this[key]) { "missing field $key" }.jsonPrimitive.content
}
