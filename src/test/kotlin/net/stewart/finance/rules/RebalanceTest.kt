package net.stewart.finance.rules

import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

private val CLASSES = listOf("Cash", "US Stock", "Non US Stock", "Bond", "Other")

private fun usd(s: String) = Money.of(s, CurrencyUnit.USD)

private fun security(
    id: Long,
    ticker: String,
    price: String,
    mutualFund: Boolean,
    vararg weights: Pair<String, String>,
) = PlannerSecurity(
    SecurityId(id),
    ticker,
    usd(price),
    mutualFund,
    weights.associate { (k, v) -> k to Fraction.of(v) },
)

private val VTI = security(1, "VTI", "100", false, "US Stock" to "1")
private val BND = security(2, "BND", "80", false, "Bond" to "1")
private val VBTLX = security(3, "VBTLX", "11", true, "Bond" to "1")

private val TARGET = mapOf(
    "Cash" to Fraction.of("0.1"),
    "US Stock" to Fraction.of("0.6"),
    "Bond" to Fraction.of("0.3"),
)

/** $500 of VTI plus $500 sweeps: a cash-heavy 50/50 portfolio. */
private fun cashHeavyReport() = currentAllocation(
    CLASSES,
    listOf(ClassifiedPosition(SecurityId(1), "VTI", usd("500"), mapOf("US Stock" to Fraction.ONE))),
    sweeps = usd("500"),
)

class RebalanceTest {

    @Test
    fun `buy-only mode never plans below the current total`() {
        // Nothing is overweight: US at 500/0.6 = 833.33 < the current
        // 1000, so the plan scores against the current total.
        val plan = scoreRebalance(
            cashHeavyReport(), TARGET, listOf(VTI, BND, VBTLX),
            trades = emptyList(), availableSweeps = usd("500"), addedFunds = usd("0"),
        )
        assertEquals(usd("1000.00"), plan.rebalanceTotal)
        assertEquals(usd("1000.00"), plan.currentTotal)
    }

    @Test
    fun `buy-only mode grows the total to cover an overweight class`() {
        val report = currentAllocation(
            CLASSES,
            listOf(ClassifiedPosition(SecurityId(1), "VTI", usd("900"), mapOf("US Stock" to Fraction.ONE))),
            sweeps = usd("100"),
        )
        val plan = scoreRebalance(
            report, TARGET, listOf(VTI, BND), emptyList(), usd("100"), usd("0"),
        )
        // US at 900 exceeds 60% of 1000; the smallest total putting it
        // on target without selling is 900 / 0.6.
        assertEquals(usd("1500.00"), plan.rebalanceTotal)
        val us = plan.classes.single { it.className == "US Stock" }
        assertEquals(usd("900.00"), us.target)
        assertTrue(us.atOrOverTarget)
        assertEquals(usd("0"), us.residual)
    }

    @Test
    fun `added funds set the rebalance total directly`() {
        val plan = scoreRebalance(
            cashHeavyReport(), TARGET, listOf(VTI, BND), emptyList(), usd("500"), usd("500"),
        )
        assertEquals(usd("1500.00"), plan.rebalanceTotal)
        assertEquals(usd("500.00"), plan.addedFunds)
        assertEquals(usd("1000.00"), plan.remaining) // 500 sweeps + 500 added − 0 spent
    }

    @Test
    fun `whole-share trades score their class and the plan totals`() {
        val plan = scoreRebalance(
            cashHeavyReport(), TARGET, listOf(VTI, BND, VBTLX),
            trades = listOf(PlannedTrade(TradeSide.BUY, SecurityId(1), shares = Quantity.of("1"))),
            availableSweeps = usd("500"), addedFunds = usd("0"),
        )
        val us = plan.classes.single { it.className == "US Stock" }
        assertEquals(usd("100.00"), us.spent)
        assertEquals(usd("600.00"), us.after)
        assertEquals(Fraction.of("0.6"), us.afterFraction)
        assertEquals(usd("600.00"), us.target) // 0.6 of the 1000 total
        assertEquals(usd("0"), us.residual)
        assertTrue(us.atOrOverTarget)
        assertEquals(usd("100.00"), plan.spent)
        assertEquals(usd("400.00"), plan.remaining)
        assertEquals(Quantity.of("1"), plan.trades.single().shares)
    }

