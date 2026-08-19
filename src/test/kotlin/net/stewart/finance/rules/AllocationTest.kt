package net.stewart.finance.rules

import io.kotest.property.Arb
import io.kotest.property.arbitrary.int
import io.kotest.property.arbitrary.list
import io.kotest.property.arbitrary.long
import io.kotest.property.arbitrary.map
import io.kotest.property.checkAll
import java.math.BigDecimal
import kotlinx.coroutines.runBlocking
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.SecurityId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

private val CLASSES = listOf("Cash", "US Stock", "Non US Stock", "Bond", "Other")

private fun usd(s: String) = Money.of(s, CurrencyUnit.USD)

private fun position(id: Long, ticker: String, value: String, vararg weights: Pair<String, String>) =
    ClassifiedPosition(
        SecurityId(id),
        ticker,
        usd(value),
        weights.associate { (k, v) -> k to Fraction.of(v) },
    )

class AllocationTest {

    @Test
    fun `distributes positions, sweeps to Cash, unclassified to Other`() {
        val report = currentAllocation(
            CLASSES,
            listOf(
                position(1, "VTI", "1000", "US Stock" to "0.7", "Bond" to "0.3"),
                position(2, "MYSTERY", "50"),
            ),
            sweeps = usd("25"),
        )
        val byName = report.buckets.associateBy { it.className }
        assertEquals(usd("25.00"), byName.getValue("Cash").value)
        assertEquals(usd("700.00"), byName.getValue("US Stock").value)
        assertEquals(usd("300.00"), byName.getValue("Bond").value)
        assertEquals(usd("50.00"), byName.getValue("Other").value)
        assertEquals(usd("0"), byName.getValue("Non US Stock").value)
        assertEquals(usd("1075.00"), report.total)
        assertEquals(listOf(SecurityId(2)), report.unclassified)
        // 700 / 1075 at fraction scale 4
        assertEquals(Fraction.of("0.6512"), byName.getValue("US Stock").fraction)
        // The sweeps contribution is synthetic: no security id.
        val sweeps = byName.getValue("Cash").contributions.single()
        assertEquals(SWEEPS_TICKER, sweeps.ticker)
        assertEquals(null, sweeps.securityId)
    }

    @Test
    fun `an odd unit lands deterministically in class order`() {
        val report = currentAllocation(
            CLASSES,
            listOf(position(1, "X", "0.0001", "US Stock" to "0.5", "Bond" to "0.5")),
            sweeps = usd("0"),
        )
        val byName = report.buckets.associateBy { it.className }
        assertEquals(usd("0.0001"), byName.getValue("US Stock").value)
        assertEquals(usd("0"), byName.getValue("Bond").value)
    }

    @Test
    fun `buckets always sum to positions plus sweeps`() = runBlocking<Unit> {
        val arbPosition = Arb.long(0L..10_000_000L).map { cents ->
            // Rotate through a few weight shapes to vary the maps.
            val weights = when (cents % 4) {
                0L -> arrayOf("US Stock" to "0.7", "Bond" to "0.3")
                1L -> arrayOf("US Stock" to "0.3333", "Non US Stock" to "0.3333", "Other" to "0.3334")
                2L -> arrayOf("Bond" to "0.9", "Cash" to "0.1")
                else -> emptyArray()
            }
            position(1 + cents % 7, "T$cents", BigDecimal.valueOf(cents, 2).toPlainString(), *weights)
        }
        checkAll(Arb.list(arbPosition, 0..8), Arb.long(0L..1_000_000L)) { positions, sweepCents ->
            val sweeps = Money.of(BigDecimal.valueOf(sweepCents, 2), CurrencyUnit.USD)
            val report = currentAllocation(CLASSES, positions, sweeps)
            val expected = positions.fold(sweeps) { acc, p -> acc + p.value }
            assertEquals(expected, report.total)
            assertEquals(expected, report.buckets.fold(Money.zero(CurrencyUnit.USD)) { a, b -> a + b.value })
        }
    }

    @Test
    fun `unknown class in a weight map is rejected`() {
        assertFailsWith<IllegalArgumentException> {
            currentAllocation(
                CLASSES,
                listOf(position(1, "X", "100", "Commodities" to "1")),
                sweeps = usd("0"),
            )
        }
    }

    @Test
    fun `empty portfolio reports zero fractions`() {
        val report = currentAllocation(CLASSES, emptyList(), sweeps = usd("0"))
        assertEquals(usd("0"), report.total)
        assertTrue(report.buckets.all { it.fraction == Fraction.ZERO })
    }

    @Test
    fun `drift targets partition the total and deltas sum to zero`() {
        val report = currentAllocation(
            CLASSES,
            listOf(
                position(1, "VTI", "1000", "US Stock" to "0.7", "Bond" to "0.3"),
                position(2, "MYSTERY", "50"),
            ),
            sweeps = usd("25"),
        )
        val entries = drift(
            report,
            mapOf(
                "Cash" to Fraction.of("0.1"),
                "US Stock" to Fraction.of("0.5"),
                "Bond" to Fraction.of("0.3"),
                "Other" to Fraction.of("0.1"),
            ),
        )
        val byName = entries.associateBy { it.className }
        assertEquals(usd("107.50"), byName.getValue("Cash").target)
        assertEquals(usd("537.50"), byName.getValue("US Stock").target)
        assertEquals(usd("82.50"), byName.getValue("Cash").delta)     // 107.50 − 25
        assertEquals(usd("-162.50"), byName.getValue("US Stock").delta)
        assertEquals(usd("1075.00"), entries.fold(Money.zero(CurrencyUnit.USD)) { a, e -> a + e.target })
        assertEquals(usd("0"), entries.fold(Money.zero(CurrencyUnit.USD)) { a, e -> a + e.delta })
    }

    @Test
    fun `drift deltas sum to zero for arbitrary portfolios`() = runBlocking<Unit> {
        val target = mapOf(
            "Cash" to Fraction.of("0.05"),
            "US Stock" to Fraction.of("0.55"),
            "Non US Stock" to Fraction.of("0.15"),
            "Bond" to Fraction.of("0.2"),
            "Other" to Fraction.of("0.05"),
        )
        checkAll(Arb.list(Arb.long(0L..10_000_000L), 1..6), Arb.int(0..3)) { centsList, shape ->
            val positions = centsList.mapIndexed { i, cents ->
                val weights = when ((cents + shape) % 3) {
                    0L -> arrayOf("US Stock" to "1")
                    1L -> arrayOf("Bond" to "0.5", "Cash" to "0.5")
                    else -> arrayOf("Non US Stock" to "0.25", "Other" to "0.75")
                }
                position(i + 1L, "T$i", BigDecimal.valueOf(cents, 2).toPlainString(), *weights)
            }
            val report = currentAllocation(CLASSES, positions, usd("0"))
            val entries = drift(report, target)
            assertEquals(report.total, entries.fold(Money.zero(CurrencyUnit.USD)) { a, e -> a + e.target })
            assertEquals(usd("0"), entries.fold(Money.zero(CurrencyUnit.USD)) { a, e -> a + e.delta })
        }
    }

    @Test
    fun `drift rejects a target naming an unknown class`() {
        val report = currentAllocation(CLASSES, emptyList(), usd("0"))
        assertFailsWith<IllegalArgumentException> {
            drift(report, mapOf("Commodities" to Fraction.ONE))
        }
    }
}
