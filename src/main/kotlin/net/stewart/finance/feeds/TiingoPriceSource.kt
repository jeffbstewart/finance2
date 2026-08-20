package net.stewart.finance.feeds

import java.math.BigDecimal
import java.time.LocalDate
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.stewart.finance.domain.MarketSource

/**
 * Tiingo end-of-day client (Decision 4 primary). The response carries
 * spec §6.1's field list verbatim; numbers are read as raw JSON
 * literals into BigDecimal, never doubles.
 */
class TiingoPriceSource(
    private val token: String,
    private val get: (String) -> HttpResult = { httpGetRaw(it) },
) : PriceSource {

    override val id: MarketSource = MarketSource.TIINGO

    override fun dailyBars(ticker: String, startDate: LocalDate?): List<DailyBar> {
        val url = buildString {
            append("https://api.tiingo.com/tiingo/daily/")
            append(java.net.URLEncoder.encode(ticker, Charsets.UTF_8))
            append("/prices?token=").append(token)
            if (startDate != null) append("&startDate=").append(startDate)
        }
        val result = try {
            get(url)
        } catch (e: Exception) {
            throw PriceSourceException("tiingo request failed for $ticker", e)
        }
        when {
            result.status == 429 -> throw QuotaExceededException(id, "HTTP 429")
            result.status == 404 -> return emptyList()
            result.status != 200 -> throw PriceSourceException(
                "tiingo returned ${result.status} for $ticker"
            )
        }
        return try {
            Json.parseToJsonElement(result.body).jsonArray.map { element ->
                val bar = element.jsonObject
                DailyBar(
                    date = LocalDate.parse(bar.raw("date").substring(0, 10)),
                    open = BigDecimal(bar.raw("open")),
                    high = BigDecimal(bar.raw("high")),
                    low = BigDecimal(bar.raw("low")),
                    close = BigDecimal(bar.raw("close")),
                    adjustedClose = BigDecimal(bar.raw("adjClose")),
                    dividend = BigDecimal(bar.raw("divCash")),
                    splitCoefficient = BigDecimal(bar.raw("splitFactor")),
                    volume = BigDecimal(bar.raw("volume")).toLong(),
                )
            }.sortedBy { it.date }
        } catch (e: Exception) {
            throw PriceSourceException("tiingo payload for $ticker did not parse", e)
        }
    }

    private fun kotlinx.serialization.json.JsonObject.raw(key: String): String =
        checkNotNull(this[key]) { "missing field $key" }.jsonPrimitive.content
}
