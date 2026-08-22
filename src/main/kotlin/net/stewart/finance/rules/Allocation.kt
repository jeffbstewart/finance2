package net.stewart.finance.rules

import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.SecurityId

// The allocation dashboard's arithmetic (FUNCTIONAL_SPEC sec. 5.4) as pure
// functions. All amounts must already be in the reporting currency - 
// FX conversion happens upstream (build-scope sec. 5); mixing currencies
// here throws CurrencyMismatchException via the Money type.
//
// Each position's value is distributed across classes with one
// Money.allocateBy over its weight map, so class buckets always sum
// back to the portfolio total penny-exactly. Weight maps are validated
// to sum to 1 (+/-0.0001) at write time; allocateBy's normalization
// makes any residue proportional rather than silently dropped.

/** A priced position plus its asset-class weight map, ready to allocate. */
data class ClassifiedPosition(
    val securityId: SecurityId,
    val ticker: String,
    val value: Money,
    /** Class name -> weight. Empty = unclassified (routed to [otherClass]). */
    val weights: Map<String, Fraction>,
) {
    init {
        require(weights.values.all { it.signum() >= 0 }) {
            "$ticker has a negative classification weight"
        }
    }
}

/** One position's (or the synthetic sweeps entry's) share of a class. */
data class ClassContribution(
    /** Null for the synthetic sweeps contribution. */
    val securityId: SecurityId?,
    val ticker: String,
    /** The fraction of the position allocated to this class. */
    val weight: Fraction,
    val amount: Money,
)

data class ClassBucket(
    val className: String,
    val value: Money,
    /** value / portfolio total; zero when the portfolio is empty. */
    val fraction: Fraction,
    val contributions: List<ClassContribution>,
)

data class AllocationReport(
    /** One bucket per class, in the caller's (seeded) class order. */
    val buckets: List<ClassBucket>,
    val total: Money,
    /** Securities with no weight map, routed wholly to the Other class. */
    val unclassified: List<SecurityId>,
)

const val SWEEPS_TICKER = "Sweeps"

/**
 * Distributes every position across [classes] by its weight map and
 * adds [sweeps] to [cashClass] as a synthetic position (spec sec. 5.4).
 * Unclassified positions land wholly in [otherClass] and are reported
 * so the UI can prompt for a weight map. Buckets sum to [sweeps] plus
 * the positions' values exactly.
 */
fun currentAllocation(
    classes: List<String>,
    positions: List<ClassifiedPosition>,
    sweeps: Money,
    cashClass: String = "Cash",
    otherClass: String = "Other",
): AllocationReport {
    require(classes.contains(cashClass)) { "class list is missing \"$cashClass\"" }
    require(classes.contains(otherClass)) { "class list is missing \"$otherClass\"" }
    require(classes.toSet().size == classes.size) { "duplicate class names in $classes" }

    val zero = Money.zero(sweeps.currency)
    val values = classes.associateWith { zero }.toMutableMap()
    val contributions = classes.associateWith { mutableListOf<ClassContribution>() }
    val unclassified = mutableListOf<SecurityId>()

    for (position in positions) {
        val weights = position.weights.ifEmpty {
            unclassified.add(position.securityId)
            mapOf(otherClass to Fraction.ONE)
        }
        weights.keys.firstOrNull { it !in values }?.let {
            throw IllegalArgumentException("${position.ticker} weights unknown class \"$it\"")
        }
        val parts = position.value.allocateBy(classes.map { (weights[it] ?: Fraction.ZERO).value })
        for ((className, part) in classes.zip(parts)) {
            if (part.isZero() && (weights[className] ?: Fraction.ZERO).isZero()) continue
            values[className] = values.getValue(className) + part
            contributions.getValue(className).add(
                ClassContribution(
                    securityId = position.securityId,
                    ticker = position.ticker,
                    weight = weights[className] ?: Fraction.ZERO,
                    amount = part,
                )
            )
        }
    }

    if (!sweeps.isZero()) {
        values[cashClass] = values.getValue(cashClass) + sweeps
        contributions.getValue(cashClass).add(
            ClassContribution(securityId = null, ticker = SWEEPS_TICKER, weight = Fraction.ONE, amount = sweeps)
        )
    }

    val total = values.values.fold(zero) { a, b -> a + b }
    val buckets = classes.map { className ->
        val value = values.getValue(className)
        ClassBucket(
            className = className,
            value = value,
            fraction = if (total.isZero()) Fraction.ZERO else value / total,
            contributions = contributions.getValue(className),
        )
    }
    return AllocationReport(buckets, total, unclassified)
}

/** One class's current-vs-target row (spec sec. 5.4). */
data class DriftEntry(
    val className: String,
    val current: Money,
    val currentFraction: Fraction,
    val target: Money,
    val targetFraction: Fraction,
    /** target - current, in reporting-currency dollars. */
    val delta: Money,
)

/**
 * Scores the report against [targetFractions] (class name -> fraction,
 * validated to sum to 1 +/-0.0001 at write time). Target dollar amounts
 * come from one Money.allocateBy over the portfolio total, so targets
 * sum to the total and deltas sum to zero - penny-exactly.
 */
fun drift(report: AllocationReport, targetFractions: Map<String, Fraction>): List<DriftEntry> {
    targetFractions.keys.firstOrNull { name -> report.buckets.none { it.className == name } }?.let {
        throw IllegalArgumentException("target names unknown class \"$it\"")
    }
    val fractions = report.buckets.map { targetFractions[it.className] ?: Fraction.ZERO }
    val targets = report.total.allocateBy(fractions.map { it.value })
    return report.buckets.zip(targets).map { (bucket, target) ->
        DriftEntry(
            className = bucket.className,
            current = bucket.value,
            currentFraction = bucket.fraction,
            target = target,
            targetFraction = targetFractions[bucket.className] ?: Fraction.ZERO,
            delta = target - bucket.value,
        )
    }
}
