package net.stewart.finance.api

import java.time.LocalDate
import net.stewart.finance.db.SecurityRow
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PricingLocus
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.domain.SecurityType
import net.stewart.finance.domain.TaxTreatment
import kotlin.test.Test
import kotlin.test.assertEquals

class SparklinesTest {

    private fun row(id: Long, ticker: String, mirrors: Long? = null) = SecurityRow(
        id = SecurityId(id), ticker = ticker, description = "", currency = CurrencyUnit.USD,
        securityType = SecurityType.COLLECTIVE_TRUST, pricingLocus = PricingLocus.MANUAL,
        taxTreatment = TaxTreatment.LOTS, netExpenseRatio = null as Fraction?, hidden = false,
        mirrorsSecurityId = mirrors?.let { SecurityId(it) },
    )

    private fun usd(v: String) = Money.of(v, CurrencyUnit.USD)
    private fun day(d: Int) = LocalDate.of(2026, 8, d)

    private val fund = row(1, "VTI")
    private val trust = row(2, "VTI-TR", mirrors = 1)
    private val byId = mapOf(fund.id to fund, trust.id to trust)

    // Ten daily closes for the fund; the trust has two statements at
    // exactly half the fund's level on those days.
    private val fundSeries = (1..10).map { DatedPrice(day(it), usd("${100 + it}.00")) }
    private val trustSeries = listOf(DatedPrice(day(3), usd("51.50")), DatedPrice(day(8), usd("54.00")))

    @Test
    fun `a security without a mirror, or with at least as many points, keeps its own line`() {
        val own = Sparklines.build(fund, mapOf(fund.id to fundSeries), byId)
        assertEquals(10, own.adjustedClosesCount)
        assertEquals("", own.proxyTicker)
        assertEquals(0, own.actualsCount)

        // The mirror has no more points than the trust: no borrowing.
        val sparse = Sparklines.build(trust, mapOf(fund.id to fundSeries.take(2), trust.id to trustSeries), byId)
        assertEquals(2, sparse.adjustedClosesCount)
        assertEquals("", sparse.proxyTicker)
    }

    @Test
    fun `a trust borrows the mirror's line and its own prices ride along as rescaled dots`() {
        val borrowed = Sparklines.build(trust, mapOf(fund.id to fundSeries, trust.id to trustSeries), byId)
        assertEquals("VTI", borrowed.proxyTicker)
        assertEquals(2, borrowed.ownPoints)
        assertEquals(fundSeries.map { it.price.toProto().amount }, borrowed.adjustedClosesList)
        // Day 3 -> index 2, day 8 -> index 7; the median ratio is 0.5, so
        // each dot lands on the fund's level: 51.50 / 0.5 = 103, 54 / 0.5 = 108.
        assertEquals(listOf(2, 7), borrowed.actualsList.map { it.index })
        assertEquals(listOf("103", "108"), borrowed.actualsList.map { it.value.value })
    }

    @Test
    fun `a statement dated before the mirror's window, or with no overlap, places no dot`() {
        val early = listOf(DatedPrice(LocalDate.of(2026, 7, 1), usd("50.00")), DatedPrice(day(5), usd("52.50")))
        val built = Sparklines.build(trust, mapOf(fund.id to fundSeries, trust.id to early), byId)
        assertEquals("VTI", built.proxyTicker)
        assertEquals(listOf(4), built.actualsList.map { it.index })

        val none = Sparklines.build(trust, mapOf(fund.id to fundSeries, trust.id to listOf(early[0])), byId)
        assertEquals("VTI", none.proxyTicker)
        assertEquals(0, none.actualsCount)
    }
}
