package net.stewart.finance.rules

import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Money
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class MtmTest {

    private fun usd(value: String): Money = Money.of(value, CurrencyUnit.USD)

    @Test
    fun `gain year marks basis up to FMV as ordinary income`() {
        val result = computeMark(
            fmvUsd = usd("12000.0000"),
            basisBefore = usd("10000.0000"),
            acquisitionCostUsd = usd("10000.0000"),
        )
        assertEquals(usd("12000.0000"), result.basisAfter)
        assertEquals(usd("2000.0000"), result.ordinaryIncome)
    }

    @Test
    fun `loss above cost reverses prior inclusions as negative income`() {
        // Year 1 marked to 12000; year 2 FMV 10500 - still above the
        // 10000 cost, so the whole decline is allowed.
        val result = computeMark(
            fmvUsd = usd("10500.0000"),
            basisBefore = usd("12000.0000"),
            acquisitionCostUsd = usd("10000.0000"),
        )
        assertEquals(usd("10500.0000"), result.basisAfter)
        assertEquals(usd("-1500.0000"), result.ordinaryIncome)
    }

    @Test
    fun `loss below cost clamps at acquisition cost`() {
        // FMV crashes to 8000: only the unreversed inclusions
        // (basis 12000 - cost 10000) come back as loss; basis floors
        // at cost - build-scope sec. 11.
        val result = computeMark(
            fmvUsd = usd("8000.0000"),
            basisBefore = usd("12000.0000"),
            acquisitionCostUsd = usd("10000.0000"),
        )
        assertEquals(usd("10000.0000"), result.basisAfter)
        assertEquals(usd("-2000.0000"), result.ordinaryIncome)
    }

    @Test
    fun `first-year loss with no inclusions recognizes nothing`() {
        val result = computeMark(
            fmvUsd = usd("9000.0000"),
            basisBefore = usd("10000.0000"),
            acquisitionCostUsd = usd("10000.0000"),
        )
        assertEquals(usd("10000.0000"), result.basisAfter)
        assertEquals(usd("0.0000"), result.ordinaryIncome)
    }

    @Test
    fun `a mark sequence recovers exactly after a round trip`() {
        val cost = usd("10000.0000")
        val year1 = computeMark(usd("13000.0000"), cost, cost)
        val year2 = computeMark(usd("7000.0000"), year1.basisAfter, cost)
        val year3 = computeMark(usd("13000.0000"), year2.basisAfter, cost)
        // Cumulative ordinary income across the round trip equals
        // FMV - cost: +3000, -3000 (clamped), +3000.
        assertEquals(usd("3000.0000"), year1.ordinaryIncome)
        assertEquals(usd("-3000.0000"), year2.ordinaryIncome)
        assertEquals(usd("3000.0000"), year3.ordinaryIncome)
        assertEquals(usd("13000.0000"), year3.basisAfter)
    }

    @Test
    fun `corrupt chain with basis below cost is rejected`() {
        assertFailsWith<IllegalArgumentException> {
            computeMark(
                fmvUsd = usd("9000.0000"),
                basisBefore = usd("9500.0000"),
                acquisitionCostUsd = usd("10000.0000"),
            )
        }
    }
}
