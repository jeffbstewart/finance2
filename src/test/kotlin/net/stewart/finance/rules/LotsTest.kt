package net.stewart.finance.rules

import io.kotest.property.Arb
import io.kotest.property.arbitrary.int
import io.kotest.property.arbitrary.long
import io.kotest.property.checkAll
import java.math.BigDecimal
import java.time.LocalDate
import kotlinx.coroutines.runBlocking
import net.stewart.finance.domain.CurrencyMismatchException
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.LotId
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SaleId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

private fun usd(s: String) = Money.of(s, CurrencyUnit.USD)
private fun qty(s: String) = Quantity.of(s)

private fun lot(
    id: Long,
    bought: String,
    quantity: String,
    price: String,
    costs: String = "0",
) = Lot(LotId(id), LocalDate.parse(bought), qty(quantity), usd(price), usd(costs))

private fun sale(
    id: Long,
    date: String,
    price: String,
    costs: String,
    vararg allocations: Pair<Long, String>,
) = Sale(
    SaleId(id),
    LocalDate.parse(date),
    usd(price),
    usd(costs),
    allocations.map { (lotId, shares) -> SaleAllocation(LotId(lotId), qty(shares)) },
)

class LotsTest {

    // --- the long-term boundary (spec §5.1: more than one year) ---

    @Test
    fun `exactly one year is not long-term, one day more is`() {
        val bought = LocalDate.parse("2025-08-18")
        assertTrue(!heldLongTerm(bought, LocalDate.parse("2026-08-18")))
        assertTrue(heldLongTerm(bought, LocalDate.parse("2026-08-19")))
    }

    @Test
    fun `leap-day purchases resolve calendar-correctly`() {
        val bought = LocalDate.parse("2024-02-29")
        // plusYears(1) of Feb 29 is Feb 28, 2025.
        assertTrue(!heldLongTerm(bought, LocalDate.parse("2025-02-28")))
        assertTrue(heldLongTerm(bought, LocalDate.parse("2025-03-01")))
    }

    // --- lot state ---

    @Test
    fun `partial sale splits purchase costs penny-exactly`() {
        val theLot = lot(1, "2024-01-10", "10", "10.00", "10.00")
        val theSale = sale(1, "2026-07-01", "30.00", "9.00", 1L to "3")
        val state = lotState(theLot, listOf(theSale))
        assertEquals(qty("3"), state.sharesSold)
        assertEquals(qty("7"), state.stillHeld)
        assertTrue(!state.closed)
        assertEquals(usd("3.00"), state.soldCosts.getValue(SaleId(1)))
        assertEquals(usd("7.00"), state.stillHeldCosts)
        // basis = 7 × $10 + $7 pro-rated costs
        assertEquals(usd("77.00"), state.basis)
    }

    @Test
    fun `fully sold lot is closed with zero remainder costs`() {
        val theLot = lot(1, "2024-01-10", "10", "10.00", "10.00")
        val theSale = sale(1, "2026-07-01", "30.00", "0", 1L to "10")
        val state = lotState(theLot, listOf(theSale))
        assertTrue(state.closed)
        assertEquals(qty("0"), state.stillHeld)
        assertEquals(usd("0"), state.stillHeldCosts)
        assertEquals(usd("10.00"), state.soldCosts.getValue(SaleId(1)))
        assertEquals(usd("0"), state.basis)
    }

    @Test
    fun `residue within tolerance closes the lot`() {
        val theLot = lot(1, "2024-01-10", "10", "10.00")
        val theSale = sale(1, "2026-07-01", "30.00", "0", 1L to "9.9999")
        assertTrue(lotState(theLot, listOf(theSale)).closed)
    }

    @Test
    fun `purchase costs are conserved across any sale sequence`() = runBlocking {
        checkAll(
            Arb.long(10_000L..100_000_000L), // lot quantity in scale-4 units
            Arb.long(0L..1_000_000L),        // purchase costs in cents
            Arb.int(1..4),                   // number of sales
        ) { qtyUnits, costCents, saleCount ->
            val theLot = Lot(
                LotId(1),
                LocalDate.parse("2024-01-10"),
                Quantity.of(BigDecimal.valueOf(qtyUnits, 4)),
                usd("10.00"),
                Money.of(BigDecimal.valueOf(costCents, 2), CurrencyUnit.USD),
            )
            val perSaleUnits = qtyUnits / (saleCount + 1)
            val sales = (1..saleCount).map { i ->
                sale(
                    i.toLong(), "2026-0$i-15", "30.00", "0",
                    1L to BigDecimal.valueOf(perSaleUnits, 4).toPlainString(),
                )
            }
            val state = lotState(theLot, sales)
            val distributed = state.soldCosts.values.fold(state.stillHeldCosts) { a, b -> a + b }
            assertEquals(theLot.purchaseCosts, distributed)
        }
    }

    // --- sale gains ---

