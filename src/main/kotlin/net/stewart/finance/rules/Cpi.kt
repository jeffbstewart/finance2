package net.stewart.finance.rules

import java.math.BigDecimal
import java.math.MathContext
import java.time.LocalDate
import java.time.YearMonth
import java.time.temporal.ChronoUnit
import net.stewart.finance.domain.Money

// Inflation adjustment (FUNCTIONAL_SPEC §5.7): US CPI-U monthly index
// points (FRED series CPIAUCSL), linearly interpolated for arbitrary
// dates, with flat extrapolation for a bounded window around the data
// (publication lag) and a hard error outside it. Applied at
// presentation time in one consistent direction — the conversion is
// amount × Index(destination) / Index(origin).

/** Months of flat extrapolation allowed before the first data point. */
const val CPI_FLAT_MONTHS_BEFORE = 2L

/** Months of flat extrapolation allowed after the last data point. */
const val CPI_FLAT_MONTHS_AFTER = 4L

private val INTERNAL = MathContext.DECIMAL64

/**
 * A monthly CPI index series, each point anchored at the first of its
 * month. Missing months are permitted — the published CPIAUCSL series
 * really has a hole (October 2025, the federal-shutdown gap) — and
 * interpolation simply spans them: the index for a date between two
 * known points is linear in days across the whole span.
 */
class CpiSeries(points: Map<YearMonth, BigDecimal>) {

    private val anchors: List<LocalDate>
    private val values: List<BigDecimal>

    init {
        require(points.isNotEmpty()) { "CPI series is empty" }
        require(points.values.all { it.signum() > 0 }) { "CPI index values must be positive" }
        val sorted = points.keys.sorted()
        anchors = sorted.map { it.atDay(1) }
        values = sorted.map { points.getValue(it) }
    }

    val firstMonth: YearMonth get() = YearMonth.from(anchors.first())
    val lastMonth: YearMonth get() = YearMonth.from(anchors.last())

    /**
     * The index for [date]: linear interpolation between the known
     * points surrounding it. Dates up to [CPI_FLAT_MONTHS_BEFORE]
     * months before the first point or [CPI_FLAT_MONTHS_AFTER] months
     * after the last extrapolate flat; anything further out throws.
     */
    fun indexOn(date: LocalDate): BigDecimal {
        val month = YearMonth.from(date)
        if (month < firstMonth) {
            require(month >= firstMonth.minusMonths(CPI_FLAT_MONTHS_BEFORE)) {
                "$date is before CPI coverage (first point $firstMonth)"
            }
            return values.first()
        }
        if (date >= anchors.last()) {
            require(month <= lastMonth.plusMonths(CPI_FLAT_MONTHS_AFTER)) {
                "$date is past CPI coverage (last point $lastMonth)"
            }
            return values.last()
        }
        // Largest anchor <= date, and the next one after it.
        val found = anchors.binarySearch(date)
        val i = if (found >= 0) found else -found - 2
        val span = BigDecimal(ChronoUnit.DAYS.between(anchors[i], anchors[i + 1]))
        val elapsed = BigDecimal(ChronoUnit.DAYS.between(anchors[i], date))
        return values[i] + (values[i + 1] - values[i]).multiply(elapsed, INTERNAL).divide(span, INTERNAL)
    }

    /**
     * Re-expresses [amount] from [origin]-date dollars in
     * [destination]-date dollars: amount × Index(destination) /
     * Index(origin), HALF_EVEN to money scale.
     */
    fun convert(amount: Money, origin: LocalDate, destination: LocalDate): Money {
        if (origin == destination) return amount
        val ratio = indexOn(destination).divide(indexOn(origin), INTERNAL)
        return Money.rounded(amount.amount.multiply(ratio, INTERNAL), amount.currency)
    }
}

/**
 * Parses a FRED-style CSV export ("DATE,CPIAUCSL" header, then
 * `yyyy-MM-dd,value` rows, dates on the first of each month). Rows
 * with FRED's "." marker or an empty value — how the shutdown-gap
 * month is published — are skipped. Values parse as exact decimals —
 * never floats.
 */
fun parseFredCsv(text: String): CpiSeries = CpiSeries(parseFredCsvPoints(text))

/** The raw month→index points of a FRED CSV, for persistence. */
fun parseFredCsvPoints(text: String): Map<YearMonth, BigDecimal> {
    val points = mutableMapOf<YearMonth, BigDecimal>()
    for ((lineNumber, raw) in text.lineSequence().withIndex()) {
        val line = raw.trim()
        if (line.isEmpty()) continue
        if (lineNumber == 0) continue // header
        val cells = line.split(',')
        require(cells.size == 2) { "CPI CSV line ${lineNumber + 1} is not two columns: \"$line\"" }
        val value = cells[1].trim()
        if (value.isEmpty() || value == ".") continue
        val date = LocalDate.parse(cells[0].trim())
        require(date.dayOfMonth == 1) { "CPI CSV line ${lineNumber + 1} is not a first-of-month date: $date" }
        val month = YearMonth.from(date)
        require(month !in points) { "CPI CSV repeats month $month" }
        points[month] = BigDecimal(value)
    }
    return points
}