    @Test
    fun `mutual funds buy in dollars and derive shares`() {
        val plan = scoreRebalance(
            cashHeavyReport(), TARGET, listOf(VTI, VBTLX),
            trades = listOf(PlannedTrade(TradeSide.BUY, SecurityId(3), cost = usd("100"))),
            availableSweeps = usd("500"), addedFunds = usd("0"),
        )
        val trade = plan.trades.single()
        assertEquals(usd("100.00"), trade.cost)
        assertEquals(Quantity.of("9.09090909"), trade.shares) // 100 / 11 at scale 8
        assertEquals(usd("100.00"), plan.classes.single { it.className == "Bond" }.spent)
    }

    @Test
    fun `candidates are concentrated funds ordered by weight with floored suggestions`() {
        val plan = scoreRebalance(
            cashHeavyReport(), TARGET, listOf(VTI, BND, VBTLX),
            trades = emptyList(), availableSweeps = usd("500"), addedFunds = usd("0"),
        )
        val bond = plan.classes.single { it.className == "Bond" }
        // Bond needs its full $300 target; both bond funds qualify
        // (weight 1 ≥ 0.9), tied weights order by ticker.
        assertEquals(listOf("BND", "VBTLX"), bond.candidates.map { it.ticker })
        val bnd = bond.candidates[0]
        assertEquals(Quantity.of("3"), bnd.suggestedShares) // ⌊300 / 80⌋
        assertEquals(usd("240.00"), bnd.cost)
        assertEquals(Quantity.of("27"), bond.candidates[1].suggestedShares) // ⌊300 / 11⌋
        // VTI is not a bond candidate; the Cash class has none.
        assertTrue(plan.classes.single { it.className == "Cash" }.candidates.isEmpty())
    }

    @Test
    fun `a class at target suggests zero shares`() {
        val plan = scoreRebalance(
            cashHeavyReport(), TARGET, listOf(VTI, BND),
            trades = listOf(PlannedTrade(TradeSide.BUY, SecurityId(2), shares = Quantity.of("4"))),
            availableSweeps = usd("500"), addedFunds = usd("0"),
        )
        val bond = plan.classes.single { it.className == "Bond" }
        assertEquals(usd("320.00"), bond.after)
        assertTrue(bond.atOrOverTarget)
        assertEquals(Quantity.ZERO, bond.candidates.single { it.ticker == "BND" }.suggestedShares)
    }

    @Test
    fun `class spending always sums to the trades' costs`() {
        val blended = security(4, "BLEND", "10", false, "US Stock" to "0.7", "Bond" to "0.3")
        val plan = scoreRebalance(
            cashHeavyReport(), TARGET, listOf(VTI, blended),
            trades = listOf(PlannedTrade(TradeSide.BUY, SecurityId(4), shares = Quantity.of("3"))),
            availableSweeps = usd("500"), addedFunds = usd("0"),
        )
        assertEquals(usd("30.00"), plan.spent)
        val classSpent = plan.classes.fold(Money.zero(CurrencyUnit.USD)) { a, c -> a + c.spent }
        assertEquals(plan.spent, classSpent)
        assertEquals(usd("21.00"), plan.classes.single { it.className == "US Stock" }.spent)
        assertEquals(usd("9.00"), plan.classes.single { it.className == "Bond" }.spent)
    }

    @Test
    fun `invalid trades are rejected`() {
        val report = cashHeavyReport()
        // Sell-side is reserved, not implemented.
        assertFailsWith<IllegalArgumentException> {
            scoreRebalance(
                report, TARGET, listOf(VTI),
                listOf(PlannedTrade(TradeSide.SELL, SecurityId(1), shares = Quantity.of("1"))),
                usd("0"), usd("0"),
            )
        }
        // Unknown security.
        assertFailsWith<IllegalArgumentException> {
            scoreRebalance(
                report, TARGET, listOf(VTI),
                listOf(PlannedTrade(TradeSide.BUY, SecurityId(99), shares = Quantity.of("1"))),
                usd("0"), usd("0"),
            )
        }
        // Non-funds buy whole shares.
        assertFailsWith<IllegalArgumentException> {
            scoreRebalance(
                report, TARGET, listOf(VTI),
                listOf(PlannedTrade(TradeSide.BUY, SecurityId(1), shares = Quantity.of("1.5"))),
                usd("0"), usd("0"),
            )
        }
        // Funds buy in dollars: a cost is required.
        assertFailsWith<IllegalArgumentException> {
            scoreRebalance(
                report, TARGET, listOf(VBTLX),
                listOf(PlannedTrade(TradeSide.BUY, SecurityId(3), shares = Quantity.of("1"))),
                usd("0"), usd("0"),
            )
        }
    }
}