    @Test
    fun `gain subtracts both cost legs and classifies by holding period`() {
        val theLot = lot(1, "2024-01-10", "10", "10.00", "10.00")
        val theSale = sale(1, "2026-07-01", "30.00", "9.00", 1L to "3")
        val gains = saleGains(listOf(theLot), listOf(theSale))
        assertEquals(1, gains.size)
        val g = gains.single()
        // (30 − 10) × 3 − $3 pro-rated purchase costs − $9 sale costs
        assertEquals(usd("48.00"), g.gain)
        assertTrue(g.longTerm)
        assertEquals(usd("3.00"), g.proRatedPurchaseCosts)
        assertEquals(usd("9.00"), g.apportionedSaleCosts)
    }

    @Test
    fun `short-term when sold within a year`() {
        val theLot = lot(1, "2026-01-10", "10", "10.00")
        val theSale = sale(1, "2026-07-01", "30.00", "0", 1L to "3")
        assertTrue(!saleGains(listOf(theLot), listOf(theSale)).single().longTerm)
    }

    @Test
    fun `sale costs apportion across lots without losing a unit`() {
        val lots = listOf(
            lot(1, "2024-01-10", "10", "10.00"),
            lot(2, "2024-02-10", "10", "10.00"),
            lot(3, "2024-03-10", "10", "10.00"),
        )
        val theSale = sale(
            1, "2026-07-01", "30.00", "10.00",
            1L to "3", 2L to "3", 3L to "3",
        )
        val gains = saleGains(lots, listOf(theSale))
        assertEquals(
            listOf(usd("3.3334"), usd("3.3333"), usd("3.3333")),
            gains.map { it.apportionedSaleCosts },
        )
        val total = gains.map { it.apportionedSaleCosts }.reduce { a, b -> a + b }
        assertEquals(usd("10.00"), total)
    }

    // --- position aggregation ---

    @Test
    fun `position aggregates open lots into tax-class buckets`() {
        val lots = listOf(
            lot(1, "2024-01-10", "10", "10.00", "10.00"), // long-term after the sale below
            lot(2, "2026-06-01", "5", "20.00"),           // short-term
        )
        val sales = listOf(sale(1, "2026-07-01", "30.00", "9.00", 1L to "3"))
        val p = position(lots, sales, usd("25.00"), LocalDate.parse("2026-08-18"))
        assertEquals(qty("12"), p.shares)
        assertEquals(qty("7"), p.longTermShares)
        assertEquals(qty("5"), p.shortTermShares)
        assertEquals(usd("177.00"), p.basis)            // 77 + 100
        assertEquals(usd("300.00"), p.currentValue)     // 175 + 125
        assertEquals(usd("98.00"), p.longTermGain)      // 175 − 77
        assertEquals(usd("25.00"), p.shortTermGain)     // 125 − 100
    }

    @Test
    fun `closed lots drop out of the position`() {
        val lots = listOf(lot(1, "2024-01-10", "10", "10.00"))
        val sales = listOf(sale(1, "2026-07-01", "30.00", "0", 1L to "10"))
        val p = position(lots, sales, usd("25.00"), LocalDate.parse("2026-08-18"))
        assertEquals(qty("0"), p.shares)
        assertEquals(usd("0"), p.currentValue)
    }

    @Test
    fun `pricing a position in another currency throws`() {
        val lots = listOf(lot(1, "2024-01-10", "10", "10.00"))
        assertFailsWith<CurrencyMismatchException> {
            position(lots, emptyList(), Money.of("25.00", CurrencyUnit.EUR), LocalDate.parse("2026-08-18"))
        }
    }

    // --- sale validation (guard rail §5.9) ---

    @Test
    fun `validation accepts a coherent sale`() {
        val states = listOf(lotState(lot(1, "2024-01-10", "10", "10.00"), emptyList()))
        validateSaleAllocations(states, listOf(SaleAllocation(LotId(1), qty("4"))), qty("4"))
    }

    @Test
    fun `validation rejects overselling a lot`() {
        val states = listOf(lotState(lot(1, "2024-01-10", "10", "10.00"), emptyList()))
        assertFailsWith<IllegalArgumentException> {
            validateSaleAllocations(states, listOf(SaleAllocation(LotId(1), qty("11"))), qty("11"))
        }
    }

    @Test
    fun `validation rejects a total that disagrees with the allocations`() {
        val states = listOf(lotState(lot(1, "2024-01-10", "10", "10.00"), emptyList()))
        assertFailsWith<IllegalArgumentException> {
            validateSaleAllocations(states, listOf(SaleAllocation(LotId(1), qty("4"))), qty("5"))
        }
    }

    @Test
    fun `validation rejects unknown lots and duplicates`() {
        val states = listOf(lotState(lot(1, "2024-01-10", "10", "10.00"), emptyList()))
        assertFailsWith<IllegalArgumentException> {
            validateSaleAllocations(states, listOf(SaleAllocation(LotId(2), qty("1"))), qty("1"))
        }
        assertFailsWith<IllegalArgumentException> {
            validateSaleAllocations(
                states,
                listOf(SaleAllocation(LotId(1), qty("1")), SaleAllocation(LotId(1), qty("1"))),
                qty("2"),
            )
        }
    }

    @Test
    fun `overselling beyond tolerance is an engine-level failure`() {
        val theLot = lot(1, "2024-01-10", "10", "10.00")
        val theSale = sale(1, "2026-07-01", "30.00", "0", 1L to "10.5")
        assertFailsWith<IllegalStateException> { lotState(theLot, listOf(theSale)) }
    }
}
