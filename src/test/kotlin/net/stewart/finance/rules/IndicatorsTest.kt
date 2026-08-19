package net.stewart.finance.rules

import java.time.LocalDate
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Money
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

private fun usd(s: String) = Money.of(s, CurrencyUnit.USD)

private fun history(vararg closes: String): List<ClosePoint> =
    closes.mapIndexed { i, c -> ClosePoint(LocalDate.parse("2026-01-01").plusDays(i.toLong()), usd(c)) }

class IndicatorsTest {

    @Test
    fun `sma is the rolling window mean`() {
        val points = sma(history("1", "2", "3", "4", "5"), window = 3)
        assertEquals(listOf(usd("2"), usd("3"), usd("4")), points.map { it.value })
        assertEquals(LocalDate.parse("2026-01-03"), points.first().date)
        assertEquals(LocalDate.parse("2026-01-05"), points.last().date)
    }

    @Test
    fun `ema seeds with the first window's mean`() {
        // window 3 -> k = 0.5: seed 2, then 4×0.5 + 2×0.5 = 3, then 5×0.5 + 3×0.5 = 4.
        val points = ema(history("1", "2", "3", "4", "5"), window = 3)
        assertEquals(listOf(usd("2"), usd("3"), usd("4")), points.map { it.value })
    }

    @Test
    fun `bollinger bands are mean plus and minus two population sigma`() {
        val points = bollingerBands(history("1", "2", "3"), window = 3)
        val p = points.single()
        // mean 2; population variance 2/3; σ ≈ 0.81649658.
        assertEquals(usd("2"), p.mean)
        assertEquals(usd("3.6330"), p.upper)
        assertEquals(usd("0.3670"), p.lower)
    }

    @Test
    fun `constant prices collapse the bands onto the mean`() {
        val points = bollingerBands(history("7", "7", "7", "7"), window = 3)
        assertTrue(points.all { it.mean == usd("7") && it.upper == usd("7") && it.lower == usd("7") })
    }

    @Test
    fun `histories shorter than the window yield no points`() {
        val short = history("1", "2")
        assertTrue(sma(short, window = 3).isEmpty())
        assertTrue(ema(short, window = 3).isEmpty())
        assertTrue(bollingerBands(short, window = 3).isEmpty())
    }

    @Test
    fun `default window is the spec's 20 samples`() {
        val flat = history(*Array(25) { "10" })
        val points = sma(flat)
        assertEquals(6, points.size) // 25 − 20 + 1
        assertTrue(points.all { it.value == usd("10") })
    }

    @Test
    fun `out-of-order history is rejected`() {
        val backwards = listOf(
            ClosePoint(LocalDate.parse("2026-01-02"), usd("1")),
            ClosePoint(LocalDate.parse("2026-01-01"), usd("2")),
        )
        assertFailsWith<IllegalArgumentException> { sma(backwards, window = 1) }
    }
}
