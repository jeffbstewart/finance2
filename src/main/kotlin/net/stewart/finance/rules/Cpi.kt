package net.stewart.finance.rules

import java.math.BigDecimal
import java.math.MathContext
import java.time.LocalDate
import java.time.YearMonth
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
 * A contiguous monthly CPI index series. Each point is the index for
 * its month, anchored at the first of the month for interpolation.
 */
class CpiSeries(points: Map<YearMonth, BigDecimal>) {

    private val months: List<YearMonth>
    private val values: List<BigDecimal>

    init {
        require(points.isNotEmpty()) { "CPI series is empty" }
        require(points.values.all { it.signum() > 0 }) { "CPI index values must be positive" }
        months = points.keys.sorted()
        require(months.zipWithNext().all { (a, b) -> a.plusMonths(1) == b }) {
            "CPI series has gaps: months must be contiguous"
        }
        values = months.map { points.getValue(it) }
    }

    val firstMonth: YearMonth get() = months.first()
    val lastMonth: YearMonth get() = months.last()

    /**
     * The index for [date]: linear interpolation between the date's
     * month point and the next month's, both anchored at the first of
     * their month. Dates up to [CPI_FLAT_MONTHS_BEFORE]
     * months before the first point or [CPI_FLAT_MONTHS_AFTER] months
     * after the last extrapolate flat; anything further out throws.
     */
    fun indexOn(date: LocalDate): BigDecimal {
        val month = YearMonth.from(date)
        if (month < firstMonth) {
            require(month >= firstMonth.minusMonths(CPI_FLAT_MONTHS_BEFORE)) {
                "$date is before CPI coverage (first point ${firstMonth})"
            }
            return values.first()
        }
        if (month >= lastMonth) {
            require(month <= lastMonth.plusMonths(CPI_FLAT_MONTHS_AFTER)) {
                "$date is past CPI coverage (last point ${lastMonth})"
            }
            return values.last()
        }
        val i = months.indexOf(month)
        val start = values[i]
        val end = values[i + 1]
        val daysInMonth = BigDecimal(month.lengthOfMonth())
        val elapsed = BigDecimal(date.dayOfMonth - 1)
        return start + (end - start).multiply(elapsed, INTERNAL).divide(daysInMonth, INTERNAL)
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
 * with FRED's "." missing-value marker are skipped. Values parse as
 * exact decimals — never floats.
 */
fun parseFredCsv(text: String): CpiSeries {
    val points = mutableMapOf<YearMonth, BigDecimal>()
    for ((lineNumber, raw) in text.lineSequence().withIndex()) {
        val line = raw.trim()
        if (line.isEmpty()) continue
        if (lineNumber == 0) continue // header
        val cells = line.split(',')
        require(cells.size == 2) { "CPI CSV line ${lineNumber + 1} is not two columns: \"$line\"" }
        if (cells[1].trim() == ".") continue
        val date = LocalDate.parse(cells[0].trim())
        require(date.dayOfMonth == 1) { "CPI CSV line ${lineNumber + 1} is not a first-of-month date: $date" }
        val month = YearMonth.from(date)
        require(month !in points) { "CPI CSV repeats month $month" }
        points[month] = BigDecimal(cells[1].trim())
    }
    return CpiSeries(points)
}
