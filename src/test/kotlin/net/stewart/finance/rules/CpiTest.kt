package net.stewart.finance.rules

import java.math.BigDecimal
import java.time.LocalDate
import java.time.YearMonth
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Money
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

private fun usd(s: String) = Money.of(s, CurrencyUnit.USD)

private fun series(vararg points: Pair<String, String>) = CpiSeries(
    points.associate { (month, index) -> YearMonth.parse(month) to BigDecimal(index) }
)

class CpiTest {

    private val cpi = series("2020-01" to "100", "2020-02" to "110")

    @Test
    fun `converts across month boundaries by index ratio`() {
        assertEquals(usd("110"), cpi.convert(usd("100"), LocalDate.parse("2020-01-01"), LocalDate.parse("2020-02-01")))
        assertEquals(usd("100"), cpi.convert(usd("110"), LocalDate.parse("2020-02-01"), LocalDate.parse("2020-01-01")))
    }

    @Test
    fun `interpolates linearly within a month`() {
        // Jan 16: 15 of 31 days elapsed -> 100 + 10 x 15/31 = 104.8387...
        assertEquals(
            usd("104.8387"),
            cpi.convert(usd("100"), LocalDate.parse("2020-01-01"), LocalDate.parse("2020-01-16")),
        )
    }

    @Test
    fun `same-date conversion is identity`() {
        val d = LocalDate.parse("2020-01-16")
        assertEquals(usd("123.45"), cpi.convert(usd("123.45"), d, d))
    }

    @Test
    fun `dates in the last month extrapolate flat`() {
        assertEquals(BigDecimal("110"), cpi.indexOn(LocalDate.parse("2020-02-15")))
    }

    @Test
    fun `bounded flat extrapolation before and after coverage`() {
        // Up to 2 months before the first point...
        assertEquals(BigDecimal("100"), cpi.indexOn(LocalDate.parse("2019-11-15")))
        assertFailsWith<IllegalArgumentException> { cpi.indexOn(LocalDate.parse("2019-10-31")) }
        // ...and 4 months after the last (publication lag).
        assertEquals(BigDecimal("110"), cpi.indexOn(LocalDate.parse("2020-06-30")))
        assertFailsWith<IllegalArgumentException> { cpi.indexOn(LocalDate.parse("2020-07-01")) }
    }

    @Test
    fun `series construction validates its shape`() {
        assertFailsWith<IllegalArgumentException> { series() }
        assertFailsWith<IllegalArgumentException> { series("2020-01" to "0") }
    }

    @Test
    fun `interpolation spans missing months (the 2025-10 CPIAUCSL gap)`() {
        val gapped = series("2020-01" to "100", "2020-03" to "120")
        // Feb 1 sits 31 of 60 days into the Jan->Mar span:
        // 100 + 20 x 31/60 = 110.333...
        assertEquals(
            usd("110.3333"),
            gapped.convert(usd("100"), LocalDate.parse("2020-01-01"), LocalDate.parse("2020-02-01")),
        )
    }

    @Test
    fun `parser skips empty values, the shutdown-gap publication form`() {
        val parsed = parseFredCsv(
            "DATE,CPIAUCSL\n2025-09-01,324.368\n2025-10-01,\n2025-11-01,326.0\n"
        )
        assertEquals(YearMonth.parse("2025-09"), parsed.firstMonth)
        assertEquals(YearMonth.parse("2025-11"), parsed.lastMonth)
    }

    @Test
    fun `parses FRED-style CSV exactly`() {
        val parsed = parseFredCsv(
            """
            DATE,CPIAUCSL
            2020-01-01,100
            2020-02-01,110.25
            2020-03-01,.
            """.trimIndent()
        )
        assertEquals(YearMonth.parse("2020-01"), parsed.firstMonth)
        assertEquals(YearMonth.parse("2020-02"), parsed.lastMonth)
        assertEquals(BigDecimal("110.25"), parsed.indexOn(LocalDate.parse("2020-02-01")))
    }

    @Test
    fun `rejects malformed CSV`() {
        assertFailsWith<IllegalArgumentException> {
            parseFredCsv("DATE,CPIAUCSL\n2020-01-15,100") // not first-of-month
        }
        assertFailsWith<IllegalArgumentException> {
            parseFredCsv("DATE,CPIAUCSL\n2020-01-01,100,extra")
        }
        assertFailsWith<IllegalArgumentException> {
            parseFredCsv("DATE,CPIAUCSL\n2020-01-01,100\n2020-01-01,101")
        }
    }
}
