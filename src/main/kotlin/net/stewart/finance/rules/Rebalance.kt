package net.stewart.finance.rules

import java.math.BigDecimal
import java.math.RoundingMode
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityId

// The buy-side rebalance planner's scorer (FUNCTIONAL_SPEC §5.5,
// §9.14) as pure functions. Nothing is persisted — the output is a
// shopping list. All amounts are in the reporting currency; mixing
// currencies throws via the Money type.

/** How trades are expressed. SELL is reserved (build-scope §3): the
 *  shape must not foreclose sell-side planning, but scoring one today
 *  is rejected as unimplemented. */
enum class TradeSide { BUY, SELL }

/** A security the planner may buy, with its price and weight map. */
data class PlannerSecurity(
    val securityId: SecurityId,
    val ticker: String,
    val price: Money,
    /** Mutual funds are bought in dollars; everything else in whole
     *  shares (spec §5.5 — this distinction is load-bearing). */
    val mutualFund: Boolean,
    val weights: Map<String, Fraction>,
) {
    init {
        require(price.signum() > 0) { "$ticker has no positive price" }
        require(weights.isNotEmpty()) { "$ticker has no classification weights" }
        require(weights.values.all { it.signum() >= 0 }) { "$ticker has a negative weight" }
    }
}

/**
 * One tentative trade. For a mutual fund [cost] drives the trade
 * (shares derived); for anything else [shares] drives it (cost
 * derived) — pass the driving field, the other may be null.
 */
data class PlannedTrade(
    val side: TradeSide,
    val securityId: SecurityId,
    val shares: Quantity? = null,
    val cost: Money? = null,
)

/** A trade with both legs resolved. */
data class NormalizedTrade(
    val securityId: SecurityId,
    val ticker: String,
    val shares: Quantity,
    val cost: Money,
)

/** A fund concentrated (≥ 0.9) in the class, with a suggested buy. */
data class CandidateFund(
    val securityId: SecurityId,
    val ticker: String,
    val classWeight: Fraction,
    val suggestedShares: Quantity,
    val pricePerShare: Money,
    val cost: Money,
)

data class RebalanceClassScore(
    val className: String,
    val before: Money,
    /** Fraction of the *current* total. */
    val beforeFraction: Fraction,
    val spent: Money,
    val after: Money,
    /** Fraction of the *rebalance* total. */
    val afterFraction: Fraction,
    val target: Money,
    val targetFraction: Fraction,
    /** current + spent − target (spec §5.5's residual error). */
    val residual: Money,
    /** Disables the class's buy affordance in the UI. */
    val atOrOverTarget: Boolean,
    val candidates: List<CandidateFund>,
)

data class RebalancePlan(
    val classes: List<RebalanceClassScore>,
    val trades: List<NormalizedTrade>,
    val currentTotal: Money,
    val rebalanceTotal: Money,
    val addedFunds: Money,
    val spent: Money,
    /** availableSweeps + addedFunds − spent ("Still to Spend"). */
    val remaining: Money,
)

private val CANDIDATE_CONCENTRATION = Fraction.of("0.9")

/**
 * Scores the plan (spec §5.5). The rebalance total is current total +
 * added funds when funds were added; otherwise buy-only mode: the
 * smallest portfolio value at which the most overweight non-Cash
 * class reaches its target without selling — max over classes of
 * classValue / targetFraction, never below the current total (buying
 * from sweeps does not shrink the portfolio).
 *
 * Class targets partition the rebalance total via one allocateBy, and
 * each trade's cost partitions across classes by the security's
 * weight map, so spent-per-class always sums to the trades' costs.
 */
