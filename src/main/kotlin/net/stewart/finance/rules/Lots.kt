package net.stewart.finance.rules

import java.time.LocalDate
import net.stewart.finance.domain.LotId
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SaleId

// The lot & gains engine (FUNCTIONAL_SPEC §5.1–§5.3): pure functions
// over the Phase 2 value types — no database, no clock, no I/O. This
// is the tax record's arithmetic for taxable accounts (build-scope
// §1); tax-deferred accounts never enter here.
//
// Cost pro-rating uses Money.allocateBy throughout, so a lot's
// purchase costs and a sale's costs are distributed penny-exactly:
// the parts always sum back to the whole.

/**
 * The tax rule: held long-term when held *more than* one year,
 * computed calendar-correctly (the legacy tree disagreed with itself —
 * ">1 year" in one path, ">366 days" in another; spec §5.1 picks the
 * former).
 */
fun heldLongTerm(dateBought: LocalDate, asOf: LocalDate): Boolean =
    asOf.isAfter(dateBought.plusYears(1))

/** Lots with |stillHeld| at or below this are closed (spec §5.1). */
val CLOSED_TOLERANCE: Quantity = Quantity.of("0.0001")

/** One purchase lot. All money is in the lot's (= account's) currency. */
data class Lot(
    val id: LotId,
    val dateBought: LocalDate,
    val quantity: Quantity,
    val pricePerShare: Money,
    val purchaseCosts: Money,
) {
    init {
        require(quantity.signum() > 0) { "lot $id quantity must be positive: $quantity" }
        require(pricePerShare.currency == purchaseCosts.currency) {
            "lot $id mixes currencies: ${pricePerShare.currency} vs ${purchaseCosts.currency}"
        }
        require(pricePerShare.signum() >= 0) { "lot $id price must not be negative" }
        require(purchaseCosts.signum() >= 0) { "lot $id purchase costs must not be negative" }
    }
}

/** Shares taken from one lot by a sale. */
data class SaleAllocation(
    val lotId: LotId,
    val shares: Quantity,
) {
    init {
        require(shares.signum() > 0) { "allocation from lot $lotId must sell a positive quantity" }
    }
}

/** One sale of one ticker from one account, allocated across lots. */
data class Sale(
    val id: SaleId,
    val saleDate: LocalDate,
    val pricePerShare: Money,
    val saleCosts: Money,
    val allocations: List<SaleAllocation>,
) {
    init {
        require(allocations.isNotEmpty()) { "sale $id has no lot allocations" }
        require(allocations.map { it.lotId }.toSet().size == allocations.size) {
            "sale $id allocates the same lot twice"
        }
        require(pricePerShare.currency == saleCosts.currency) {
            "sale $id mixes currencies: ${pricePerShare.currency} vs ${saleCosts.currency}"
        }
        require(pricePerShare.signum() >= 0) { "sale $id price must not be negative" }
        require(saleCosts.signum() >= 0) { "sale $id costs must not be negative" }
    }

    fun totalShares(): Quantity =
        allocations.fold(Quantity.ZERO) { acc, a -> acc + a.shares }
}

/**
 * The computed present state of one lot given the sales against it.
 * [stillHeldCosts] and the per-sale entries of [soldCosts] partition
 * [Lot.purchaseCosts] exactly (one joint allocation over shares sold
 * per sale plus the remainder).
 */
data class LotState(
    val lot: Lot,
    val sharesSold: Quantity,
    val stillHeld: Quantity,
    val closed: Boolean,
    val stillHeldCosts: Money,
    /** Purchase costs pro-rated to each sale that consumed this lot. */
    val soldCosts: Map<SaleId, Money>,
) {
    /** stillHeld × purchase price + pro-rated purchase costs (spec §5.1). */
    val basis: Money =
        lot.pricePerShare * openShares() + stillHeldCosts

    /** stillHeld clamped to zero for valuation of (tolerably) overshot lots. */
    fun openShares(): Quantity = if (stillHeld.signum() < 0) Quantity.ZERO else stillHeld
}

/**
 * Computes a lot's state. Sales are processed in (date, id) order so
 * the cost partition is deterministic regardless of input order.
 * Overselling beyond [CLOSED_TOLERANCE] is a caller bug — validate
 * with [validateSaleAllocations] before recording a sale.
 */
fun lotState(lot: Lot, sales: List<Sale>): LotState {
    val takes = sales
        .sortedWith(compareBy({ it.saleDate }, { it.id.value }))
        .mapNotNull { sale ->
            sale.allocations.firstOrNull { it.lotId == lot.id }?.let { sale.id to it.shares }
        }
    val sharesSold = takes.fold(Quantity.ZERO) { acc, (_, shares) -> acc + shares }
    val stillHeld = lot.quantity - sharesSold
    check(stillHeld.signum() >= 0 || stillHeld.abs() <= CLOSED_TOLERANCE) {
        "lot ${lot.id} oversold: ${lot.quantity} bought, $sharesSold sold"
    }
    val remainderWeight = if (stillHeld.signum() < 0) Quantity.ZERO else stillHeld
    val parts = lot.purchaseCosts.allocateBy(takes.map { it.second.amount } + listOf(remainderWeight.amount))
    return LotState(
        lot = lot,
        sharesSold = sharesSold,
        stillHeld = stillHeld,
        closed = stillHeld.abs() <= CLOSED_TOLERANCE,
        stillHeldCosts = parts.last(),
        soldCosts = takes.map { it.first }.zip(parts.dropLast(1)).toMap(),
    )
}

