package net.stewart.finance.rules

import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.time.LocalDate
import net.stewart.finance.domain.Money

// Technical indicators (FUNCTIONAL_SPEC §5.8): computed over the
// date-ascending adjusted-close history with a 20-sample moving
// window. Pure functions; intermediate math runs in BigDecimal at
// DECIMAL64 precision and only the emitted points round to money
// scale — these are chart overlays, not stored values.

const val INDICATOR_WINDOW = 20

private val INTERNAL = MathContext.DECIMAL64

data class ClosePoint(val date: LocalDate, val close: Money)

data class IndicatorPoint(val date: LocalDate, val value: Money)

data class BollingerPoint(
    val date: LocalDate,
    val mean: Money,
    val upper: Money,
    val lower: Money,
)

private fun requireAscending(history: List<ClosePoint>) {
    for (i in 1 until history.size) {
        require(history[i - 1].date < history[i].date) {
            "history must be strictly date-ascending at ${history[i].date}"
        }
    }
}

/** Simple moving average: the mean of each [window]-sample window. */
fun sma(history: List<ClosePoint>, window: Int = INDICATOR_WINDOW): List<IndicatorPoint> {
    require(window > 0) { "window must be positive" }
    requireAscending(history)
    if (history.size < window) return emptyList()
    val currency = history.first().close.currency
    val divisor = BigDecimal(window)
    var sum = history.take(window).fold(BigDecimal.ZERO) { a, p -> a + p.close.amount }
    val points = ArrayList<IndicatorPoint>(history.size - window + 1)
    for (i in window - 1 until history.size) {
        if (i >= window) {
            sum += history[i].close.amount - history[i - window].close.amount
        }
        points.add(IndicatorPoint(history[i].date, Money.rounded(sum.divide(divisor, INTERNAL), currency)))
    }
    return points
}

/**
 * Exponential moving average: multiplier 2/(window+1), seeded with the
 * first window's mean (spec §5.8). The seed is the first emitted point.
 */
fun ema(history: List<ClosePoint>, window: Int = INDICATOR_WINDOW): List<IndicatorPoint> {
    require(window > 0) { "window must be positive" }
    requireAscending(history)
    if (history.size < window) return emptyList()
    val currency = history.first().close.currency
    val k = BigDecimal(2).divide(BigDecimal(window + 1), INTERNAL)
    val oneMinusK = BigDecimal.ONE - k
    var value = history.take(window)
        .fold(BigDecimal.ZERO) { a, p -> a + p.close.amount }
        .divide(BigDecimal(window), INTERNAL)
    val points = ArrayList<IndicatorPoint>(history.size - window + 1)
    points.add(IndicatorPoint(history[window - 1].date, Money.rounded(value, currency)))
    for (i in window until history.size) {
        value = history[i].close.amount.multiply(k, INTERNAL) + value.multiply(oneMinusK, INTERNAL)
        points.add(IndicatorPoint(history[i].date, Money.rounded(value, currency)))
    }
    return points
}

/**
 * Bollinger bands: window mean ± 2 population standard deviations,
 * plus the mean itself (spec §5.8).
 */
fun bollingerBands(history: List<ClosePoint>, window: Int = INDICATOR_WINDOW): List<BollingerPoint> {
    require(window > 0) { "window must be positive" }
    requireAscending(history)
    if (history.size < window) return emptyList()
    val currency = history.first().close.currency
    val divisor = BigDecimal(window)
    val two = BigDecimal(2)
    val points = ArrayList<BollingerPoint>(history.size - window + 1)
    for (i in window - 1 until history.size) {
        val slice = history.subList(i - window + 1, i + 1)
        val mean = slice.fold(BigDecimal.ZERO) { a, p -> a + p.close.amount }.divide(divisor, INTERNAL)
        val variance = slice
            .fold(BigDecimal.ZERO) { a, p ->
                val d = p.close.amount - mean
                a + d.multiply(d, INTERNAL)
            }
            .divide(divisor, INTERNAL)
        val twoSigma = variance.sqrt(INTERNAL).multiply(two, INTERNAL)
        points.add(
            BollingerPoint(
                date = slice.last().date,
                mean = Money.rounded(mean, currency),
                upper = Money.rounded(mean + twoSigma, currency),
                lower = Money.rounded(mean - twoSigma, currency),
            )
        )
    }
    return points
}