fun scoreRebalance(
    report: AllocationReport,
    targetFractions: Map<String, Fraction>,
    securities: List<PlannerSecurity>,
    trades: List<PlannedTrade>,
    availableSweeps: Money,
    addedFunds: Money,
    cashClass: String = "Cash",
): RebalancePlan {
    val currency = report.total.currency
    val zero = Money.zero(currency)
    val classNames = report.buckets.map { it.className }
    val securitiesById = securities.associateBy { it.securityId }
    securities.flatMap { it.weights.keys }.firstOrNull { it !in classNames }?.let {
        throw IllegalArgumentException("planner security weights unknown class \"$it\"")
    }
    targetFractions.keys.firstOrNull { it !in classNames }?.let {
        throw IllegalArgumentException("target names unknown class \"$it\"")
    }

    val normalized = trades.map { trade ->
        require(trade.side == TradeSide.BUY) { "sell-side planning is not implemented" }
        val security = requireNotNull(securitiesById[trade.securityId]) {
            "trade references unknown security ${trade.securityId}"
        }
        if (security.mutualFund) {
            val cost = requireNotNull(trade.cost) { "${security.ticker} is a mutual fund: buy in dollars" }
            require(cost.signum() > 0) { "${security.ticker} trade cost must be positive" }
            require(cost.currency == security.price.currency) {
                "${security.ticker} trade cost in ${cost.currency}, price in ${security.price.currency}"
            }
            val shares = Quantity.rounded(
                cost.amount.divide(security.price.amount, Quantity.SCALE, RoundingMode.HALF_EVEN)
            )
            NormalizedTrade(security.securityId, security.ticker, shares, cost)
        } else {
            val shares = requireNotNull(trade.shares) { "${security.ticker} is bought in whole shares" }
            require(shares.signum() > 0) { "${security.ticker} trade shares must be positive" }
            require(shares.amount.remainder(BigDecimal.ONE).signum() == 0) {
                "${security.ticker} is bought in whole shares, not $shares"
            }
            NormalizedTrade(security.securityId, security.ticker, shares, security.price * shares)
        }
    }

    val spentByClass = classNames.associateWith { zero }.toMutableMap()
    for (trade in normalized) {
        val weights = securitiesById.getValue(trade.securityId).weights
        val parts = trade.cost.allocateBy(classNames.map { (weights[it] ?: Fraction.ZERO).value })
        for ((className, part) in classNames.zip(parts)) {
            spentByClass[className] = spentByClass.getValue(className) + part
        }
    }
    val spent = normalized.fold(zero) { acc, t -> acc + t.cost }

    val rebalanceTotal = if (addedFunds.signum() > 0) {
        report.total + addedFunds
    } else {
        report.buckets
            .filter { it.className != cashClass }
            .mapNotNull { bucket ->
                targetFractions[bucket.className]
                    ?.takeIf { it.signum() > 0 && !bucket.value.isZero() }
                    ?.let { bucket.value / it }
            }
            .plus(report.total)
            .max()
    }

    val targetParts = rebalanceTotal.allocateBy(
        classNames.map { (targetFractions[it] ?: Fraction.ZERO).value }
    )

    val classes = report.buckets.zip(targetParts).map { (bucket, target) ->
        val classSpent = spentByClass.getValue(bucket.className)
        val after = bucket.value + classSpent
        val need = target - after
        val candidates = securities
            .filter { (it.weights[bucket.className] ?: Fraction.ZERO) >= CANDIDATE_CONCENTRATION }
            .sortedWith(
                compareByDescending<PlannerSecurity> { it.weights.getValue(bucket.className) }
                    .thenBy { it.ticker }
            )
            .mapNotNull { security ->
                val classWeight = security.weights.getValue(bucket.className)
                val perShareInClass = security.price * classWeight
                if (perShareInClass.isZero()) return@mapNotNull null
                val suggested = if (need.signum() <= 0) Quantity.ZERO else Quantity.of(
                    need.amount.divide(perShareInClass.amount, 0, RoundingMode.FLOOR)
                )
                CandidateFund(
                    securityId = security.securityId,
                    ticker = security.ticker,
                    classWeight = classWeight,
                    suggestedShares = suggested,
                    pricePerShare = security.price,
                    cost = security.price * suggested,
                )
            }
        RebalanceClassScore(
            className = bucket.className,
            before = bucket.value,
            beforeFraction = bucket.fraction,
            spent = classSpent,
            after = after,
            afterFraction = if (rebalanceTotal.isZero()) Fraction.ZERO else after / rebalanceTotal,
            target = target,
            targetFraction = targetFractions[bucket.className] ?: Fraction.ZERO,
            residual = after - target,
            atOrOverTarget = after >= target,
            candidates = candidates,
        )
    }

    return RebalancePlan(
        classes = classes,
        trades = normalized,
        currentTotal = report.total,
        rebalanceTotal = rebalanceTotal,
        addedFunds = addedFunds,
        spent = spent,
        remaining = availableSweeps + addedFunds - spent,
    )
}