/** The per-(sale, lot) gain detail behind the tax report (spec §5.3). */
data class SaleLotGain(
    val saleId: SaleId,
    val lotId: LotId,
    val dateBought: LocalDate,
    val saleDate: LocalDate,
    val shares: Quantity,
    val buyPricePerShare: Money,
    val salePricePerShare: Money,
    val proRatedPurchaseCosts: Money,
    val apportionedSaleCosts: Money,
    val gain: Money,
    val longTerm: Boolean,
)

/**
 * Gains for every (sale, lot) pair: (salePrice − buyPrice) × shares −
 * pro-rated purchase costs − sale costs apportioned across the sale's
 * lots proportionally to shares sold (spec §4.2, §5.3). Long/short
 * term classifies by holding period at the sale date.
 */
fun saleGains(lots: List<Lot>, sales: List<Sale>): List<SaleLotGain> {
    val lotsById = lots.associateBy { it.id }
    val purchaseCostShares = lots.associate { lot -> lot.id to lotState(lot, sales).soldCosts }
    return sales.flatMap { sale ->
        val saleCostParts = sale.saleCosts.allocateBy(sale.allocations.map { it.shares.amount })
        sale.allocations.zip(saleCostParts).map { (allocation, saleCostPart) ->
            val lot = requireNotNull(lotsById[allocation.lotId]) {
                "sale ${sale.id} references unknown lot ${allocation.lotId}"
            }
            val proRated = purchaseCostShares.getValue(lot.id).getValue(sale.id)
            SaleLotGain(
                saleId = sale.id,
                lotId = lot.id,
                dateBought = lot.dateBought,
                saleDate = sale.saleDate,
                shares = allocation.shares,
                buyPricePerShare = lot.pricePerShare,
                salePricePerShare = sale.pricePerShare,
                proRatedPurchaseCosts = proRated,
                apportionedSaleCosts = saleCostPart,
                gain = (sale.pricePerShare - lot.pricePerShare) * allocation.shares -
                    proRated - saleCostPart,
                longTerm = heldLongTerm(lot.dateBought, sale.saleDate),
            )
        }
    }
}

/** The per-ticker aggregate across a position's open lots (spec §5.1–§5.2). */
data class Position(
    val shares: Quantity,
    val shortTermShares: Quantity,
    val longTermShares: Quantity,
    val basis: Money,
    val currentValue: Money,
    val shortTermGain: Money,
    val longTermGain: Money,
)

/**
 * Aggregates open lots at [currentPrice] as of [asOf]. A lot's
 * still-held shares are all the same age, so each open lot lands
 * whole in the short- or long-term bucket by its purchase date —
 * which also makes spec §5.1's "long-term consumed first" rule hold
 * trivially: within one lot there is never a mixed-age remainder.
 */
fun position(lots: List<Lot>, sales: List<Sale>, currentPrice: Money, asOf: LocalDate): Position {
    val zero = Money.zero(currentPrice.currency)
    var shares = Quantity.ZERO
    var stShares = Quantity.ZERO
    var ltShares = Quantity.ZERO
    var basis = zero
    var value = zero
    var stGain = zero
    var ltGain = zero
    for (state in lots.map { lotState(it, sales) }.filterNot { it.closed }) {
        val open = state.openShares()
        val lotValue = currentPrice * open
        val lotGain = lotValue - state.basis
        shares += open
        basis += state.basis
        value += lotValue
        if (heldLongTerm(state.lot.dateBought, asOf)) {
            ltShares += open
            ltGain += lotGain
        } else {
            stShares += open
            stGain += lotGain
        }
    }
    return Position(shares, stShares, ltShares, basis, value, stGain, ltGain)
}

/**
 * Server-side validation for recording a sale (guard rail §5.9,
 * fixing legacy defect 7): every allocation targets a known open lot,
 * never exceeds that lot's still-held shares, and the per-lot amounts
 * sum exactly to the sale's total. Throws [IllegalArgumentException]
 * with a message fit for an INVALID_ARGUMENT status.
 */
fun validateSaleAllocations(
    states: List<LotState>,
    allocations: List<SaleAllocation>,
    totalShares: Quantity,
) {
    require(allocations.isNotEmpty()) { "a sale must take shares from at least one lot" }
    require(allocations.map { it.lotId }.toSet().size == allocations.size) {
        "a sale may take shares from each lot only once"
    }
    val statesById = states.associateBy { it.lot.id }
    for (allocation in allocations) {
        val state = requireNotNull(statesById[allocation.lotId]) {
            "unknown lot ${allocation.lotId}"
        }
        require(allocation.shares <= state.stillHeld) {
            "lot ${allocation.lotId} holds only ${state.stillHeld} shares; " +
                "cannot sell ${allocation.shares}"
        }
    }
    val allocated = allocations.fold(Quantity.ZERO) { acc, a -> acc + a.shares }
    require(allocated == totalShares) {
        "per-lot amounts sum to $allocated but the sale is for $totalShares shares"
    }
}
