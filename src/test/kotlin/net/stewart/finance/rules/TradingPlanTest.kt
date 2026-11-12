package net.stewart.finance.rules

import io.kotest.property.Arb
import io.kotest.property.arbitrary.int
import io.kotest.property.arbitrary.long
import io.kotest.property.checkAll
import java.math.BigDecimal
import java.time.LocalDate
import kotlinx.coroutines.runBlocking
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.LotId
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TradingPlanTest {

    private val today = LocalDate.of(2026, 8, 22)
    private val classes = listOf("US Stock", "Bond", "Cash", "Other")
    private fun usd(v: String) = Money.of(v, CurrencyUnit.USD)
    private val identity: (Money) -> Money = { it }

    private val brokerage = PlanAccount(AccountId(1), "Brokerage", CurrencyUnit.USD, taxDeferred = false, sweep = usd("1000.00"))
    private val ira = PlanAccount(AccountId(2), "Roth IRA", CurrencyUnit.USD, taxDeferred = true, sweep = usd("500.00"))
    private val vti = PlanSecurity(SecurityId(10), "VTI", CurrencyUnit.USD, usd("200.00"), mapOf("US Stock" to Fraction.ONE), boughtInDollars = false)
    private val bond = PlanSecurity(SecurityId(11), "BONDX", CurrencyUnit.USD, usd("10.00"), mapOf("Bond" to Fraction.ONE), boughtInDollars = true)

    // Brokerage holds 10 VTI in two lots (5 at 100 bought long ago, 5 at 180 bought recently); IRA holds 100 BONDX.
    private val vtiLots = listOf(
        Lot(LotId(1), LocalDate.of(2020, 1, 15), Quantity.of("5"), usd("100.00"), usd("0")),
        Lot(LotId(2), LocalDate.of(2026, 6, 1), Quantity.of("5"), usd("180.00"), usd("0")),
    )
    private val holdings = listOf(
        PlanHolding(brokerage.id, vti.id, Quantity.of("10"), lots = vtiLots),
        PlanHolding(ira.id, bond.id, Quantity.of("100")),
    )
    private val targets = mapOf("US Stock" to Fraction.of("0.6"), "Bond" to Fraction.of("0.3"), "Cash" to Fraction.of("0.1"))

    private fun project(steps: List<PlanStep>) = projectPlan(
        steps, listOf(brokerage, ira), listOf(vti, bond), holdings, classes, targets, CurrencyUnit.USD, identity, today,
    )

    /** Class values partition the total exactly; fractions are scale-4,
     *  so their sum is one within rounding. */
    private fun assertPartition(p: Projection) {
        assertEquals(p.projectedTotal, p.classes.fold(usd("0")) { a, c -> a + c.after }, "after values sum to the total")
        assertEquals(p.currentTotal, p.classes.fold(usd("0")) { a, c -> a + c.before }, "before values sum to the total")
        val sum = p.classes.fold(BigDecimal.ZERO) { a, c -> a + c.afterFraction.value }
        assertTrue((BigDecimal.ONE - sum).abs() <= BigDecimal("0.0005"), "fractions sum to one within scale-4 rounding: $sum")
    }

    @Test
    fun `with no steps before equals after and fractions sum to one`() {
        val p = project(emptyList())
        // 10 VTI x 200 + 100 BONDX x 10 + sweeps 1500 = 4500.
        assertEquals(usd("4500.00"), p.currentTotal)
        assertEquals(p.currentTotal, p.projectedTotal)
        for (c in p.classes) {
            assertEquals(c.before, c.after, c.className)
            assertEquals(c.beforeFraction, c.afterFraction, c.className)
        }
        assertPartition(p)
        assertTrue(p.executable)
        assertEquals(usd("1000.00"), p.accounts.first { it.account.id == brokerage.id }.sweepAfter)
    }

    @Test
    fun `a buy moves value from cash to the class and the total is conserved`() {
        val p = project(listOf(PlanStep(1, StepKind.BUY, ira.id, securityId = vti.id, amount = usd("400.00"))))
        assertEquals(p.currentTotal, p.projectedTotal)
        val step = p.steps.single()
        assertEquals(Quantity.of("2"), step.shares) // whole shares: 400 / 200
        assertEquals(usd("400.00"), step.amount)
        assertEquals(usd("100.00"), p.accounts.first { it.account.id == ira.id }.sweepAfter)
        val us = p.classes.first { it.className == "US Stock" }
        assertEquals(us.before + usd("400.00"), us.after)
        val cash = p.classes.first { it.className == "Cash" }
        assertEquals(cash.before - usd("400.00"), cash.after)
        assertTrue(p.executable)
        assertNull(step.estShortTermGain)
    }

    @Test
    fun `a dollar buy of a fund keeps fractional shares`() {
        val p = project(listOf(PlanStep(1, StepKind.BUY, ira.id, securityId = bond.id, amount = usd("25.00"))))
        assertEquals(Quantity.of("2.5"), p.steps.single().shares)
    }

    @Test
    fun `a taxable sell estimates the gain FIFO through the lot rules`() {
        // Sell 7 VTI at 200: lot 1 (5 at 100, long-term) -> +500 LT; lot 2 (2 at 180, short-term) -> +40 ST.
        val p = project(listOf(PlanStep(1, StepKind.SELL, brokerage.id, securityId = vti.id, shares = Quantity.of("7"))))
        val step = p.steps.single()
        assertEquals(usd("1400.00"), step.amount)
        assertEquals(usd("500.00"), step.estLongTermGain)
        assertEquals(usd("40.00"), step.estShortTermGain)
        assertEquals(usd("2400.00"), p.accounts.first { it.account.id == brokerage.id }.sweepAfter)
        assertEquals(p.currentTotal, p.projectedTotal)
        assertTrue(p.executable)
    }

    @Test
    fun `a tax-deferred sell estimates nothing and selling more than held is a problem`() {
        val ok = project(listOf(PlanStep(1, StepKind.SELL, ira.id, securityId = bond.id, shares = Quantity.of("10"))))
        assertNull(ok.steps.single().estShortTermGain)
        assertTrue(ok.executable)
        val over = project(listOf(PlanStep(1, StepKind.SELL, ira.id, securityId = bond.id, shares = Quantity.of("101"))))
        assertFalse(over.executable)
        assertTrue(over.steps.single().problems.single().contains("holds 100 BONDX"))
    }

    @Test
    fun `transfers move cash between accounts and flag an overdraw without adjusting`() {
        val p = project(listOf(PlanStep(1, StepKind.TRANSFER, ira.id, toAccountId = brokerage.id, amount = usd("800.00"))))
        assertEquals(usd("-300.00"), p.accounts.first { it.account.id == ira.id }.sweepAfter)
        assertEquals(usd("1800.00"), p.accounts.first { it.account.id == brokerage.id }.sweepAfter)
        assertFalse(p.executable)
        assertEquals(p.currentTotal, p.projectedTotal)
    }

    @Test
    fun `external adds and draws change the total by exactly their amount`() {
        val p = project(
            listOf(
                PlanStep(1, StepKind.ADD_EXTERNAL, brokerage.id, amount = usd("2000.00"), note = "Q3 contribution"),
                PlanStep(2, StepKind.DRAW_EXTERNAL, ira.id, amount = usd("300.00"), note = "RMD"),
            )
        )
        assertEquals(usd("2000.00"), p.externalIn)
        assertEquals(usd("300.00"), p.externalOut)
        assertEquals(p.currentTotal + usd("1700.00"), p.projectedTotal)
        assertTrue(p.executable)
    }

    @Test
    fun `steps apply in position order - a buy funded by an earlier add is fine, by a later one is not`() {
        val add = PlanStep(1, StepKind.ADD_EXTERNAL, ira.id, amount = usd("1000.00"))
        val buy = PlanStep(2, StepKind.BUY, ira.id, securityId = vti.id, shares = Quantity.of("7")) // 1400 > 500 sweep
        assertTrue(project(listOf(add, buy)).executable)
        assertFalse(project(listOf(add.copy(position = 2), buy.copy(position = 1))).executable)
    }

    @Test
    fun `value is conserved across any sequence of buys and sells`() = runBlocking<Unit> {
        checkAll(
            Arb.int(1..6),               // steps
            Arb.long(1L..400L),          // dollars per step
            Arb.int(0..1),               // starting side
        ) { count, dollars, side ->
            val steps = (1..count).map { i ->
                val sell = (i + side) % 2 == 0
                PlanStep(
                    i, if (sell) StepKind.SELL else StepKind.BUY, ira.id,
                    securityId = bond.id, amount = usd(BigDecimal.valueOf(dollars).setScale(2).toPlainString()),
                )
            }
            val p = project(steps)
            // Sells of a fund bought in dollars never exceed what an earlier buy put there
            // only by chance; either way the TOTAL is unchanged by trading.
            assertEquals(p.currentTotal, p.projectedTotal)
            assertPartition(p)
        }
    }
}
